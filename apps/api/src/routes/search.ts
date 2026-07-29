import { can } from '@threadmark/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { FORBIDDEN_BODY, requireAuth } from '../auth/require-auth.js';

// Fastify's default querystring parser does not coerce to numbers (this repo
// uses zod, not Fastify's JSON-schema option) — `z.coerce.number()` handles
// that explicitly. It also closes a duplicate-param footgun for free:
// `?topK=5&topK=10` arrives as `['5','10']`, and `Number(['5','10'])` is
// `NaN`, which `.int().positive()` then rejects — no special-casing needed.
const querySchema = z.object({
  q: z.string().trim().min(1),
  topK: z.coerce.number().int().positive().optional(),
  candidateK: z.coerce.number().int().positive().optional(),
});

/**
 * Read-only hybrid search over a workspace's evidence corpus, gated by
 * `can()`. `topK > candidateK` and oversized values are rejected by the
 * retriever's own validation (`RetrievalValidationError` → 400 via the
 * shared error handler in app.ts) — not re-validated here, to avoid two
 * sources of truth for the same bound.
 */
export function registerSearchRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    '/workspaces/:workspaceId/search',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const query = querySchema.parse(request.query);

      // `request.principal.workspaceId` is used here, not the path param
      // directly, even though requireAuth already guarantees they're equal —
      // single source of truth for "this request's workspace" (see grants.ts).
      const principal = request.principal!;
      if (
        !can(principal, 'evidence_document:read', {
          type: 'evidence_document',
          workspaceId: principal.workspaceId,
        })
      ) {
        reply.status(403).send(FORBIDDEN_BODY);
        return;
      }

      const result = await deps.retriever.search(query.q, {
        workspaceId: principal.workspaceId,
        ...(query.topK !== undefined ? { topK: query.topK } : {}),
        ...(query.candidateK !== undefined ? { candidateK: query.candidateK } : {}),
      });

      reply.status(200).send(result);
    },
  );
}
