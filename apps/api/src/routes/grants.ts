import { can } from '@threadmark/core';
import { activateMembership, getMembership, getUserByEmail, listMemberships } from '@threadmark/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { FORBIDDEN_BODY, requireAuth } from '../auth/require-auth.js';

const bodySchema = z.object({
  email: z.string().min(1).max(320).email(),
  role: z.enum(['owner', 'editor', 'commenter', 'viewer']).optional(),
});

/**
 * Owner-gated grant step: activates a target's PRIOR access-request in this
 * workspace. Never creates a membership row — 404s if the target has none.
 * `role` omitted keeps the seeded 'viewer'; given, it overwrites it.
 *
 * Guards against demoting the workspace's last active owner (self-grant or
 * otherwise) — leaving zero active owners would permanently lock everyone
 * out of workspace:manage_members, since only an active owner can grant.
 */
export function registerGrantsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post(
    '/workspaces/:workspaceId/grants',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      const body = bodySchema.parse(request.body);

      // `request.principal.workspaceId` is used throughout, not the path
      // param directly, even though requireAuth already guarantees they're
      // equal — single source of truth for "this request's workspace" so a
      // future edit to requireAuth can't silently desync the two.
      const principal = request.principal!;
      const workspaceId = principal.workspaceId;
      if (!can(principal, 'workspace:manage_members', { type: 'workspace', workspaceId })) {
        reply.status(403).send(FORBIDDEN_BODY);
        return;
      }

      const targetUser = await getUserByEmail(deps.db, body.email);
      if (!targetUser) {
        reply
          .status(404)
          .send({ error: 'not_found', message: 'no prior access request for this email' });
        return;
      }

      const targetMembership = await getMembership(deps.db, {
        workspaceId,
        userId: targetUser.id,
      });
      if (!targetMembership) {
        reply
          .status(404)
          .send({ error: 'not_found', message: 'no prior access request for this email' });
        return;
      }

      const demotingAnOwner =
        targetMembership.status === 'active' &&
        targetMembership.role === 'owner' &&
        body.role !== undefined &&
        body.role !== 'owner';
      if (demotingAnOwner) {
        const members = await listMemberships(deps.db, workspaceId);
        const otherActiveOwners = members.filter(
          (m) => m.userId !== targetUser.id && m.role === 'owner' && m.status === 'active',
        );
        if (otherActiveOwners.length === 0) {
          reply
            .status(409)
            .send({ error: 'conflict', message: 'cannot remove the last active owner' });
          return;
        }
      }

      const activated = await activateMembership(deps.db, {
        workspaceId,
        userId: targetUser.id,
        ...(body.role !== undefined ? { role: body.role } : {}),
      });

      reply
        .status(200)
        .send({ membershipId: activated!.id, status: activated!.status, role: activated!.role });
    },
  );
}
