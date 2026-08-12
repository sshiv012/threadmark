import { can } from '@threadmark/core';
import { upsertConflictPolicy } from '@threadmark/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { FORBIDDEN_BODY, requireAuth } from '../auth/require-auth.js';

// Mirrors packages/db/src/schema.ts's evidenceSourceType enum values exactly
// (hardcoded here, same convention as this route's own strategy enum and as
// grants.ts's role enum — no shared-constant import across the API/db
// boundary today).
const EVIDENCE_SOURCE_TYPES = [
  'interview',
  'support_ticket',
  'product_doc',
  'prior_prd',
  'github_issue',
  'analytics',
  'tech_constraint',
  'other',
] as const;

// Arbitrary but defensible bound on a jsonb payload nobody has a legitimate
// reason to make large — prevents unbounded config bloat, not a precisely
// tuned limit.
const MAX_CONFIG_JSON_BYTES = 10_000;

function isValidSourceTypePriority(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => (EVIDENCE_SOURCE_TYPES as readonly string[]).includes(v))
  );
}

// Strict validation at this trust boundary: a `highest_priority_source`
// update without a valid, non-empty `sourceTypePriority` is rejected here
// (400) rather than silently accepted and only degrading gracefully later
// at prompt-render time (packages/agent/src/policy.ts's
// renderPolicyInstruction still handles a malformed value defensively too,
// since it has no guarantee every future caller validates first — but the
// PATCH route is where a human-facing error belongs).
const bodySchema = z
  .object({
    strategy: z.enum(['most_recent', 'highest_priority_source', 'flag_for_review']),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (body) => Buffer.byteLength(JSON.stringify(body.config ?? {}), 'utf8') <= MAX_CONFIG_JSON_BYTES,
    {
      message: 'config payload is too large',
      path: ['config'],
    },
  )
  .refine(
    (body) =>
      body.strategy !== 'highest_priority_source' ||
      isValidSourceTypePriority(
        (body.config as { sourceTypePriority?: unknown } | undefined)?.sourceTypePriority,
      ),
    {
      message:
        'highest_priority_source requires config.sourceTypePriority: a non-empty array of valid evidence source types',
      path: ['config', 'sourceTypePriority'],
    },
  );

/**
 * Owner-gated (same `workspace:manage_members` action as grants.ts — no new
 * RBAC surface for this PR): sets the workspace's conflict-resolution
 * policy, read fresh by `runAgentQuery` on every call (no cache), so this
 * PATCH takes effect on the very next agent query with no restart.
 */
export function registerConflictPolicyRoute(app: FastifyInstance, deps: AppDeps): void {
  app.patch(
    '/workspaces/:workspaceId/conflict-policy',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const body = bodySchema.parse(request.body);

      // `request.principal.workspaceId` is used here, not the path param
      // directly, even though requireAuth already guarantees they're equal —
      // single source of truth for "this request's workspace" (see grants.ts).
      const principal = request.principal!;
      const workspaceId = principal.workspaceId;
      if (!can(principal, 'workspace:manage_members', { type: 'workspace', workspaceId })) {
        reply.status(403).send(FORBIDDEN_BODY);
        return;
      }

      const policy = await upsertConflictPolicy(deps.db, workspaceId, {
        strategy: body.strategy,
        ...(body.config !== undefined ? { config: body.config } : {}),
      });

      reply.status(200).send({ strategy: policy.strategy, config: policy.config });
    },
  );
}
