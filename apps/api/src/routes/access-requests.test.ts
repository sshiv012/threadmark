import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { createWorkspace, getUserByEmail, listMemberships } from '@threadmark/db';
import type { Database } from '@threadmark/db';
import * as schema from '@threadmark/db';
import type { Retriever } from '@threadmark/retrieval';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

// None of these tests exercise the retriever.
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

async function post(app: ReturnType<typeof buildApp>, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/access-requests', payload });
}

describe('POST /access-requests', () => {
  it('creates a new user + pending viewer membership, readable via listMemberships', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildApp({ db, retriever: stubRetriever });

    const response = await post(app, {
      email: 'new@acme.test',
      name: 'Newt',
      workspaceId: workspace.id,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('pending');
    const members = await listMemberships(db, workspace.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ role: 'viewer', status: 'pending' });
    expect((await getUserByEmail(db, 'new@acme.test'))?.name).toBe('Newt');
  });

  it('reuses an existing user by email without changing their existing name', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildApp({ db, retriever: stubRetriever });
    await post(app, { email: 'pm@acme.test', name: 'Original', workspaceId: workspace.id });

    await post(app, {
      email: 'pm@acme.test',
      name: 'Attempted Overwrite',
      workspaceId: workspace.id,
    });

    expect((await getUserByEmail(db, 'pm@acme.test'))?.name).toBe('Original');
  });

  it.each([
    [{ name: 'A', workspaceId: '00000000-0000-0000-0000-000000000000' }],
    [{ email: 'a@b.test', workspaceId: '00000000-0000-0000-0000-000000000000' }],
    [{ email: 'a@b.test', name: 'A' }],
  ])('400s on a missing required field: %j', async (payload) => {
    const app = buildApp({ db, retriever: stubRetriever });
    const response = await post(app, payload);
    expect(response.statusCode).toBe(400);
  });

  it.each(['not-an-email', '', '   ', 'no-at-sign.test'])(
    '400s on malformed email %j',
    async (email) => {
      const app = buildApp({ db, retriever: stubRetriever });
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const response = await post(app, { email, name: 'A', workspaceId: workspace.id });
      expect(response.statusCode).toBe(400);
    },
  );

  it('safely stores SQL-injection-shaped email/name as literal text without erroring', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildApp({ db, retriever: stubRetriever });
    const name = "Robert'); DROP TABLE users;--";
    const response = await post(app, {
      email: 'injection@acme.test',
      name,
      workspaceId: workspace.id,
    });
    expect(response.statusCode).toBe(200);
    expect((await getUserByEmail(db, 'injection@acme.test'))?.name).toBe(name);
  });

  it('is idempotent: POSTing the same email+workspaceId twice yields exactly one membership row', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildApp({ db, retriever: stubRetriever });
    await post(app, { email: 'dup@acme.test', name: 'A', workspaceId: workspace.id });
    await post(app, { email: 'dup@acme.test', name: 'A', workspaceId: workspace.id });
    expect(await listMemberships(db, workspace.id)).toHaveLength(1);
  });

  it('404s for a non-existent workspaceId and creates NEITHER a user NOR a membership', async () => {
    const app = buildApp({ db, retriever: stubRetriever });
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const response = await post(app, {
      email: 'ghost@acme.test',
      name: 'Ghost',
      workspaceId: fakeId,
    });
    expect(response.statusCode).toBe(404);
    expect(await getUserByEmail(db, 'ghost@acme.test')).toBeUndefined();
  });

  it('two different users requesting the same workspace produce two independent membership rows', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildApp({ db, retriever: stubRetriever });
    await post(app, { email: 'a@acme.test', name: 'A', workspaceId: workspace.id });
    await post(app, { email: 'b@acme.test', name: 'B', workspaceId: workspace.id });
    expect(await listMemberships(db, workspace.id)).toHaveLength(2);
  });

  it('re-requesting access after the membership has since become active does not revert it to pending', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildApp({ db, retriever: stubRetriever });
    await post(app, { email: 'active@acme.test', name: 'A', workspaceId: workspace.id });
    const user = await getUserByEmail(db, 'active@acme.test');
    await db
      .update(schema.memberships)
      .set({ status: 'active', role: 'owner' })
      .where(eq(schema.memberships.userId, user!.id));

    await post(app, { email: 'active@acme.test', name: 'A', workspaceId: workspace.id });

    const [membership] = await listMemberships(db, workspace.id);
    expect(membership).toMatchObject({ status: 'active', role: 'owner' });
  });

  it('the success response body reveals no other member email/id and no other workspace existence', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const existingUser1 = 'secret-member-1@acme.test';
    const existingUser2 = 'secret-member-2@acme.test';
    await post(buildApp({ db, retriever: stubRetriever }), {
      email: existingUser1,
      name: 'One',
      workspaceId: workspace.id,
    });
    await post(buildApp({ db, retriever: stubRetriever }), {
      email: existingUser2,
      name: 'Two',
      workspaceId: workspace.id,
    });

    const response = await post(buildApp({ db, retriever: stubRetriever }), {
      email: 'third@acme.test',
      name: 'Three',
      workspaceId: workspace.id,
    });

    expect(response.body).not.toContain(existingUser1);
    expect(response.body).not.toContain(existingUser2);
  });

  it('does not affect membership rows in an unrelated existing workspace', async () => {
    const workspaceA = await createWorkspace(db, { name: 'A Co' });
    const workspaceB = await createWorkspace(db, { name: 'B Co' });
    const app = buildApp({ db, retriever: stubRetriever });
    await post(app, { email: 'b-member@b.test', name: 'B Member', workspaceId: workspaceB.id });
    const before = await listMemberships(db, workspaceB.id);

    await post(app, {
      email: 'a-requester@a.test',
      name: 'A Requester',
      workspaceId: workspaceA.id,
    });

    const after = await listMemberships(db, workspaceB.id);
    expect(after).toEqual(before);
  });
});
