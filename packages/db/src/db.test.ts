import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import {
  addMembership,
  appendAgentStep,
  createAgentRun,
  createEvidenceDocument,
  createUser,
  createWorkspace,
  deleteChunksNotIn,
  findEvidenceDocumentByChecksum,
  getAgentRun,
  getChunksByDocument,
  getEvidenceDocument,
  getRetrievalChunksByIds,
  getUserByEmail,
  getWorkspace,
  getWorkspaceRetrievalRevision,
  listAgentSteps,
  listMemberships,
  searchChunksByVector,
  setChunkEmbedding,
  updateAgentRunStatus,
  updateAgentStep,
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
