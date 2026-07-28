import { getUserByEmail, hasAnyActiveMembership } from '@threadmark/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { signToken } from '../auth/jwt.js';

const bodySchema = z.object({
  email: z.string().min(1).max(320).email(),
});

const FORBIDDEN_BODY = { error: 'forbidden', message: 'no active membership' } as const;

// Never a real id (all-zero UUID) — used so an unknown email still runs the
// exact same second query an existing user would, closing the query-count
// timing side-channel between "unknown email" (previously 1 query) and
// "known email" (previously 2 queries). This isn't a formal constant-time
// guarantee (Postgres's own query cost can still vary with data
// distribution/index hits), but it removes the structural difference in how
// many queries run per branch.
const NO_SUCH_USER_SENTINEL = '00000000-0000-0000-0000-000000000000';

/**
 * Email-only login (no password) — issues a JWT only if the user has an
 * active membership somewhere. Deliberately returns the SAME 403 body for an
 * unknown email and a known-but-zero-active-memberships email: this route is
 * the one place enumeration hygiene matters, since a differing response
 * would let a caller probe which emails exist in the system.
 */
export function registerLoginRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/login', async (request, reply) => {
    const body = bodySchema.parse(request.body);

    const user = await getUserByEmail(deps.db, body.email);
    const hasActiveMembership = await hasAnyActiveMembership(
      deps.db,
      user?.id ?? NO_SUCH_USER_SENTINEL,
    );
    if (!user || !hasActiveMembership) {
      reply.status(403).send(FORBIDDEN_BODY);
      return;
    }

    const token = await signToken(user.id);
    reply.status(200).send({ token });
  });
}
