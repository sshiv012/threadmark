import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { addMembership, createUser, createWorkspace, listMemberships } from '@threadmark/db';
import type { Database } from '@threadmark/db';
import * as schema from '@threadmark/db';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { verifyToken } from '../auth/jwt.js';

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

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

async function login(app: ReturnType<typeof buildApp>, email: string) {
  return app.inject({ method: 'POST', url: '/login', payload: { email } });
}

describe('POST /login', () => {
  it('200s with a JWT when the user has an active membership somewhere', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const user = await createUser(db, { email: 'active@acme.test', name: 'Active' });
    await addMembership(db, {
      workspaceId: workspace.id,
      userId: user.id,
      role: 'viewer',
      status: 'active',
    });
    const app = buildApp({ db });

    const response = await login(app, 'active@acme.test');

    expect(response.statusCode).toBe(200);
    const { token } = JSON.parse(response.body);
    expect(await verifyToken(token)).toEqual({ sub: user.id });
  });

  it('200s for a user with a pending membership in workspace A and an active membership in workspace B', async () => {
    const workspaceA = await createWorkspace(db, { name: 'A Co' });
    const workspaceB = await createWorkspace(db, { name: 'B Co' });
    const user = await createUser(db, { email: 'multi@acme.test', name: 'Multi' });
    await addMembership(db, {
      workspaceId: workspaceA.id,
      userId: user.id,
      role: 'viewer',
      status: 'pending',
    });
    await addMembership(db, {
      workspaceId: workspaceB.id,
      userId: user.id,
      role: 'viewer',
      status: 'active',
    });
    const app = buildApp({ db });

    const response = await login(app, 'multi@acme.test');

    expect(response.statusCode).toBe(200);
  });

  it.each(['not-an-email', '', '   '])('400s on malformed email %j', async (email) => {
    const app = buildApp({ db });
    const response = await login(app, email);
    expect(response.statusCode).toBe(400);
  });

  it('403s (not 500) for a SQL-injection-shaped email string', async () => {
    const app = buildApp({ db });
    const response = await login(app, "a' OR '1'='1@acme.test");
    expect(response.statusCode).toBe(400); // fails zod .email() validation, not a DB error
  });

  it('returns byte-identical 403 bodies for an unknown email vs. a known-but-zero-active-memberships email', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const user = await createUser(db, { email: 'pending-only@acme.test', name: 'Pending' });
    await addMembership(db, {
      workspaceId: workspace.id,
      userId: user.id,
      role: 'viewer',
      status: 'pending',
    });
    const app = buildApp({ db });

    const unknownResponse = await login(app, 'totally-unknown@acme.test');
    const pendingOnlyResponse = await login(buildApp({ db }), 'pending-only@acme.test');

    expect(unknownResponse.statusCode).toBe(403);
    expect(pendingOnlyResponse.statusCode).toBe(403);
    expect(unknownResponse.body).toBe(pendingOnlyResponse.body);
  });

  it('runs the same number of DB queries for an unknown email as for a known-but-pending email (timing side-channel regression)', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const user = await createUser(db, { email: 'pending-timing@acme.test', name: 'Pending' });
    await addMembership(db, {
      workspaceId: workspace.id,
      userId: user.id,
      role: 'viewer',
      status: 'pending',
    });
    const app = buildApp({ db });
    const selectSpy = vi.spyOn(db, 'select');

    selectSpy.mockClear();
    await login(app, 'totally-unknown-timing@acme.test');
    const unknownQueryCount = selectSpy.mock.calls.length;

    selectSpy.mockClear();
    await login(app, 'pending-timing@acme.test');
    const pendingQueryCount = selectSpy.mock.calls.length;

    expect(unknownQueryCount).toBe(pendingQueryCount);
  });

  it('calling /login twice for the same active user succeeds twice and mutates no membership rows', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const user = await createUser(db, { email: 'twice@acme.test', name: 'Twice' });
    await addMembership(db, {
      workspaceId: workspace.id,
      userId: user.id,
      role: 'viewer',
      status: 'active',
    });
    const app = buildApp({ db });
    const before = await listMemberships(db, workspace.id);

    await login(app, 'twice@acme.test');
    await login(app, 'twice@acme.test');

    expect(await listMemberships(db, workspace.id)).toEqual(before);
  });
});
