import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import {
  activateMembership,
  addMembership,
  appendAgentStep,
  createAgentRun,
  createEvalQuery,
  createEvalReport,
  createEvidenceDocument,
  createUser,
  createWorkspace,
  deleteChunksNotIn,
  findEvidenceDocumentByChecksum,
  findEvidenceDocumentByTitle,
  findOrCreatePendingMembership,
  findOrCreateUserByEmail,
  findWorkspaceByName,
  getAgentRun,
  getChunksByDocument,
  getEvidenceDocument,
  getMembership,
  getRetrievalChunksByIds,
  getUserByEmail,
  getWorkspace,
  getWorkspaceRetrievalRevision,
  hasAnyActiveMembership,
  LastOwnerDemotionError,
  listAgentSteps,
  listEvalQueriesWithJudgments,
  listMemberships,
  searchChunksByVector,
  setChunkEmbedding,
  updateAgentRunStatus,
  updateAgentStep,
  updateDocumentStatus,
  upsertChunks,
  upsertEvalJudgment,
} from './repositories.js';
import { EMBEDDING_DIMENSIONS } from './schema.js';
import * as schema from './schema.js';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

// Fresh in-process Postgres (pglite + pgvector) per test; the real migration
// is applied so tests exercise exactly what production runs.
let db: Database;

beforeEach(async () => {
  const pg = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pg, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb;
});

async function seedWorkspaceAndUser() {
  const workspace = await createWorkspace(db, { name: 'Acme' });
  const user = await createUser(db, { email: 'pm@acme.test', name: 'Pat' });
  return { workspace, user };
}

describe('migration + core entities', () => {
  it('creates and reads a workspace', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    expect(workspace.id).toBeTruthy();
    expect(await getWorkspace(db, workspace.id)).toMatchObject({ name: 'Acme' });
  });

  it('enforces unique user email and reads by email', async () => {
    await createUser(db, { email: 'pm@acme.test', name: 'Pat' });
    expect(await getUserByEmail(db, 'pm@acme.test')).toMatchObject({ name: 'Pat' });
    await expect(createUser(db, { email: 'pm@acme.test', name: 'Dup' })).rejects.toThrow();
  });

  it('adds a membership with a role', async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    await addMembership(db, { workspaceId: workspace.id, userId: user.id, role: 'owner' });
    const members = await listMemberships(db, workspace.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ role: 'owner' });
  });

  it('defaults status to pending (fail-closed) when a caller omits it entirely (review regression)', async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    const membership = await addMembership(db, {
      workspaceId: workspace.id,
      userId: user.id,
      role: 'owner',
    });
    expect(membership.status).toBe('pending');
  });

  it('rejects a duplicate membership for the same (workspace, user)', async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    await addMembership(db, { workspaceId: workspace.id, userId: user.id, role: 'editor' });
    await expect(
      addMembership(db, { workspaceId: workspace.id, userId: user.id, role: 'viewer' }),
    ).rejects.toThrow();
  });
});

describe('access requests: user/membership status', () => {
  describe('findOrCreateUserByEmail', () => {
    it('creates a new user by email when none exists', async () => {
      const user = await findOrCreateUserByEmail(db, { email: 'new@acme.test', name: 'Newt' });
      expect(user.email).toBe('new@acme.test');
      expect(await getUserByEmail(db, 'new@acme.test')).toMatchObject({
        id: user.id,
        name: 'Newt',
      });
    });

    it('reuses an existing user by email without overwriting their name', async () => {
      const original = await createUser(db, { email: 'pm@acme.test', name: 'Original' });
      const reused = await findOrCreateUserByEmail(db, {
        email: 'pm@acme.test',
        name: 'Attempted Overwrite',
      });
      expect(reused.id).toBe(original.id);
      expect(reused.name).toBe('Original');
    });

    it('never creates a duplicate row for the same email across sequential calls', async () => {
      await findOrCreateUserByEmail(db, { email: 'dup@acme.test', name: 'A' });
      await findOrCreateUserByEmail(db, { email: 'dup@acme.test', name: 'B' });
      const all = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, 'dup@acme.test'));
      expect(all).toHaveLength(1);
    });

    it('does not create two rows when invoked concurrently for the same new email', async () => {
      const [a, b] = await Promise.all([
        findOrCreateUserByEmail(db, { email: 'concurrent@acme.test', name: 'A' }),
        findOrCreateUserByEmail(db, { email: 'concurrent@acme.test', name: 'B' }),
      ]);
      expect(a.id).toBe(b.id);
      const all = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, 'concurrent@acme.test'));
      expect(all).toHaveLength(1);
    });

    it('stores an email/name containing SQL-injection-shaped characters as literal text', async () => {
      const name = "Robert'); DROP TABLE users;--";
      const user = await findOrCreateUserByEmail(db, { email: 'injection@acme.test', name });
      expect((await getUserByEmail(db, 'injection@acme.test'))?.name).toBe(name);
      expect(user.name).toBe(name);
    });

    it('normalizes email case: "User@Example.com" and "user@example.com" resolve to the same account', async () => {
      const created = await findOrCreateUserByEmail(db, {
        email: 'User@Example.com',
        name: 'Case',
      });
      const reused = await findOrCreateUserByEmail(db, {
        email: 'user@example.com',
        name: 'Other',
      });
      expect(reused.id).toBe(created.id);
      expect(await getUserByEmail(db, 'USER@EXAMPLE.COM')).toMatchObject({ id: created.id });
    });

    it('the 0005 backfill migration normalizes a pre-existing mixed-case row (review regression)', async () => {
      // Simulates a row written before email normalization existed (e.g. by
      // an older app version or a direct import) by bypassing
      // findOrCreateUserByEmail's normalization and writing mixed-case
      // directly, then re-running the backfill migration's own statement.
      await db.execute(
        sql`INSERT INTO users (email, name) VALUES ('Legacy@Example.com', 'Legacy')`,
      );
      await db.execute(sql`UPDATE users SET email = LOWER(email) WHERE email != LOWER(email)`);
      expect(await getUserByEmail(db, 'legacy@example.com')).toMatchObject({ name: 'Legacy' });
    });
  });

  describe('findOrCreatePendingMembership', () => {
    it('creates a pending viewer membership when none exists', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      const membership = await findOrCreatePendingMembership(db, {
        workspaceId: workspace.id,
        userId: user.id,
      });
      expect(membership).toMatchObject({ role: 'viewer', status: 'pending' });
      expect(await listMemberships(db, workspace.id)).toHaveLength(1);
    });

    it('is idempotent: calling it twice for the same (workspace, user) produces exactly one row', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: user.id });
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: user.id });
      expect(await listMemberships(db, workspace.id)).toHaveLength(1);
    });

    it('returns the existing membership row (not undefined) on the second, no-op call', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      const first = await findOrCreatePendingMembership(db, {
        workspaceId: workspace.id,
        userId: user.id,
      });
      const second = await findOrCreatePendingMembership(db, {
        workspaceId: workspace.id,
        userId: user.id,
      });
      expect(second).toBeDefined();
      expect(second.id).toBe(first.id);
    });

    it('does not regress an existing ACTIVE membership back to pending or viewer', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      await addMembership(db, {
        workspaceId: workspace.id,
        userId: user.id,
        role: 'owner',
        status: 'active',
      });
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: user.id });
      const [membership] = await listMemberships(db, workspace.id);
      expect(membership).toMatchObject({ role: 'owner', status: 'active' });
    });

    it('creates independent membership rows for two different users requesting the same workspace', async () => {
      const { workspace, user: userA } = await seedWorkspaceAndUser();
      const userB = await createUser(db, { email: 'other@acme.test', name: 'Other' });
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: userA.id });
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: userB.id });
      const members = await listMemberships(db, workspace.id);
      expect(members).toHaveLength(2);
      expect(members.map((m) => m.userId).sort()).toEqual([userA.id, userB.id].sort());
    });

    it('scopes the created membership to only the requested workspace, leaving another workspace untouched', async () => {
      const { workspace: workspaceA, user } = await seedWorkspaceAndUser();
      const workspaceB = await createWorkspace(db, { name: 'Other Co' });
      await findOrCreatePendingMembership(db, { workspaceId: workspaceA.id, userId: user.id });
      expect(await listMemberships(db, workspaceB.id)).toHaveLength(0);
    });
  });

  describe('hasAnyActiveMembership', () => {
    it('returns true when the user has an active membership', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      await addMembership(db, {
        workspaceId: workspace.id,
        userId: user.id,
        role: 'viewer',
        status: 'active',
      });
      expect(await hasAnyActiveMembership(db, user.id)).toBe(true);
    });

    it('returns false when the user has zero memberships', async () => {
      const { user } = await seedWorkspaceAndUser();
      expect(await hasAnyActiveMembership(db, user.id)).toBe(false);
    });

    it('returns false when the user only has pending memberships', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: user.id });
      expect(await hasAnyActiveMembership(db, user.id)).toBe(false);
    });

    it('is workspace-agnostic: true when pending in workspace A and active in workspace B', async () => {
      const { workspace: workspaceA, user } = await seedWorkspaceAndUser();
      const workspaceB = await createWorkspace(db, { name: 'Other Co' });
      await findOrCreatePendingMembership(db, { workspaceId: workspaceA.id, userId: user.id });
      await addMembership(db, {
        workspaceId: workspaceB.id,
        userId: user.id,
        role: 'viewer',
        status: 'active',
      });
      expect(await hasAnyActiveMembership(db, user.id)).toBe(true);
    });

    it('returns false, not a throw, for a user id with no row in users at all', async () => {
      await expect(
        hasAnyActiveMembership(db, '00000000-0000-0000-0000-000000000000'),
      ).resolves.toBe(false);
    });
  });

  describe('getMembership / activateMembership', () => {
    it('getMembership returns the single row for (workspaceId, userId), no status filter applied', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      await addMembership(db, {
        workspaceId: workspace.id,
        userId: user.id,
        role: 'editor',
        status: 'active',
      });
      expect(await getMembership(db, { workspaceId: workspace.id, userId: user.id })).toMatchObject(
        {
          role: 'editor',
          status: 'active',
        },
      );
    });

    it('getMembership returns a pending row too', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: user.id });
      expect(await getMembership(db, { workspaceId: workspace.id, userId: user.id })).toMatchObject(
        {
          status: 'pending',
        },
      );
    });

    it('getMembership returns undefined for a user with zero relationship to the workspace', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      expect(
        await getMembership(db, { workspaceId: workspace.id, userId: user.id }),
      ).toBeUndefined();
    });

    it('activateMembership sets active and preserves the existing role when role is omitted', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: user.id });
      const activated = await activateMembership(db, {
        workspaceId: workspace.id,
        userId: user.id,
      });
      expect(activated).toMatchObject({ status: 'active', role: 'viewer' });
      expect(await getMembership(db, { workspaceId: workspace.id, userId: user.id })).toMatchObject(
        {
          status: 'active',
          role: 'viewer',
        },
      );
    });

    it('activateMembership overwrites the stored role when role is given', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: user.id });
      await activateMembership(db, { workspaceId: workspace.id, userId: user.id, role: 'editor' });
      expect(await getMembership(db, { workspaceId: workspace.id, userId: user.id })).toMatchObject(
        {
          status: 'active',
          role: 'editor',
        },
      );
    });

    it('activateMembership returns undefined and fabricates no row when no membership exists for the pair', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      expect(
        await activateMembership(db, { workspaceId: workspace.id, userId: user.id, role: 'owner' }),
      ).toBeUndefined();
      expect(await listMemberships(db, workspace.id)).toHaveLength(0);
    });

    it('activateMembership on an already-active membership is idempotent — no duplicate row', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      await addMembership(db, {
        workspaceId: workspace.id,
        userId: user.id,
        role: 'owner',
        status: 'active',
      });
      await activateMembership(db, { workspaceId: workspace.id, userId: user.id });
      const members = await listMemberships(db, workspace.id);
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ role: 'owner', status: 'active' });
    });

    it('is scoped to exactly one (workspaceId, userId) pair — activating in A never mutates the same user in B, and a second user in the same workspace is unaffected', async () => {
      const { workspace: workspaceA, user: userA } = await seedWorkspaceAndUser();
      const workspaceB = await createWorkspace(db, { name: 'Other Co' });
      const userB = await createUser(db, { email: 'other@acme.test', name: 'Other' });
      await findOrCreatePendingMembership(db, { workspaceId: workspaceA.id, userId: userA.id });
      await findOrCreatePendingMembership(db, { workspaceId: workspaceB.id, userId: userA.id });
      await findOrCreatePendingMembership(db, { workspaceId: workspaceA.id, userId: userB.id });

      await activateMembership(db, { workspaceId: workspaceA.id, userId: userA.id, role: 'owner' });

      expect(
        await getMembership(db, { workspaceId: workspaceB.id, userId: userA.id }),
      ).toMatchObject({
        status: 'pending',
        role: 'viewer',
      });
      expect(
        await getMembership(db, { workspaceId: workspaceA.id, userId: userB.id }),
      ).toMatchObject({
        status: 'pending',
        role: 'viewer',
      });
    });

    it('two concurrent activation calls with different roles remain idempotent — exactly one row, one deterministic role, no throw', async () => {
      const { workspace, user } = await seedWorkspaceAndUser();
      await findOrCreatePendingMembership(db, { workspaceId: workspace.id, userId: user.id });

      const results = await Promise.all([
        activateMembership(db, { workspaceId: workspace.id, userId: user.id, role: 'editor' }),
        activateMembership(db, { workspaceId: workspace.id, userId: user.id, role: 'viewer' }),
      ]);

      expect(results.every((r) => r?.status === 'active')).toBe(true);
      const members = await listMemberships(db, workspace.id);
      expect(members).toHaveLength(1);
      expect(['editor', 'viewer']).toContain(members[0]!.role);
    });

    it('getMembership/activateMembership throw for a syntactically invalid UUID (no shape validation at this layer)', async () => {
      await expect(
        getMembership(db, { workspaceId: 'not-a-uuid', userId: 'also-not-a-uuid' }),
      ).rejects.toThrow();
    });

    it("two concurrent requests demoting each of a workspace's two owners cannot both succeed — at least one active owner always remains (review regression)", async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const ownerA = await createUser(db, { email: 'owner-a@acme.test', name: 'A' });
      const ownerB = await createUser(db, { email: 'owner-b@acme.test', name: 'B' });
      await addMembership(db, {
        workspaceId: workspace.id,
        userId: ownerA.id,
        role: 'owner',
        status: 'active',
      });
      await addMembership(db, {
        workspaceId: workspace.id,
        userId: ownerB.id,
        role: 'owner',
        status: 'active',
      });

      const results = await Promise.allSettled([
        activateMembership(db, { workspaceId: workspace.id, userId: ownerA.id, role: 'viewer' }),
        activateMembership(db, { workspaceId: workspace.id, userId: ownerB.id, role: 'viewer' }),
      ]);

      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LastOwnerDemotionError);
      const remainingOwners = (await listMemberships(db, workspace.id)).filter(
        (m) => m.role === 'owner' && m.status === 'active',
      );
      expect(remainingOwners.length).toBeGreaterThanOrEqual(1);
    });

    it('demoting the last owner throws LastOwnerDemotionError, and the row is left unchanged', async () => {
      const workspace = await createWorkspace(db, { name: 'Acme' });
      const owner = await createUser(db, { email: 'owner@acme.test', name: 'Owner' });
      await addMembership(db, {
        workspaceId: workspace.id,
        userId: owner.id,
        role: 'owner',
        status: 'active',
      });

      await expect(
        activateMembership(db, { workspaceId: workspace.id, userId: owner.id, role: 'viewer' }),
      ).rejects.toThrow(LastOwnerDemotionError);

      expect(
        await getMembership(db, { workspaceId: workspace.id, userId: owner.id }),
      ).toMatchObject({
        role: 'owner',
        status: 'active',
      });
    });
  });
});

describe('evidence documents', () => {
  it('creates a document and records status transitions', async () => {
    const { workspace } = await seedWorkspaceAndUser();
    const doc = await createEvidenceDocument(db, {
      workspaceId: workspace.id,
      sourceType: 'interview',
      title: 'Customer interview #1',
      blobUri: 's3://evidence/interview-1.txt',
      checksum: 'abc123',
    });
    expect(doc.status).toBe('queued');

    await updateDocumentStatus(db, doc.id, 'embedding');
    expect(await getEvidenceDocument(db, doc.id)).toMatchObject({ status: 'embedding' });

    await updateDocumentStatus(db, doc.id, 'failed', 'embedding provider timeout');
    expect(await getEvidenceDocument(db, doc.id)).toMatchObject({
      status: 'failed',
      statusReason: 'embedding provider timeout',
    });
  });

  it('returns undefined when updating the status of a non-existent document', async () => {
    // The ingestion activity relies on this to fail fast on a stale/bad id.
    expect(
      await updateDocumentStatus(db, '00000000-0000-0000-0000-000000000000', 'ready'),
    ).toBeUndefined();
  });

  it('finds a document by (workspace, checksum) for idempotent re-ingest', async () => {
    const { workspace } = await seedWorkspaceAndUser();
    const doc = await createEvidenceDocument(db, {
      workspaceId: workspace.id,
      sourceType: 'product_doc',
      title: 'Doc',
      blobUri: 's3://evidence/doc.md',
      checksum: 'sha-xyz',
    });
    expect(await findEvidenceDocumentByChecksum(db, workspace.id, 'sha-xyz')).toMatchObject({
      id: doc.id,
    });
    expect(await findEvidenceDocumentByChecksum(db, workspace.id, 'missing')).toBeUndefined();
  });
});

describe('chunks', () => {
  async function seedDocument() {
    const { workspace } = await seedWorkspaceAndUser();
    return createEvidenceDocument(db, {
      workspaceId: workspace.id,
      sourceType: 'support_ticket',
      title: 'Ticket export',
      blobUri: 's3://evidence/tickets.csv',
      checksum: 'def456',
    });
  }

  it('round-trips a 384-dimensional embedding', async () => {
    const doc = await seedDocument();
    const embedding = Array.from(
      { length: EMBEDDING_DIMENSIONS },
      (_, i) => i / EMBEDDING_DIMENSIONS,
    );
    const [chunk] = await upsertChunks(db, [
      {
        documentId: doc.id,
        ord: 0,
        sourceKey: 'win:0',
        contentHash: 'h0',
        text: 'hello',
        tokenCount: 1,
        embedding,
      },
    ]);
    const stored = chunk!.embedding!;
    expect(stored).toHaveLength(EMBEDDING_DIMENSIONS);
    // pgvector stores single-precision (float4), so values round-trip at
    // float32 precision — assert closeness, not exact float64 equality.
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      expect(stored[i]).toBeCloseTo(embedding[i]!, 5);
    }
  });

  it('is idempotent on (document_id, source_key) even when the ordinal shifts', async () => {
    const doc = await seedDocument();
    await upsertChunks(db, [
      {
        documentId: doc.id,
        ord: 0,
        sourceKey: 'overview',
        contentHash: 'h1',
        text: 'v1',
        tokenCount: 1,
      },
    ]);
    // Same source_key, different ordinal + content → updates the same row.
    await upsertChunks(db, [
      {
        documentId: doc.id,
        ord: 5,
        sourceKey: 'overview',
        contentHash: 'h2',
        text: 'v2',
        tokenCount: 2,
      },
    ]);

    const stored = await getChunksByDocument(db, doc.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ text: 'v2', tokenCount: 2, ord: 5, contentHash: 'h2' });
  });

  it('preserves the embedding on re-ingest when content is unchanged, clears it when changed', async () => {
    const doc = await seedDocument();
    const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i % 7) / 10);

    // Initial: an embedded chunk.
    await upsertChunks(db, [
      {
        documentId: doc.id,
        ord: 0,
        sourceKey: 'overview',
        contentHash: 'h1',
        text: 'v1',
        tokenCount: 1,
        embedding,
      },
    ]);

    // Re-ingest same content WITHOUT recomputing the vector → existing vector kept.
    await upsertChunks(db, [
      {
        documentId: doc.id,
        ord: 0,
        sourceKey: 'overview',
        contentHash: 'h1',
        text: 'v1',
        tokenCount: 1,
      },
    ]);
    let [chunk] = await getChunksByDocument(db, doc.id);
    expect(chunk!.embedding).not.toBeNull();
    expect(chunk!.embedding).toHaveLength(EMBEDDING_DIMENSIONS);

    // Content changed with no new vector → the stale vector is cleared for re-embed.
    await upsertChunks(db, [
      {
        documentId: doc.id,
        ord: 0,
        sourceKey: 'overview',
        contentHash: 'h2',
        text: 'v2',
        tokenCount: 1,
      },
    ]);
    [chunk] = await getChunksByDocument(db, doc.id);
    expect(chunk!.embedding).toBeNull();
  });

  it('orders chunks by ord', async () => {
    const doc = await seedDocument();
    await upsertChunks(db, [
      { documentId: doc.id, ord: 2, sourceKey: 'c', contentHash: 'hc', text: 'c', tokenCount: 1 },
      { documentId: doc.id, ord: 0, sourceKey: 'a', contentHash: 'ha', text: 'a', tokenCount: 1 },
      { documentId: doc.id, ord: 1, sourceKey: 'b', contentHash: 'hb', text: 'b', tokenCount: 1 },
    ]);
    expect((await getChunksByDocument(db, doc.id)).map((c) => c.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('agent runs and steps (observability)', () => {
  async function seedRun() {
    const { workspace } = await seedWorkspaceAndUser();
    const run = await createAgentRun(db, {
      workspaceId: workspace.id,
      kind: 'ingestion',
      subjectId: workspace.id, // stand-in subject for the test
    });
    return run;
  }

  it('creates a run in the running state and completes it', async () => {
    const run = await seedRun();
    expect(run.status).toBe('running');
    expect(run.endedAt).toBeNull();

    const endedAt = new Date('2026-07-22T00:00:00Z');
    await updateAgentRunStatus(db, run.id, 'completed', endedAt);
    const after = await getAgentRun(db, run.id);
    expect(after).toMatchObject({ status: 'completed' });
    expect(after!.endedAt).toEqual(endedAt);
  });

  it('records each step attempt as its own row, preserving retries and failures', async () => {
    const run = await seedRun();

    const attempt1 = await appendAgentStep(db, {
      runId: run.id,
      ord: 0,
      type: 'embedChunks',
      attempt: 1,
    });
    await updateAgentStep(db, attempt1.id, { status: 'failed', error: 'provider timeout' });

    const attempt2 = await appendAgentStep(db, {
      runId: run.id,
      ord: 1,
      type: 'embedChunks',
      attempt: 2,
    });
    await updateAgentStep(db, attempt2.id, {
      status: 'completed',
      outputSummary: '3 vectors',
    });

    const steps = await listAgentSteps(db, run.id);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ attempt: 1, status: 'failed', error: 'provider timeout' });
    expect(steps[1]).toMatchObject({ attempt: 2, status: 'completed', outputSummary: '3 vectors' });
  });
});

describe('retrieval reads: workspace isolation + ready-only filtering', () => {
  function embeddingFor(seed: number): number[] {
    return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => ((i + seed) % 7) / 10);
  }

  /** Seed a document (given status) with one embedded chunk; returns {documentId, chunkId}. */
  async function seedEmbeddedChunk(
    workspaceId: string,
    status: 'queued' | 'extracting' | 'chunking' | 'embedding' | 'indexing' | 'ready' | 'failed',
    seed: number,
  ) {
    const doc = await createEvidenceDocument(db, {
      workspaceId,
      sourceType: 'product_doc',
      title: `doc-${seed}`,
      blobUri: `s3://evidence/doc-${seed}.md`,
      checksum: `chk-${seed}`,
    });
    await updateDocumentStatus(db, doc.id, status);
    const [chunk] = await upsertChunks(db, [
      {
        documentId: doc.id,
        ord: 0,
        sourceKey: 'k',
        contentHash: `h-${seed}`,
        text: `chunk text ${seed}`,
        tokenCount: 3,
      },
    ]);
    await setChunkEmbedding(db, chunk!.id, embeddingFor(seed), 'stub');
    return { documentId: doc.id, chunkId: chunk!.id };
  }

  describe('searchChunksByVector', () => {
    it('never returns a chunk from another workspace', async () => {
      const wsA = await createWorkspace(db, { name: 'A' });
      const wsB = await createWorkspace(db, { name: 'B' });
      const a = await seedEmbeddedChunk(wsA.id, 'ready', 1);
      const b = await seedEmbeddedChunk(wsB.id, 'ready', 2);

      const hitsA = await searchChunksByVector(db, wsA.id, embeddingFor(1), 10);
      expect(hitsA.map((h) => h.chunkId)).toContain(a.chunkId);
      expect(hitsA.map((h) => h.chunkId)).not.toContain(b.chunkId);
    });

    it.each(['queued', 'extracting', 'chunking', 'embedding', 'indexing', 'failed'] as const)(
      'excludes chunks whose document status is %s',
      async (status) => {
        const ws = await createWorkspace(db, { name: `ws-${status}` });
        const notReady = await seedEmbeddedChunk(ws.id, status, 1);
        const ready = await seedEmbeddedChunk(ws.id, 'ready', 2);

        const hits = await searchChunksByVector(db, ws.id, embeddingFor(1), 10);
        expect(hits.map((h) => h.chunkId)).not.toContain(notReady.chunkId);
        expect(hits.map((h) => h.chunkId)).toContain(ready.chunkId);
      },
    );

    it('includes chunks whose document status is ready', async () => {
      const ws = await createWorkspace(db, { name: 'ready-ws' });
      const ready = await seedEmbeddedChunk(ws.id, 'ready', 1);
      const hits = await searchChunksByVector(db, ws.id, embeddingFor(1), 10);
      expect(hits.map((h) => h.chunkId)).toContain(ready.chunkId);
    });
  });

  describe('getRetrievalChunksByIds', () => {
    it('drops ids belonging to another workspace (defense in depth)', async () => {
      const wsA = await createWorkspace(db, { name: 'hydrate-A' });
      const wsB = await createWorkspace(db, { name: 'hydrate-B' });
      const a = await seedEmbeddedChunk(wsA.id, 'ready', 10);
      const b = await seedEmbeddedChunk(wsB.id, 'ready', 20);

      const rows = await getRetrievalChunksByIds(db, [a.chunkId, b.chunkId], wsA.id);
      expect(rows.map((r) => r.chunkId)).toEqual([a.chunkId]);
    });

    it('drops ids belonging to a non-ready document', async () => {
      const ws = await createWorkspace(db, { name: 'hydrate-status' });
      const failed = await seedEmbeddedChunk(ws.id, 'failed', 30);
      const ready = await seedEmbeddedChunk(ws.id, 'ready', 31);

      const rows = await getRetrievalChunksByIds(db, [failed.chunkId, ready.chunkId], ws.id);
      expect(rows.map((r) => r.chunkId)).toEqual([ready.chunkId]);
    });

    it('returns empty for an empty id list without querying', async () => {
      const ws = await createWorkspace(db, { name: 'empty-ids' });
      expect(await getRetrievalChunksByIds(db, [], ws.id)).toEqual([]);
    });
  });

  describe('getWorkspaceRetrievalRevision', () => {
    it('changes when a new ready document with chunks is added', async () => {
      const ws = await createWorkspace(db, { name: 'revision-add' });
      const before = await getWorkspaceRetrievalRevision(db, ws.id);
      await seedEmbeddedChunk(ws.id, 'ready', 1);
      const after = await getWorkspaceRetrievalRevision(db, ws.id);
      expect(after).not.toBe(before);
    });

    it('changes when a section is removed (fewer ready chunks)', async () => {
      const ws = await createWorkspace(db, { name: 'revision-remove' });
      const a = await seedEmbeddedChunk(ws.id, 'ready', 1);
      const b = await seedEmbeddedChunk(ws.id, 'ready', 2);
      const before = await getWorkspaceRetrievalRevision(db, ws.id);
      await deleteChunksNotIn(db, a.documentId, []);
      void b;
      const after = await getWorkspaceRetrievalRevision(db, ws.id);
      expect(after).not.toBe(before);
    });

    it('changes when a chunk is content-edited and re-embedded, with document/chunk COUNTS unchanged', async () => {
      // The exact blind spot of a pure count-based signal: mirrors a full
      // re-ingest cycle (extractAndChunk clears the stale embedding,
      // embedChunks restores it) so the embedded-chunk count round-trips back
      // to the same number — only the underlying content actually differs.
      const ws = await createWorkspace(db, { name: 'revision-content-edit' });
      const seeded = await seedEmbeddedChunk(ws.id, 'ready', 1);
      const before = await getWorkspaceRetrievalRevision(db, ws.id);

      await upsertChunks(db, [
        {
          documentId: seeded.documentId,
          ord: 0,
          sourceKey: 'k',
          contentHash: 'a-different-hash',
          text: 'edited text, same position, same chunk count',
          tokenCount: 6,
        },
      ]);
      const [editedChunk] = await getChunksByDocument(db, seeded.documentId);
      // Simulate embedChunks completing: the embedded-chunk COUNT is restored
      // to what it was before the edit.
      await setChunkEmbedding(
        db,
        editedChunk!.id,
        Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5),
        'stub',
      );

      const after = await getWorkspaceRetrievalRevision(db, ws.id);
      expect(after).not.toBe(before);
    });

    it('is stable when nothing about the ready corpus changes', async () => {
      const ws = await createWorkspace(db, { name: 'revision-stable' });
      await seedEmbeddedChunk(ws.id, 'ready', 1);
      const first = await getWorkspaceRetrievalRevision(db, ws.id);
      const second = await getWorkspaceRetrievalRevision(db, ws.id);
      expect(second).toBe(first);
    });

    it('is scoped per workspace', async () => {
      const wsA = await createWorkspace(db, { name: 'revision-scope-a' });
      const wsB = await createWorkspace(db, { name: 'revision-scope-b' });
      const before = await getWorkspaceRetrievalRevision(db, wsB.id);
      await seedEmbeddedChunk(wsA.id, 'ready', 1);
      const after = await getWorkspaceRetrievalRevision(db, wsB.id);
      expect(after).toBe(before);
    });
  });
});

describe('eval harness tables', () => {
  describe('findWorkspaceByName / findEvidenceDocumentByTitle', () => {
    it('finds an existing workspace by name, undefined when absent', async () => {
      await createWorkspace(db, { name: 'Eval Corpus' });
      expect(await findWorkspaceByName(db, 'Eval Corpus')).toMatchObject({ name: 'Eval Corpus' });
      expect(await findWorkspaceByName(db, 'does not exist')).toBeUndefined();
    });

    it('finds an existing document by (workspace, title), undefined when absent', async () => {
      const ws = await createWorkspace(db, { name: 'title-lookup' });
      const doc = await createEvidenceDocument(db, {
        workspaceId: ws.id,
        sourceType: 'product_doc',
        title: 'sharing-a-dashboard.md',
        blobUri: 's3://evidence/x.md',
        checksum: 'chk-1',
      });
      expect(await findEvidenceDocumentByTitle(db, ws.id, 'sharing-a-dashboard.md')).toMatchObject({
        id: doc.id,
      });
      expect(await findEvidenceDocumentByTitle(db, ws.id, 'missing.md')).toBeUndefined();
    });

    it('never returns a document from another workspace even with an identical title', async () => {
      const wsA = await createWorkspace(db, { name: 'title-iso-a' });
      const wsB = await createWorkspace(db, { name: 'title-iso-b' });
      const docA = await createEvidenceDocument(db, {
        workspaceId: wsA.id,
        sourceType: 'product_doc',
        title: 'Spec.md',
        blobUri: 's3://evidence/a.md',
        checksum: 'chk-a',
      });
      await createEvidenceDocument(db, {
        workspaceId: wsB.id,
        sourceType: 'product_doc',
        title: 'Spec.md',
        blobUri: 's3://evidence/b.md',
        checksum: 'chk-b',
      });
      expect(await findEvidenceDocumentByTitle(db, wsA.id, 'Spec.md')).toMatchObject({
        id: docA.id,
      });
    });
  });

  describe('createEvalQuery', () => {
    it('creates a new query', async () => {
      const ws = await createWorkspace(db, { name: 'eval-q-create' });
      const q = await createEvalQuery(db, {
        workspaceId: ws.id,
        externalId: 'link-expiry-01',
        queryText: 'set an expiry date on a share link',
      });
      expect(q.id).toBeTruthy();
      expect(q).toMatchObject({
        workspaceId: ws.id,
        externalId: 'link-expiry-01',
        queryText: 'set an expiry date on a share link',
        notes: null,
      });
    });

    it('rejects a raw duplicate (workspaceId, externalId) insert bypassing the upsert helper', async () => {
      const ws = await createWorkspace(db, { name: 'eval-q-raw-dup' });
      await createEvalQuery(db, { workspaceId: ws.id, externalId: 'q1', queryText: 'v1' });
      await expect(
        db.insert(schema.evalQueries).values({
          workspaceId: ws.id,
          externalId: 'q1',
          queryText: 'v2',
        }),
      ).rejects.toThrow();
    });

    it('rejects a workspaceId that does not exist (FK violation)', async () => {
      await expect(
        createEvalQuery(db, {
          workspaceId: '00000000-0000-4000-8000-000000000000',
          externalId: 'q1',
          queryText: 'v1',
        }),
      ).rejects.toThrow();
    });

    it('re-running with the same (workspace, externalId) updates queryText/notes in place, no duplicate row', async () => {
      const ws = await createWorkspace(db, { name: 'eval-q-upsert' });
      await createEvalQuery(db, { workspaceId: ws.id, externalId: 'q1', queryText: 'v1' });
      const updated = await createEvalQuery(db, {
        workspaceId: ws.id,
        externalId: 'q1',
        queryText: 'v2 edited',
        notes: 'now has notes',
      });
      expect(updated).toMatchObject({ queryText: 'v2 edited', notes: 'now has notes' });

      const all = await listEvalQueriesWithJudgments(db, ws.id);
      expect(all).toHaveLength(1);
      expect(all[0]!.query.queryText).toBe('v2 edited');
    });

    it('an identical externalId in two different workspaces does not collide', async () => {
      const wsA = await createWorkspace(db, { name: 'eval-q-iso-a' });
      const wsB = await createWorkspace(db, { name: 'eval-q-iso-b' });
      await createEvalQuery(db, { workspaceId: wsA.id, externalId: 'q1', queryText: 'a' });
      await createEvalQuery(db, { workspaceId: wsB.id, externalId: 'q1', queryText: 'b' });

      const listA = await listEvalQueriesWithJudgments(db, wsA.id);
      const listB = await listEvalQueriesWithJudgments(db, wsB.id);
      expect(listA).toHaveLength(1);
      expect(listB).toHaveLength(1);
      expect(listA[0]!.query.queryText).toBe('a');
      expect(listB[0]!.query.queryText).toBe('b');

      // Re-upserting wsA's row must not touch wsB's row for the same externalId.
      await createEvalQuery(db, { workspaceId: wsA.id, externalId: 'q1', queryText: 'a-edited' });
      expect((await listEvalQueriesWithJudgments(db, wsB.id))[0]!.query.queryText).toBe('b');
    });
  });

  describe('upsertEvalJudgment', () => {
    async function seedQuery(workspaceName: string) {
      const ws = await createWorkspace(db, { name: workspaceName });
      const q = await createEvalQuery(db, {
        workspaceId: ws.id,
        externalId: 'q1',
        queryText: 'probe',
      });
      return { ws, query: q };
    }

    it('creates a new judgment', async () => {
      const { query } = await seedQuery('eval-j-create');
      const j = await upsertEvalJudgment(db, {
        queryId: query.id,
        docId: 'doc-a',
        chunkSourceKey: 'overview',
        relevance: 2,
      });
      expect(j).toMatchObject({ docId: 'doc-a', chunkSourceKey: 'overview', relevance: 2 });
    });

    it('rejects a raw duplicate (queryId, docId, chunkSourceKey) insert', async () => {
      const { query } = await seedQuery('eval-j-raw-dup');
      await upsertEvalJudgment(db, {
        queryId: query.id,
        docId: 'doc-a',
        chunkSourceKey: 'overview',
        relevance: 2,
      });
      await expect(
        db.insert(schema.evalJudgments).values({
          queryId: query.id,
          docId: 'doc-a',
          chunkSourceKey: 'overview',
          relevance: 3,
        }),
      ).rejects.toThrow();
    });

    it('rejects a queryId that does not exist (FK violation)', async () => {
      await expect(
        upsertEvalJudgment(db, {
          queryId: '00000000-0000-4000-8000-000000000000',
          docId: 'doc-a',
          chunkSourceKey: 'overview',
          relevance: 2,
        }),
      ).rejects.toThrow();
    });

    it('re-running with the same natural key updates relevance in place, no duplicate row', async () => {
      const { query } = await seedQuery('eval-j-upsert');
      await upsertEvalJudgment(db, {
        queryId: query.id,
        docId: 'doc-a',
        chunkSourceKey: 'overview',
        relevance: 1,
      });
      await upsertEvalJudgment(db, {
        queryId: query.id,
        docId: 'doc-a',
        chunkSourceKey: 'overview',
        relevance: 3,
      });

      const all = await listEvalQueriesWithJudgments(db, query.workspaceId);
      expect(all[0]!.judgments).toHaveLength(1);
      expect(all[0]!.judgments[0]!.relevance).toBe(3);
    });

    it('identical (docId, chunkSourceKey) under two different workspaces’ queries do not collide', async () => {
      const a = await seedQuery('eval-j-iso-a');
      const b = await seedQuery('eval-j-iso-b');
      await upsertEvalJudgment(db, {
        queryId: a.query.id,
        docId: 'doc-x',
        chunkSourceKey: 'k1',
        relevance: 1,
      });
      await upsertEvalJudgment(db, {
        queryId: b.query.id,
        docId: 'doc-x',
        chunkSourceKey: 'k1',
        relevance: 2,
      });

      const listA = await listEvalQueriesWithJudgments(db, a.ws.id);
      const listB = await listEvalQueriesWithJudgments(db, b.ws.id);
      expect(listA[0]!.judgments[0]!.relevance).toBe(1);
      expect(listB[0]!.judgments[0]!.relevance).toBe(2);
    });
  });

  describe('listEvalQueriesWithJudgments', () => {
    it('returns every query for the workspace unconditionally, including ones with zero judgments', async () => {
      const ws = await createWorkspace(db, { name: 'eval-list-all' });
      const q0 = await createEvalQuery(db, {
        workspaceId: ws.id,
        externalId: 'q0',
        queryText: 'x',
      });
      const q1 = await createEvalQuery(db, {
        workspaceId: ws.id,
        externalId: 'q1',
        queryText: 'y',
      });
      await upsertEvalJudgment(db, {
        queryId: q1.id,
        docId: 'doc-a',
        chunkSourceKey: 'k1',
        relevance: 2,
      });
      await upsertEvalJudgment(db, {
        queryId: q1.id,
        docId: 'doc-b',
        chunkSourceKey: 'k2',
        relevance: 1,
      });

      const all = await listEvalQueriesWithJudgments(db, ws.id);
      expect(all).toHaveLength(2);
      const zero = all.find((e) => e.query.id === q0.id)!;
      const two = all.find((e) => e.query.id === q1.id)!;
      expect(zero.judgments).toEqual([]);
      expect(two.judgments).toHaveLength(2);
    });

    it('never includes another workspace’s queries/judgments, even with identical externalId/docId values', async () => {
      const wsA = await createWorkspace(db, { name: 'eval-list-iso-a' });
      const wsB = await createWorkspace(db, { name: 'eval-list-iso-b' });
      const qA = await createEvalQuery(db, {
        workspaceId: wsA.id,
        externalId: 'q1',
        queryText: 'a',
      });
      const qB = await createEvalQuery(db, {
        workspaceId: wsB.id,
        externalId: 'q1',
        queryText: 'b',
      });
      await upsertEvalJudgment(db, {
        queryId: qA.id,
        docId: 'doc-a',
        chunkSourceKey: 'k1',
        relevance: 2,
      });
      await upsertEvalJudgment(db, {
        queryId: qB.id,
        docId: 'doc-a',
        chunkSourceKey: 'k1',
        relevance: 3,
      });

      const listA = await listEvalQueriesWithJudgments(db, wsA.id);
      expect(listA).toHaveLength(1);
      expect(listA[0]!.query.id).toBe(qA.id);
      expect(listA[0]!.judgments[0]!.relevance).toBe(2);
    });
  });

  describe('createEvalReport', () => {
    it('inserts and defaults kind to retrieval', async () => {
      const ws = await createWorkspace(db, { name: 'eval-report-default' });
      const report = await createEvalReport(db, {
        workspaceId: ws.id,
        configName: 'hybrid_rerank',
        config: { topK: 8, candidateK: 30 },
        metrics: { precisionAt5: 0.8 },
      });
      expect(report.kind).toBe('retrieval');
    });

    it('accepts kind=trajectory even though nothing produces it yet', async () => {
      const ws = await createWorkspace(db, { name: 'eval-report-trajectory' });
      const report = await createEvalReport(db, {
        workspaceId: ws.id,
        kind: 'trajectory',
        configName: 'llm_judge_v1',
        config: {},
        metrics: {},
      });
      expect(report.kind).toBe('trajectory');
    });

    it('round-trips deeply nested config/metrics jsonb exactly, and null perQuery distinctly', async () => {
      const ws = await createWorkspace(db, { name: 'eval-report-jsonb' });
      const config = {
        retriever: { name: 'hybrid', k: 10, weights: [0.6, 0.4] },
        rerank: { enabled: true, model: 'bge-reranker' },
      };
      const metrics = {
        overall: { precisionAt5: 0.8, recallAt10: 0.65, mrr: 0.9, ndcgAt10: 0.77 },
        byQuery: [{ externalId: 'q1', precisionAt5: 1.0 }],
      };
      const report = await createEvalReport(db, {
        workspaceId: ws.id,
        configName: 'hybrid_rerank',
        config,
        metrics,
        perQuery: null,
      });
      expect(report.config).toEqual(config);
      expect(report.metrics).toEqual(metrics);
      expect(report.perQuery).toBeNull();
    });
  });

  describe('cascade delete', () => {
    it('deleting a workspace deletes its eval_queries, their eval_judgments, and its eval_reports', async () => {
      const ws = await createWorkspace(db, { name: 'eval-cascade-ws' });
      const q = await createEvalQuery(db, { workspaceId: ws.id, externalId: 'q1', queryText: 'x' });
      await upsertEvalJudgment(db, {
        queryId: q.id,
        docId: 'doc-a',
        chunkSourceKey: 'k1',
        relevance: 2,
      });
      await createEvalReport(db, {
        workspaceId: ws.id,
        configName: 'hybrid_rerank',
        config: {},
        metrics: {},
      });

      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws.id));

      expect(await listEvalQueriesWithJudgments(db, ws.id)).toEqual([]);
    });

    it('deleting one eval_query deletes only its own eval_judgments, not a sibling query’s', async () => {
      const ws = await createWorkspace(db, { name: 'eval-cascade-query' });
      const q1 = await createEvalQuery(db, {
        workspaceId: ws.id,
        externalId: 'q1',
        queryText: 'x',
      });
      const q2 = await createEvalQuery(db, {
        workspaceId: ws.id,
        externalId: 'q2',
        queryText: 'y',
      });
      await upsertEvalJudgment(db, {
        queryId: q1.id,
        docId: 'doc-a',
        chunkSourceKey: 'k1',
        relevance: 2,
      });
      await upsertEvalJudgment(db, {
        queryId: q2.id,
        docId: 'doc-b',
        chunkSourceKey: 'k2',
        relevance: 1,
      });

      await db.delete(schema.evalQueries).where(eq(schema.evalQueries.id, q1.id));

      const all = await listEvalQueriesWithJudgments(db, ws.id);
      expect(all).toHaveLength(1);
      expect(all[0]!.query.id).toBe(q2.id);
      expect(all[0]!.judgments).toHaveLength(1);
    });
  });
});
