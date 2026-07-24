import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import {
  createEvidenceDocument,
  findOrCreateWorkspaceByName,
  getChunksByDocument,
  setChunkEmbedding,
  upsertChunks,
  type Database,
} from '@threadmark/db';
import * as schema from '@threadmark/db';
import { createModelRouter } from '@threadmark/model-router';
import { InMemorySearchIndex } from '@threadmark/search';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryCache } from './cache.js';
import { CHUNK_INDEX, createRetriever, type Retriever } from './retriever.js';

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url));

const CHUNKS = [
  { key: 'a', text: 'external dashboard sharing via secure links with viewer-only access' },
  { key: 'b', text: 'link expiry and revoke controls for shared dashboards' },
  { key: 'c', text: 'monthly billing invoice totals and payment methods' },
];

let db: Database;
let retriever: Retriever;
let workspaceId: string;

beforeEach(async () => {
  const pg = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pg, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb as unknown as Database;

  const search = new InMemorySearchIndex();
  const router = createModelRouter({
    generation: { provider: 'stub' },
    embedding: { provider: 'stub', dimensions: 384 },
    rerank: { provider: 'stub' },
  });

  const workspace = await findOrCreateWorkspaceByName(db, 'Test');
  workspaceId = workspace.id;
  const doc = await createEvidenceDocument(db, {
    workspaceId,
    sourceType: 'product_doc',
    title: 'sharing.md',
    blobUri: 's3://memory/sharing.md',
    checksum: 'c1',
  });

  await upsertChunks(
    db,
    CHUNKS.map((c, i) => ({
      documentId: doc.id,
      ord: i,
      sourceKey: c.key,
      contentHash: `h-${c.key}`,
      text: c.text,
      tokenCount: c.text.split(' ').length,
    })),
  );

  // Embed + index each chunk (stub embeddings; in-memory BM25).
  const stored = await getChunksByDocument(db, doc.id);
  const embedded = await router.embed({ input: stored.map((c) => c.text) });
  for (let i = 0; i < stored.length; i++) {
    await setChunkEmbedding(db, stored[i]!.id, embedded.vectors[i]!, embedded.model);
  }
  await search.ensureIndex(CHUNK_INDEX);
  await search.indexChunks(
    CHUNK_INDEX,
    stored.map((c) => ({ id: c.id, documentId: doc.id, text: c.text })),
  );

  retriever = createRetriever({ db, search, router, cache: new InMemoryCache() });
});

describe('hybrid retriever', () => {
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
});
