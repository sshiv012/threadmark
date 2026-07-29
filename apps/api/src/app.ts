import type { Database } from '@threadmark/db';
import { RetrievalValidationError, type Retriever } from '@threadmark/retrieval';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerAccessRequestsRoute } from './routes/access-requests.js';
import { registerGrantsRoute } from './routes/grants.js';
import { registerLoginRoute } from './routes/login.js';
import { registerSearchRoute } from './routes/search.js';

export interface AppDeps {
  db: Database;
  retriever: Retriever;
}

/**
 * Fastify app factory — takes injected deps so tests can use `app.inject()`
 * against a pglite-backed `db` and an in-memory retriever stack, never a
 * real listening port/live infra. `index.ts` is the only place that builds a
 * real (postgres.js/OpenSearch/Redis-backed) `AppDeps` and calls
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
    if (error instanceof RetrievalValidationError) {
      reply.status(400).send({ error: 'bad_request', message: 'Invalid request' });
      return;
    }
    request.log.error(error);
    reply.status(500).send({ error: 'internal_error' });
  });

  registerAccessRequestsRoute(app, deps);
  registerLoginRoute(app, deps);
  registerGrantsRoute(app, deps);
  registerSearchRoute(app, deps);

  return app;
}
