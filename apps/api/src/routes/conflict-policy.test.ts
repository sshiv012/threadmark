import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { addMembership, createUser, createWorkspace, getConflictPolicy } from '@threadmark/db';
import type { Database, MembershipRole } from '@threadmark/db';
import * as schema from '@threadmark/db';
import type { Retriever } from '@threadmark/retrieval';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { signToken } from '../auth/jwt.js';

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

const stubRetriever: Retriever = {
  search: async (query) => ({ query, results: [], cached: false, latencyMs: 0 }),
};

let db: Database;
let pglite: PGlite;

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-value';
  pglite = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pglite, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb as unknown as Database;
});

afterEach(async () => {
  await pglite.close();
});

async function patchPolicy(workspaceId: string, token: string, body: Record<string, unknown>) {
  const app = buildApp({ db, retriever: stubRetriever });
  return app.inject({
    method: 'PATCH',
    url: `/workspaces/${workspaceId}/conflict-policy`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

async function seedOwner(workspaceId: string, email = 'owner@acme.test') {
  const owner = await createUser(db, { email, name: 'Owner' });
  await addMembership(db, { workspaceId, userId: owner.id, role: 'owner', status: 'active' });
  return { owner, token: await signToken(owner.id) };
}

describe('PATCH /workspaces/:workspaceId/conflict-policy', () => {
  it.each(['most_recent', 'flag_for_review'] as const)(
    'an owner PATCHes strategy=%s (no config needed) — 200, persisted',
    async (strategy) => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const { token } = await seedOwner(workspace.id);

      const response = await patchPolicy(workspace.id, token, { strategy });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ strategy });
      expect(await getConflictPolicy(db, workspace.id)).toMatchObject({ strategy });
    },
  );

  it('an owner PATCHes highest_priority_source with a valid sourceTypePriority — 200, persisted', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);

    const response = await patchPolicy(workspace.id, token, {
      strategy: 'highest_priority_source',
      config: { sourceTypePriority: ['prior_prd', 'product_doc'] },
    });

    expect(response.statusCode).toBe(200);
    expect(await getConflictPolicy(db, workspace.id)).toEqual({
      strategy: 'highest_priority_source',
      config: { sourceTypePriority: ['prior_prd', 'product_doc'] },
    });
  });

  it('a re-PATCH updates the existing row, not a duplicate', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);

    await patchPolicy(workspace.id, token, { strategy: 'most_recent' });
    await patchPolicy(workspace.id, token, { strategy: 'flag_for_review' });

    expect(await getConflictPolicy(db, workspace.id)).toMatchObject({
      strategy: 'flag_for_review',
    });
  });

  it('400s for an unknown strategy string', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await patchPolicy(workspace.id, token, {
      strategy: 'always_believe_the_newest',
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('bad_request');
  });

  it('400s for a missing strategy field', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await patchPolicy(workspace.id, token, {});
    expect(response.statusCode).toBe(400);
  });

  it.each([[], 'oops', null])('400s when config is not a plain object (%j)', async (config) => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await patchPolicy(workspace.id, token, { strategy: 'most_recent', config });
    expect(response.statusCode).toBe(400);
  });

  it('400s for highest_priority_source with config missing sourceTypePriority', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await patchPolicy(workspace.id, token, {
      strategy: 'highest_priority_source',
      config: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('400s for highest_priority_source with an empty sourceTypePriority array', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await patchPolicy(workspace.id, token, {
      strategy: 'highest_priority_source',
      config: { sourceTypePriority: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('400s for highest_priority_source with a sourceTypePriority entry that is not a valid evidence source type', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await patchPolicy(workspace.id, token, {
      strategy: 'highest_priority_source',
      config: { sourceTypePriority: ['product_doc', 'bogus_type'] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('400s for an oversized config payload', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await patchPolicy(workspace.id, token, {
      strategy: 'flag_for_review',
      config: { blob: 'x'.repeat(20_000) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('400s for a multibyte config payload whose UTF-16 string length is under the bound but whose real UTF-8 byte size exceeds it', async () => {
    // Each '中' is 1 UTF-16 code unit (counted by .length) but 3 UTF-8 bytes
    // (counted by Buffer.byteLength) — 4000 of them is ~4000 chars, comfortably
    // under the 10_000-char mark a naive .length check would allow, but
    // ~12_000 real bytes, over the actual 10_000-byte bound.
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await patchPolicy(workspace.id, token, {
      strategy: 'flag_for_review',
      config: { blob: '中'.repeat(4000) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('401s when Authorization is absent', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildApp({ db, retriever: stubRetriever });
    const response = await app.inject({
      method: 'PATCH',
      url: `/workspaces/${workspace.id}/conflict-policy`,
      payload: { strategy: 'most_recent' },
    });
    expect(response.statusCode).toBe(401);
  });

  it.each<MembershipRole>(['editor', 'commenter', 'viewer'])(
    'a non-owner (%s) 403s via the same workspace:manage_members can() check as grants, and never writes a row',
    async (role) => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const caller = await createUser(db, { email: 'caller@acme.test', name: 'Caller' });
      await addMembership(db, {
        workspaceId: workspace.id,
        userId: caller.id,
        role,
        status: 'active',
      });
      const token = await signToken(caller.id);

      const response = await patchPolicy(workspace.id, token, { strategy: 'most_recent' });

      expect(response.statusCode).toBe(403);
      expect(await getConflictPolicy(db, workspace.id)).toEqual({
        strategy: 'flag_for_review',
        config: {},
      });
    },
  );

  it("a valid JWT for workspace A 403s on workspace B's path and never writes a row for B", async () => {
    const workspaceA = await createWorkspace(db, { name: 'A Co' });
    const workspaceB = await createWorkspace(db, { name: 'B Co' });
    const { token } = await seedOwner(workspaceA.id, 'owner-a@acme.test');

    const response = await patchPolicy(workspaceB.id, token, { strategy: 'most_recent' });

    expect(response.statusCode).toBe(403);
    expect(await getConflictPolicy(db, workspaceB.id)).toEqual({
      strategy: 'flag_for_review',
      config: {},
    });
  });

  it('a malformed body maps to 400 with the {error:"bad_request"} shape', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await patchPolicy(workspace.id, token, { strategy: 123 });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('bad_request');
  });
});
