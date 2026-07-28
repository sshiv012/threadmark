import type { Database } from '@threadmark/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerAccessRequestsRoute } from './routes/access-requests.js';
import { registerLoginRoute } from './routes/login.js';

export interface AppDeps {
  db: Database;
}

/**
 * Fastify app factory — takes injected deps so tests can use `app.inject()`
 * against a pglite-backed `db`, never a real listening port. `index.ts` is
 * the only place that builds a real (postgres.js-backed) `AppDeps` and calls
 * `app.listen(...)`.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  // Single shared error handler: known error shapes map to a clean 4xx: every
  // other error is logged server-side and returned as a generic 500 with NO
  // stack trace or internal message in the body, independent of NODE_ENV —
  // this must not depend on Fastify's own dev/prod-conditional default.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({ error: 'bad_request', message: 'Invalid request' });
      return;
    }
    request.log.error(error);
    reply.status(500).send({ error: 'internal_error' });
  });

  registerAccessRequestsRoute(app, deps);
  registerLoginRoute(app, deps);

  return app;
}
