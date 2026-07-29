import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import {
  addMembership,
  createUser,
  createWorkspace,
  findOrCreatePendingMembership,
  getMembership,
} from '@threadmark/db';
import type { Database, MembershipRole } from '@threadmark/db';
import * as schema from '@threadmark/db';
import type { Retriever } from '@threadmark/retrieval';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

async function grant(
  workspaceId: string,
  token: string,
  body: Record<string, unknown>,
  overrideDb: Database = db,
) {
  const app = buildApp({ db: overrideDb, retriever: stubRetriever });
  return app.inject({
    method: 'POST',
    url: `/workspaces/${workspaceId}/grants`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

async function seedOwner(workspaceId: string, email = 'owner@acme.test') {
  const owner = await createUser(db, { email, name: 'Owner' });
  await addMembership(db, { workspaceId, userId: owner.id, role: 'owner', status: 'active' });
  return { owner, token: await signToken(owner.id) };
}

describe('POST /workspaces/:workspaceId/grants', () => {
  it('activates an existing pending membership; role stays the seeded viewer when omitted', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const target = await createUser(db, { email: 'target@acme.test', name: 'Target' });
    await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: target.id });

    const response = await grant(workspace.id, token, { email: 'target@acme.test' });

    expect(response.statusCode).toBe(200);
    expect(await getMembership(db, { workspaceId: workspace.id, userId: target.id })).toMatchObject(
      {
        status: 'active',
        role: 'viewer',
      },
    );
  });

  it('an explicit role in the body overwrites the stored role', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const target = await createUser(db, { email: 'target@acme.test', name: 'Target' });
    await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: target.id });

    const response = await grant(workspace.id, token, {
      email: 'target@acme.test',
      role: 'editor',
    });

    expect(response.statusCode).toBe(200);
    expect(await getMembership(db, { workspaceId: workspace.id, userId: target.id })).toMatchObject(
      {
        role: 'editor',
      },
    );
  });

  it('the target email lookup is case-normalized — "Target@Acme.test" resolves the same account', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const target = await createUser(db, { email: 'target@acme.test', name: 'Target' });
    await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: target.id });

    const response = await grant(workspace.id, token, { email: 'Target@Acme.test' });

    expect(response.statusCode).toBe(200);
    expect(await getMembership(db, { workspaceId: workspace.id, userId: target.id })).toMatchObject(
      {
        status: 'active',
      },
    );
  });

  it('400s for a missing email field', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await grant(workspace.id, token, {});
    expect(response.statusCode).toBe(400);
  });

  it('400s for a malformed email', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await grant(workspace.id, token, { email: 'not-an-email' });
    expect(response.statusCode).toBe(400);
  });

  it('400s for an invalid role enum value', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await grant(workspace.id, token, { email: 'a@acme.test', role: 'superadmin' });
    expect(response.statusCode).toBe(400);
  });

  it('401s when Authorization is absent', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildApp({ db, retriever: stubRetriever });
    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspace.id}/grants`,
      payload: { email: 'a@acme.test' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('400s when workspaceId path param is not a valid UUID', async () => {
    const owner = await createUser(db, { email: 'owner@acme.test', name: 'Owner' });
    const token = await signToken(owner.id);
    const response = await grant('not-a-uuid', token, { email: 'a@acme.test' });
    expect(response.statusCode).toBe(400);
  });

  it('404s when the target email has no prior membership row in this workspace, and creates none', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    await createUser(db, { email: 'target@acme.test', name: 'Target' });

    const response = await grant(workspace.id, token, { email: 'target@acme.test' });

    expect(response.statusCode).toBe(404);
  });

  it('404s when the target email has no user account at all', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await grant(workspace.id, token, { email: 'ghost@acme.test' });
    expect(response.statusCode).toBe(404);
  });

  it('a valid JWT + active membership in workspace A 403s on /workspaces/:workspaceIdB/grants, and activateMembership never runs', async () => {
    const workspaceA = await createWorkspace(db, { name: 'A Co' });
    const workspaceB = await createWorkspace(db, { name: 'B Co' });
    const { token } = await seedOwner(workspaceA.id, 'owner-a@acme.test');
    const targetB = await createUser(db, { email: 'target-b@acme.test', name: 'Target B' });
    await findOrCreatePendingMembership(db, { workspaceId: workspaceB.id, userId: targetB.id });
    const updateSpy = vi.spyOn(db, 'update');

    const response = await grant(workspaceB.id, token, { email: 'target-b@acme.test' });

    expect(response.statusCode).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(
      await getMembership(db, { workspaceId: workspaceB.id, userId: targetB.id }),
    ).toMatchObject({
      status: 'pending',
    });
  });

  it("granting in workspace A does not touch the same user's pending row in workspace B", async () => {
    const workspaceA = await createWorkspace(db, { name: 'A Co' });
    const workspaceB = await createWorkspace(db, { name: 'B Co' });
    const { token } = await seedOwner(workspaceA.id);
    const target = await createUser(db, { email: 'target@acme.test', name: 'Target' });
    await findOrCreatePendingMembership(db, { workspaceId: workspaceA.id, userId: target.id });
    await findOrCreatePendingMembership(db, { workspaceId: workspaceB.id, userId: target.id });

    await grant(workspaceA.id, token, { email: 'target@acme.test' });

    expect(
      await getMembership(db, { workspaceId: workspaceB.id, userId: target.id }),
    ).toMatchObject({
      status: 'pending',
    });
  });

  it('403s (not 500) when the caller has no membership row in this workspace at all, before can()/activateMembership run', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const caller = await createUser(db, { email: 'stranger@acme.test', name: 'Stranger' });
    const token = await signToken(caller.id);
    const target = await createUser(db, { email: 'target@acme.test', name: 'Target' });
    await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: target.id });
    const updateSpy = vi.spyOn(db, 'update');

    const response = await grant(workspace.id, token, { email: 'target@acme.test' });

    expect(response.statusCode).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it.each<MembershipRole>(['editor', 'commenter', 'viewer'])(
    'an active-but-insufficient role (%s) 403s from the can() gate specifically, activateMembership never called',
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
      const target = await createUser(db, { email: 'target@acme.test', name: 'Target' });
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: target.id });
      const updateSpy = vi.spyOn(db, 'update');

      const response = await grant(workspace.id, token, { email: 'target@acme.test' });

      expect(response.statusCode).toBe(403);
      expect(updateSpy).not.toHaveBeenCalled();
    },
  );

  it('preHandler-403 (no membership) and can()-403 (active but insufficient role) return identical bodies', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const target = await createUser(db, { email: 'target@acme.test', name: 'Target' });
    await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: target.id });

    const stranger = await createUser(db, { email: 'stranger@acme.test', name: 'Stranger' });
    const noMembershipResponse = await grant(workspace.id, await signToken(stranger.id), {
      email: 'target@acme.test',
    });

    const viewer = await createUser(db, { email: 'viewer@acme.test', name: 'Viewer' });
    await addMembership(db, {
      workspaceId: workspace.id,
      userId: viewer.id,
      role: 'viewer',
      status: 'active',
    });
    const wrongRoleResponse = await grant(workspace.id, await signToken(viewer.id), {
      email: 'target@acme.test',
    });

    expect(noMembershipResponse.statusCode).toBe(403);
    expect(wrongRoleResponse.statusCode).toBe(403);
    expect(JSON.parse(noMembershipResponse.body)).toEqual(JSON.parse(wrongRoleResponse.body));
  });

  it('a malformed body maps to 400 with the {error:"bad_request"} shape', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const { token } = await seedOwner(workspace.id);
    const response = await grant(workspace.id, token, { email: 123 });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('bad_request');
  });

  it('an unexpected error during activation maps to a generic 500 with no leaked detail', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const owner = await createUser(db, { email: 'owner@acme.test', name: 'Owner' });
    await addMembership(db, {
      workspaceId: workspace.id,
      userId: owner.id,
      role: 'owner',
      status: 'active',
    });
    const token = await signToken(owner.id);
    const target = await createUser(db, { email: 'target@acme.test', name: 'Target' });
    await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: target.id });

    // Reuse the real db for auth/lookup, but break `transaction`
    // (activateMembership now runs entirely inside one, for the last-owner
    // row lock), so the failure happens exactly where expected.
    const brokenDb = Object.assign(Object.create(Object.getPrototypeOf(db)), db, {
      transaction: () => {
        throw new Error('super secret connection string leaked here');
      },
    }) as Database;

    const response = await grant(workspace.id, token, { email: 'target@acme.test' }, brokenDb);

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('super secret connection string');
    expect(JSON.parse(response.body)).toEqual({ error: 'internal_error' });
  });

  describe('last-owner protection', () => {
    it("409s when demoting the workspace's only active owner", async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const { token, owner } = await seedOwner(workspace.id);

      const response = await grant(workspace.id, token, {
        email: 'owner@acme.test',
        role: 'viewer',
      });

      expect(response.statusCode).toBe(409);
      expect(
        await getMembership(db, { workspaceId: workspace.id, userId: owner.id }),
      ).toMatchObject({
        role: 'owner',
        status: 'active',
      });
    });

    it('succeeds demoting one of two active owners — the other owner remains', async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const { token, owner: ownerA } = await seedOwner(workspace.id, 'owner-a@acme.test');
      const ownerB = await createUser(db, { email: 'owner-b@acme.test', name: 'Owner B' });
      await addMembership(db, {
        workspaceId: workspace.id,
        userId: ownerB.id,
        role: 'owner',
        status: 'active',
      });

      const response = await grant(workspace.id, token, {
        email: 'owner-b@acme.test',
        role: 'viewer',
      });

      expect(response.statusCode).toBe(200);
      expect(
        await getMembership(db, { workspaceId: workspace.id, userId: ownerA.id }),
      ).toMatchObject({
        role: 'owner',
      });
      expect(
        await getMembership(db, { workspaceId: workspace.id, userId: ownerB.id }),
      ).toMatchObject({
        role: 'viewer',
      });
    });

    it('allows re-granting the last owner\'s role as "owner" again (no-op, not a demotion)', async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const { token, owner } = await seedOwner(workspace.id);

      const response = await grant(workspace.id, token, {
        email: 'owner@acme.test',
        role: 'owner',
      });

      expect(response.statusCode).toBe(200);
      expect(
        await getMembership(db, { workspaceId: workspace.id, userId: owner.id }),
      ).toMatchObject({
        role: 'owner',
      });
    });
  });
});
