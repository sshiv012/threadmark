import {
  findOrCreatePendingMembership,
  findOrCreateUserByEmail,
  getWorkspace,
} from '@threadmark/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';

const bodySchema = z.object({
  email: z.string().min(1).max(320).email(),
  name: z.string().min(1).max(200),
  workspaceId: z.string().uuid(),
});

/**
 * Public, unauthenticated entry point for the access-request flow — this IS
 * the no-account onboarding step, so it deliberately requires no identity.
 * Checks workspace existence FIRST, before creating any user row, so a 404
 * never leaves a dangling user with no membership.
 */
export function registerAccessRequestsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/access-requests', async (request, reply) => {
    const body = bodySchema.parse(request.body);

    const workspace = await getWorkspace(deps.db, body.workspaceId);
    if (!workspace) {
      reply.status(404).send({ error: 'not_found', message: 'workspace does not exist' });
      return;
    }

    const user = await findOrCreateUserByEmail(deps.db, { email: body.email, name: body.name });
    const membership = await findOrCreatePendingMembership(deps.db, {
      workspaceId: workspace.id,
      userId: user.id,
    });

    reply.status(200).send({ membershipId: membership.id, status: membership.status });
  });
}
