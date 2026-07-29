import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { addMembership, createUser, createWorkspace } from '@threadmark/db';
import type { Database } from '@threadmark/db';
import * as schema from '@threadmark/db';
import type { Retriever } from '@threadmark/retrieval';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { AppDeps } from '../app.js';
import { signToken } from './jwt.js';
import { FORBIDDEN_BODY, requireAuth, UNAUTHORIZED_BODY } from './require-auth.js';

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

const stubRetriever: Retriever = {
  search: async (query) => ({ query, results: [], cached: false, latencyMs: 0 }),
};

let db: Database;
let pglite: PGlite;

/** Throwaway probe route, isolated from any real route's business logic —
 * exercises requireAuth() alone. */
function buildProbeApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({ error: 'bad_request', message: 'Invalid request' });
      return;
    }
    reply.status(500).send({ error: 'internal_error' });
  });
  app.get(
    '/workspaces/:workspaceId/_probe',
    { preHandler: requireAuth(deps) },
    async (request, reply) => {
      reply.status(200).send({ principal: request.principal });
    },
  );
  return app;
}

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-value';
  process.env.JWT_EXPIRES_IN = '15m';
  pglite = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pglite, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb as unknown as Database;
});

afterEach(async () => {
  await pglite.close();
});

async function probe(app: FastifyInstance, workspaceId: string, authHeader?: string) {
  return app.inject({
    method: 'GET',
    url: `/workspaces/${workspaceId}/_probe`,
    ...(authHeader !== undefined ? { headers: { authorization: authHeader } } : {}),
  });
}

describe('requireAuth', () => {
  it('attaches an exact {kind:"human", subjectId, workspaceId, role} Principal for a valid token + active membership', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const user = await createUser(db, { email: 'editor@acme.test', name: 'Ed' });
    await addMembership(db, {
      workspaceId: workspace.id,
      userId: user.id,
      role: 'editor',
      status: 'active',
    });
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const token = await signToken(user.id);

    const response = await probe(app, workspace.id, `Bearer ${token}`);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      principal: { kind: 'human', subjectId: user.id, workspaceId: workspace.id, role: 'editor' },
    });
  });

  it('401s when Authorization header is missing', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const response = await probe(app, workspace.id);
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual(UNAUTHORIZED_BODY);
  });

  it('401s when Authorization has no "Bearer " prefix', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const user = await createUser(db, { email: 'a@acme.test', name: 'A' });
    const token = await signToken(user.id);
    const response = await probe(app, workspace.id, token); // raw token, no "Bearer "
    expect(response.statusCode).toBe(401);
  });

  it('401s for a garbage non-JWT bearer token', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const response = await probe(app, workspace.id, 'Bearer not-a-jwt-at-all');
    expect(response.statusCode).toBe(401);
  });

  it('401s for a well-formed but expired JWT', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const user = await createUser(db, { email: 'a@acme.test', name: 'A' });
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode('test-secret-value'));
    const response = await probe(app, workspace.id, `Bearer ${expired}`);
    expect(response.statusCode).toBe(401);
  });

  it('401s for a JWT signed with the wrong secret', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const user = await createUser(db, { email: 'a@acme.test', name: 'A' });
    const wrongSecretToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('a-completely-different-secret'));
    const response = await probe(app, workspace.id, `Bearer ${wrongSecretToken}`);
    expect(response.statusCode).toBe(401);
  });

  it('401s for a JWT signed with an unexpected algorithm', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const user = await createUser(db, { email: 'a@acme.test', name: 'A' });
    const hs384Token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS384' })
      .setSubject(user.id)
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('test-secret-value'));
    const response = await probe(app, workspace.id, `Bearer ${hs384Token}`);
    expect(response.statusCode).toBe(401);
  });

  it('400s when workspaceId path param is not a valid UUID, given an otherwise-valid token', async () => {
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const user = await createUser(db, { email: 'a@acme.test', name: 'A' });
    const token = await signToken(user.id);
    const response = await probe(app, 'not-a-uuid', `Bearer ${token}`);
    expect(response.statusCode).toBe(400);
  });

  it('403s for a syntactically valid but non-existent workspaceId UUID', async () => {
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const user = await createUser(db, { email: 'a@acme.test', name: 'A' });
    const token = await signToken(user.id);
    const response = await probe(app, '00000000-0000-0000-0000-000000000000', `Bearer ${token}`);
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual(FORBIDDEN_BODY);
  });

  it('a pending (non-active) membership resolves to the SAME 403 body as no membership at all', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const user = await createUser(db, { email: 'pending@acme.test', name: 'Pending' });
    await addMembership(db, {
      workspaceId: workspace.id,
      userId: user.id,
      role: 'viewer',
      status: 'pending',
    });
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const token = await signToken(user.id);

    const pendingResponse = await probe(app, workspace.id, `Bearer ${token}`);
    const noMembershipUser = await createUser(db, { email: 'none@acme.test', name: 'None' });
    const noMembershipToken = await signToken(noMembershipUser.id);
    const noMembershipResponse = await probe(app, workspace.id, `Bearer ${noMembershipToken}`);

    expect(pendingResponse.statusCode).toBe(403);
    expect(noMembershipResponse.statusCode).toBe(403);
    expect(JSON.parse(pendingResponse.body)).toEqual(JSON.parse(noMembershipResponse.body));
  });

  it('401s for a validly-signed token whose sub is not a UUID at all (authentication-contract violation, not a lookup miss)', async () => {
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const malformedSubToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('not-a-uuid-subject')
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('test-secret-value'));
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const response = await probe(app, workspace.id, `Bearer ${malformedSubToken}`);
    expect(response.statusCode).toBe(401);
  });

  it('403s (same as no-membership) for a valid token whose sub is a well-formed UUID referring to no real user', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const deletedUserToken = await signToken('00000000-0000-0000-0000-000000000000');
    const response = await probe(app, workspace.id, `Bearer ${deletedUserToken}`);
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual(FORBIDDEN_BODY);
  });

  it('resolves to a single clean 401 (not a 400 or 500) when the header is missing AND the workspaceId is invalid AND — pinning precedence: auth is checked before request-shape validation', async () => {
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const response = await probe(app, 'not-a-uuid'); // no Authorization header at all
    expect(response.statusCode).toBe(401);
  });

  it('never throws for a garbage token + non-UUID workspaceId combined — resolves to one clean 401', async () => {
    const app = buildProbeApp({ db, retriever: stubRetriever });
    const response = await probe(app, 'not-a-uuid', 'Bearer garbage-token');
    expect(response.statusCode).toBe(401);
  });

  it('an unexpected thrown error (db.select throws) is caught by the shared error handler → 500 with no leaked detail', async () => {
    const brokenDb = {
      select: () => {
        throw new Error('internal secret detail');
      },
    } as unknown as Database;
    const app = buildProbeApp({ db: brokenDb, retriever: stubRetriever });
    const user = await createUser(db, { email: 'a@acme.test', name: 'A' });
    const token = await signToken(user.id);
    const response = await probe(app, '00000000-0000-0000-0000-000000000000', `Bearer ${token}`);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('internal secret detail');
    expect(JSON.parse(response.body)).toEqual({ error: 'internal_error' });
  });
});
