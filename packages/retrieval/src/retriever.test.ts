import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  createEvidenceDocument,
  createWorkspace,
  getChunksByDocument,
  setChunkEmbedding,
  updateDocumentStatus,
  upsertChunks,
  type Database,
  type DocumentStatus,
} from '@threadmark/db';
import * as schema from '@threadmark/db';
import { createModelRouter, type ModelRouter } from '@threadmark/model-router';
import { InMemorySearchIndex } from '@threadmark/search';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryCache } from './cache.js';
import { CHUNK_INDEX, createRetriever, type Retriever } from './retriever.js';

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url));

const CHUNKS = [
  { key: 'a', text: 'external dashboard sharing via secure links with viewer-only access' },
  { key: 'b', text: 'link expiry and revoke controls for shared dashboards' },
  { key: 'c', text: 'monthly billing invoice totals and payment methods' },
];

let db: Database;
let search: InMemorySearchIndex;
let router: ModelRouter;
let retriever: Retriever;
let workspaceId: string;

/**
 * Seed a workspace with a document + chunks, embedded (stub model) and indexed
 * (in-memory BM25). Defaults to `ready` — tests that need another status pass
 * one explicitly.
 */
async function seedWorkspace(
  name: string,
  chunkDefs: { key: string; text: string }[],
  status: DocumentStatus = 'ready',
): Promise<{ workspaceId: string; documentId: string }> {
  const workspace = await createWorkspace(db, { name });
  const doc = await createEvidenceDocument(db, {
    workspaceId: workspace.id,
    sourceType: 'product_doc',
    title: `${name}.md`,
    blobUri: `s3://memory/${name}.md`,
    checksum: `chk-${name}`,
  });
  await upsertChunks(
    db,
    chunkDefs.map((c, i) => ({
      documentId: doc.id,
      ord: i,
      sourceKey: c.key,
      contentHash: `h-${name}-${c.key}`,
      text: c.text,
      tokenCount: c.text.split(' ').length,
    })),
  );
  const stored = await getChunksByDocument(db, doc.id);
  const embedded = await router.embed({ input: stored.map((c) => c.text) });
  for (let i = 0; i < stored.length; i++) {
    await setChunkEmbedding(db, stored[i]!.id, embedded.vectors[i]!, embedded.model);
  }
  await search.ensureIndex(CHUNK_INDEX);
  await search.indexChunks(
    CHUNK_INDEX,
    stored.map((c) => ({ id: c.id, documentId: doc.id, workspaceId: workspace.id, text: c.text })),
  );
  // upsertChunks/createEvidenceDocument default a document to 'queued'; set the
  // requested status last so callers can also test non-ready states.
  await updateDocumentStatus(db, doc.id, status);
  return { workspaceId: workspace.id, documentId: doc.id };
}

beforeEach(async () => {
  const pg = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pg, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb as unknown as Database;

  search = new InMemorySearchIndex();
  router = createModelRouter({
    generation: { provider: 'stub' },
    embedding: { provider: 'stub', dimensions: 384 },
    rerank: { provider: 'stub' },
  });

  const seeded = await seedWorkspace('primary', CHUNKS);
  workspaceId = seeded.workspaceId;

  retriever = createRetriever({ db, search, router, cache: new InMemoryCache() });
});

describe('hybrid retriever — happy path', () => {
  it('returns fused, reranked results carrying provenance', async () => {
    const result = await retriever.search('external dashboard sharing links', { workspaceId });
    expect(result.cached).toBe(false);
    expect(result.results.length).toBeGreaterThan(0);
    // The billing chunk should not outrank the sharing chunks.
    const topText = result.results[0]!.text;
    expect(topText).toMatch(/sharing|links/);
    // Provenance: at least one result was found by both retrievers.
    expect(result.results.some((r) => r.vectorRank !== undefined)).toBe(true);
  });

  it('serves the second identical query from cache', async () => {
    await retriever.search('link expiry revoke', { workspaceId });
    const second = await retriever.search('link expiry revoke', { workspaceId });
    expect(second.cached).toBe(true);
    expect(second.results.length).toBeGreaterThan(0);
  });

  it('surfaces a candidate BM25 never indexed, found only by the vector retriever', async () => {
    const queryText = 'zzqx unique probe alpha phrase';
    const queryEmbedding = (await router.embed({ input: [queryText] })).vectors[0]!;
    const { workspaceId: wsId, documentId } = await seedWorkspace(`vec-only-${Math.random()}`, []);
    const [chunk] = await upsertChunks(db, [
      {
        documentId,
        ord: 0,
        sourceKey: 'vec-only',
        contentHash: 'h-vec-only',
        text: 'completely unrelated words with no shared vocabulary',
        tokenCount: 6,
      },
    ]);
    // Engineer an exact embedding match so this chunk ranks #1 by vector
    // distance, but never index it into BM25 — it must still surface.
    await setChunkEmbedding(db, chunk!.id, queryEmbedding, 'stub');

    const result = await retriever.search(queryText, { workspaceId: wsId });
    const hit = result.results.find((r) => r.chunkId === chunk!.id);
    expect(hit).toBeDefined();
    expect(hit!.vectorRank).toBe(1);
    expect(hit!.lexicalRank).toBeUndefined();
  });

  it('surfaces a candidate with no embedding yet, found only by BM25', async () => {
    const { workspaceId: wsId, documentId } = await seedWorkspace(`bm25-only-${Math.random()}`, []);
    const [chunk] = await upsertChunks(db, [
      {
        documentId,
        ord: 0,
        sourceKey: 'bm25-only',
        contentHash: 'h-bm25-only',
        text: 'zzqy unique lexical marker text for matching',
        tokenCount: 7,
      },
    ]);
    // No setChunkEmbedding call: embedding stays NULL, excluded from vector kNN.
    await search.indexChunks(CHUNK_INDEX, [
      { id: chunk!.id, documentId, workspaceId: wsId, text: chunk!.text },
    ]);

    const result = await retriever.search('zzqy unique lexical marker text', {
      workspaceId: wsId,
    });
    const hit = result.results.find((r) => r.chunkId === chunk!.id);
    expect(hit).toBeDefined();
    expect(hit!.lexicalRank).toBeDefined();
    expect(hit!.vectorRank).toBeUndefined();
  });

  it('respects topK independent of candidateK', async () => {
    const result = await retriever.search('dashboard', {
      workspaceId,
      topK: 1,
      candidateK: 10,
    });
    expect(result.results).toHaveLength(1);
  });

  it('returns empty results for a workspace with no ready content, and caches the empty result', async () => {
    const empty = await createWorkspace(db, { name: 'empty' });
    const result = await retriever.search('anything at all', { workspaceId: empty.id });
    expect(result.results).toEqual([]);
    expect(result.cached).toBe(false);

    const second = await retriever.search('anything at all', { workspaceId: empty.id });
    expect(second.cached).toBe(true);
    expect(second.results).toEqual([]);
  });
});

describe('hybrid retriever — multi-tenant isolation (hard gate)', () => {
  it('never returns a hit from another workspace, even with lexically and semantically similar content', async () => {
    const shared = [{ key: 'x', text: 'external dashboard sharing access controls for partners' }];
    const wsA = await seedWorkspace(`iso-a-${Math.random()}`, shared);
    const wsB = await seedWorkspace(`iso-b-${Math.random()}`, shared);

    const resultA = await retriever.search('external dashboard sharing access controls', {
      workspaceId: wsA.workspaceId,
    });
    expect(resultA.results.length).toBeGreaterThan(0);
    expect(resultA.results.every((r) => r.documentId === wsA.documentId)).toBe(true);

    const resultB = await retriever.search('external dashboard sharing access controls', {
      workspaceId: wsB.workspaceId,
    });
    expect(resultB.results.length).toBeGreaterThan(0);
    expect(resultB.results.every((r) => r.documentId === wsB.documentId)).toBe(true);
  });

  it('gives separate workspaces separate cache entries for the identical query', async () => {
    const wsA = await seedWorkspace(`cache-iso-a-${Math.random()}`, [
      { key: 'x', text: 'alpha content only in workspace a' },
    ]);
    const wsB = await seedWorkspace(`cache-iso-b-${Math.random()}`, [
      { key: 'x', text: 'alpha content only in workspace b' },
    ]);

    const resultA = await retriever.search('alpha content', { workspaceId: wsA.workspaceId });
    const resultB = await retriever.search('alpha content', { workspaceId: wsB.workspaceId });
    expect(resultA.cached).toBe(false);
    expect(resultB.cached).toBe(false);
    expect(resultA.results.every((r) => r.documentId === wsA.documentId)).toBe(true);
    expect(resultB.results.every((r) => r.documentId === wsB.documentId)).toBe(true);
  });
});

describe('hybrid retriever — input validation', () => {
  it.each([
    ['', 'empty query'],
    ['   ', 'whitespace-only query'],
  ])('rejects %j (%s)', async (query) => {
    await expect(retriever.search(query, { workspaceId })).rejects.toThrow(/query/i);
  });

  it('rejects a missing/empty workspaceId', async () => {
    await expect(retriever.search('dashboard', { workspaceId: '' })).rejects.toThrow(/workspace/i);
  });

  it.each([0, -1, 1.5, -3.2])('rejects topK=%s', async (topK) => {
    await expect(retriever.search('dashboard', { workspaceId, topK })).rejects.toThrow(/topK/i);
  });

  it.each([0, -1, 1.5])('rejects candidateK=%s', async (candidateK) => {
    await expect(retriever.search('dashboard', { workspaceId, candidateK })).rejects.toThrow(
      /candidateK/i,
    );
  });

  it('rejects an oversized topK', async () => {
    await expect(retriever.search('dashboard', { workspaceId, topK: 100_000 })).rejects.toThrow(
      /topK/i,
    );
  });

  it('rejects an oversized candidateK', async () => {
    await expect(
      retriever.search('dashboard', { workspaceId, candidateK: 100_000 }),
    ).rejects.toThrow(/candidateK/i);
  });

  it('rejects topK > candidateK', async () => {
    await expect(
      retriever.search('dashboard', { workspaceId, topK: 20, candidateK: 5 }),
    ).rejects.toThrow(/topK.*candidateK/i);
  });

  it('accepts topK === candidateK', async () => {
    await expect(
      retriever.search('dashboard', { workspaceId, topK: 5, candidateK: 5 }),
    ).resolves.toBeDefined();
  });
});

describe('hybrid retriever — cache versioning', () => {
  it('does not serve a stale cache hit after the embedding model changes', async () => {
    const cache = new InMemoryCache();
    const retrieverV1 = createRetriever({ db, search, router, cache });
    await retrieverV1.search('external dashboard sharing', { workspaceId });

    // Same underlying behavior, but reports a different embedding model — as a
    // real model upgrade would. The cache key must change, so this is a MISS,
    // not a stale hit computed under the old model.
    const upgradedRouter: ModelRouter = {
      ...router,
      providers: {
        ...router.providers,
        embedding: { ...router.providers.embedding, model: 'bge-v2' },
      },
    };
    const retrieverV2 = createRetriever({ db, search, router: upgradedRouter, cache });
    const result = await retrieverV2.search('external dashboard sharing', { workspaceId });
    expect(result.cached).toBe(false);
  });

  it('does not serve a stale cache hit after the reranker model changes', async () => {
    const cache = new InMemoryCache();
    const retrieverV1 = createRetriever({ db, search, router, cache });
    await retrieverV1.search('link expiry revoke', { workspaceId });

    const upgradedRouter: ModelRouter = {
      ...router,
      providers: {
        ...router.providers,
        rerank: { ...router.providers.rerank, model: 'reranker-v2' },
      },
    };
    const retrieverV2 = createRetriever({ db, search, router: upgradedRouter, cache });
    const result = await retrieverV2.search('link expiry revoke', { workspaceId });
    expect(result.cached).toBe(false);
  });

  it('does not serve a stale cache hit after the workspace corpus changes (re-ingest)', async () => {
    const cache = new InMemoryCache();
    const r = createRetriever({ db, search, router, cache });
    const first = await r.search('external dashboard sharing', { workspaceId });
    expect(first.cached).toBe(false);
    const cachedAgain = await r.search('external dashboard sharing', { workspaceId });
    expect(cachedAgain.cached).toBe(true);

    // Simulate ingestion adding a new ready document to this workspace.
    const doc = await createEvidenceDocument(db, {
      workspaceId,
      sourceType: 'product_doc',
      title: 'new-doc.md',
      blobUri: 's3://memory/new-doc.md',
      checksum: 'chk-new-doc',
    });
    await upsertChunks(db, [
      {
        documentId: doc.id,
        ord: 0,
        sourceKey: 'new',
        contentHash: 'h-new',
        text: 'freshly added external dashboard sharing content',
        tokenCount: 5,
      },
    ]);
    const [newChunk] = await getChunksByDocument(db, doc.id);
    const embedded = await router.embed({ input: [newChunk!.text] });
    await setChunkEmbedding(db, newChunk!.id, embedded.vectors[0]!, embedded.model);
    await search.indexChunks(CHUNK_INDEX, [
      { id: newChunk!.id, documentId: doc.id, workspaceId, text: newChunk!.text },
    ]);
    await updateDocumentStatus(db, doc.id, 'ready');

    const afterIngest = await r.search('external dashboard sharing', { workspaceId });
    expect(afterIngest.cached).toBe(false);
  });
});

describe('hybrid retriever — robustness against malformed provider/index output', () => {
  it('does not crash and drops results when the reranker returns an unknown id', async () => {
    const badRouter: ModelRouter = {
      ...router,
      rerank: async (request) => ({
        model: 'bad',
        results: [
          ...request.documents.slice(0, 1).map((d, i) => ({ id: d.id, index: i, score: 0.9 })),
          { id: 'chunk-id-that-does-not-exist', index: 99, score: 0.99 },
        ],
      }),
    };
    const retrieverWithBadRerank = createRetriever({ db, search, router: badRouter });
    const result = await retrieverWithBadRerank.search('external dashboard sharing', {
      workspaceId,
    });
    expect(result.results.some((r) => r.chunkId === 'chunk-id-that-does-not-exist')).toBe(false);
  });

  it('does not crash and de-duplicates when the reranker returns the same id twice', async () => {
    const dupRouter: ModelRouter = {
      ...router,
      rerank: async (request) => {
        const first = request.documents[0];
        if (!first) return { model: 'dup', results: [] };
        return {
          model: 'dup',
          results: [
            { id: first.id, index: 0, score: 0.9 },
            { id: first.id, index: 0, score: 0.9 },
          ],
        };
      },
    };
    const retrieverWithDupRerank = createRetriever({ db, search, router: dupRouter });
    const result = await retrieverWithDupRerank.search('external dashboard sharing', {
      workspaceId,
    });
    const ids = result.results.map((r) => r.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ignores a stale lexical hit whose chunk no longer exists in Postgres', async () => {
    // Simulate an OpenSearch entry that survived a deletion the DB already
    // reflects (a reconciliation race) — must not crash the request. Chunk ids
    // are UUID-typed in Postgres, so the ghost id must still be UUID-shaped.
    const ghostChunkId = '00000000-0000-4000-8000-000000000000';
    const ghostDocId = '00000000-0000-4000-8000-000000000001';
    await search.indexChunks(CHUNK_INDEX, [
      {
        id: ghostChunkId,
        documentId: ghostDocId,
        workspaceId,
        text: 'external dashboard sharing ghost entry',
      },
    ]);
    const result = await retriever.search('external dashboard sharing', { workspaceId });
    expect(result.results.some((r) => r.chunkId === ghostChunkId)).toBe(false);
  });
});

describe('hybrid retriever — adversarial query inputs (must not crash)', () => {
  it.each([
    'external dashboard sharing 🔒 access',
    '!!! ??? ... --- ***',
    'a'.repeat(5000),
    '12345678-1234-1234-1234-123456789012',
  ])('handles %j without throwing', async (query) => {
    await expect(retriever.search(query, { workspaceId })).resolves.toBeDefined();
  });
});

describe('hybrid retriever — only ready documents are searchable', () => {
  it.each(['queued', 'extracting', 'chunking', 'embedding', 'indexing', 'failed'] as const)(
    'excludes a document in status=%s end to end',
    async (status) => {
      const { workspaceId: wsId } = await seedWorkspace(
        `status-${status}-${Math.random()}`,
        [{ key: 'x', text: 'unique status probe content for exclusion check' }],
        status,
      );
      const result = await retriever.search('unique status probe content', { workspaceId: wsId });
      expect(result.results).toEqual([]);
    },
  );
});

describe('hybrid retriever — telemetry', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterEach(() => {
    trace.disable();
    exporter.reset();
  });

  it('emits one retrieval.search span per call, covering the full-result path', async () => {
    const result = await retriever.search('external dashboard sharing', {
      workspaceId,
      topK: 2,
      candidateK: 5,
    });

    // The retrieval.search span is the parent of the model-router's own
    // embed/rerank spans (both chokepoints are instrumented) — assert on the
    // retrieval.search span specifically, not the raw exporter total.
    const spans = exporter.getFinishedSpans();
    const searchSpans = spans.filter((s) => s.name === 'retrieval.search');
    expect(searchSpans).toHaveLength(1);
    const span = searchSpans[0]!;
    expect(span.status.code).toBe(1); // SpanStatusCode.OK
    expect(span.attributes['retrieval.workspace_id']).toBe(workspaceId);
    expect(span.attributes['retrieval.top_k']).toBe(2);
    expect(span.attributes['retrieval.candidate_k']).toBe(5);
    expect(span.attributes['retrieval.cached']).toBe(false);
    expect(span.attributes['retrieval.result_count']).toBe(result.results.length);
    expect(span.attributes['retrieval.latency_ms']).toBe(result.latencyMs);

    // Both nested model-router spans fire as children of this call.
    expect(spans.some((s) => s.name === 'model_router.embed')).toBe(true);
    expect(spans.some((s) => s.name === 'model_router.rerank')).toBe(true);
  });

  it('covers the cache-hit early-return path', async () => {
    await retriever.search('external dashboard sharing', { workspaceId });
    exporter.reset();

    const cached = await retriever.search('external dashboard sharing', { workspaceId });
    expect(cached.cached).toBe(true);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['retrieval.cached']).toBe(true);
  });

  it('covers the empty-candidates early-return path', async () => {
    const { workspaceId: emptyWs } = await seedWorkspace(`telemetry-empty-${Math.random()}`, []);
    exporter.reset(); // discard any spans emitted by seeding itself, not the call under test

    const result = await retriever.search('anything', { workspaceId: emptyWs });
    expect(result.results).toEqual([]);

    const searchSpans = exporter.getFinishedSpans().filter((s) => s.name === 'retrieval.search');
    expect(searchSpans).toHaveLength(1);
    expect(searchSpans[0]!.status.code).toBe(1); // SpanStatusCode.OK
    expect(searchSpans[0]!.attributes['retrieval.result_count']).toBe(0);
  });

  it('marks the span as an error and rethrows unchanged when input validation fails', async () => {
    await expect(retriever.search('', { workspaceId })).rejects.toThrow();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('never puts the raw query text on the span', async () => {
    const marker = 'SECRET_MARKER_XYZ';
    await retriever.search(marker, { workspaceId });

    for (const span of exporter.getFinishedSpans()) {
      for (const value of Object.values(span.attributes)) {
        expect(String(value)).not.toContain(marker);
      }
    }
  });

  it('never cross-attributes concurrent searches for different workspaces', async () => {
    const wsA = await seedWorkspace(`telemetry-iso-a-${Math.random()}`, CHUNKS);
    const wsB = await seedWorkspace(`telemetry-iso-b-${Math.random()}`, CHUNKS);
    exporter.reset(); // discard spans emitted by seeding itself, not the calls under test

    await Promise.all([
      retriever.search('external dashboard sharing', { workspaceId: wsA.workspaceId }),
      retriever.search('external dashboard sharing', { workspaceId: wsB.workspaceId }),
    ]);

    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'retrieval.search');
    expect(spans).toHaveLength(2);
    expect(spans.some((s) => s.attributes['retrieval.workspace_id'] === wsA.workspaceId)).toBe(
      true,
    );
    expect(spans.some((s) => s.attributes['retrieval.workspace_id'] === wsB.workspaceId)).toBe(
      true,
    );
  });
});
