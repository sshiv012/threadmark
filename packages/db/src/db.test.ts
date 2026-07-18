import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import {
  addMembership,
  createEvidenceDocument,
  createUser,
  createWorkspace,
  getChunksByDocument,
  getEvidenceDocument,
  getUserByEmail,
  getWorkspace,
  listMemberships,
  updateDocumentStatus,
  upsertChunks,
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

  it('rejects a duplicate membership for the same (workspace, user)', async () => {
    const { workspace, user } = await seedWorkspaceAndUser();
    await addMembership(db, { workspaceId: workspace.id, userId: user.id, role: 'editor' });
    await expect(
      addMembership(db, { workspaceId: workspace.id, userId: user.id, role: 'viewer' }),
    ).rejects.toThrow();
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
      { documentId: doc.id, ord: 0, text: 'hello', tokenCount: 1, embedding },
    ]);
    const stored = chunk!.embedding!;
    expect(stored).toHaveLength(EMBEDDING_DIMENSIONS);
    // pgvector stores single-precision (float4), so values round-trip at
    // float32 precision — assert closeness, not exact float64 equality.
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      expect(stored[i]).toBeCloseTo(embedding[i]!, 5);
    }
  });

  it('is idempotent on (document_id, ord) — re-ingesting upserts, not duplicates', async () => {
    const doc = await seedDocument();
    await upsertChunks(db, [{ documentId: doc.id, ord: 0, text: 'v1', tokenCount: 1 }]);
    await upsertChunks(db, [{ documentId: doc.id, ord: 0, text: 'v2', tokenCount: 2 }]);

    const stored = await getChunksByDocument(db, doc.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ text: 'v2', tokenCount: 2 });
  });

  it('orders chunks by ord', async () => {
    const doc = await seedDocument();
    await upsertChunks(db, [
      { documentId: doc.id, ord: 2, text: 'c', tokenCount: 1 },
      { documentId: doc.id, ord: 0, text: 'a', tokenCount: 1 },
      { documentId: doc.id, ord: 1, text: 'b', tokenCount: 1 },
    ]);
    expect((await getChunksByDocument(db, doc.id)).map((c) => c.text)).toEqual(['a', 'b', 'c']);
  });
});
