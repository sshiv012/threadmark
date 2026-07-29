import type { Principal } from '@threadmark/core';
import { getMembership } from '@threadmark/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { verifyToken } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export const UNAUTHORIZED_BODY = {
  error: 'unauthorized',
  message: 'authentication required',
} as const;
export const FORBIDDEN_BODY = {
  error: 'forbidden',
  message: 'not authorized for this workspace',
} as const;

const workspaceIdParamSchema = z.object({ workspaceId: z.string().uuid() });

/**
 * Shared preHandler for every workspace-scoped route. Order, pinned (so
 * "both the token and the workspaceId are invalid" always resolves the same
 * way, never an unspecified race):
 *
 * 1. Authorization header + token verification (401) — checked FIRST,
 *    before any request-shape validation, so an unauthenticated caller
 *    never learns whether the rest of their request was otherwise
 *    well-formed. A token that verifies but carries a non-UUID `sub` is
 *    also treated as a 401 here — a validly-signed token should never carry
 *    a malformed subject, so this is an authentication-contract violation,
 *    not a "user not found" case.
 * 2. workspaceId path param UUID shape (400, via the shared ZodError
 *    handler in app.ts) — a malformed param is a bad request, not an
 *    authorization decision.
 * 3. Membership lookup + active-status check (403) — deliberately the SAME
 *    body whether the membership is missing entirely or merely pending, so
 *    a caller already holding a valid token can't use this route to probe
 *    whether they have ANY (even inactive) relationship to a workspace
 *    they don't have real access to.
 *
 * On success, attaches `request.principal` — built exclusively from the
 * workspaceId this handler already validated (never re-derived from
 * anywhere else). Route handlers still call `can()` themselves as the
 * finer-grained second gate.
 */
export function requireAuth(deps: AppDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send(UNAUTHORIZED_BODY);
      return;
    }

    const token = authHeader.slice('Bearer '.length);
    const verified = await verifyToken(token);
    if (!verified || !z.string().uuid().safeParse(verified.sub).success) {
      reply.status(401).send(UNAUTHORIZED_BODY);
      return;
    }

    const { workspaceId } = workspaceIdParamSchema.parse(request.params);

    const membership = await getMembership(deps.db, { workspaceId, userId: verified.sub });
    if (!membership || membership.status !== 'active') {
      reply.status(403).send(FORBIDDEN_BODY);
      return;
    }

    request.principal = {
      kind: 'human',
      subjectId: verified.sub,
      workspaceId,
      role: membership.role,
    };
  };
}
