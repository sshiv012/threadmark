import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { InMemoryBlobStore } from '@threadmark/blob';
import { createChunkerRegistry } from '@threadmark/chunking';
import {
  createEvidenceDocument,
  findOrCreateWorkspaceByName,
  getChunksByDocument,
  type Database,
} from '@threadmark/db';
import * as schema from '@threadmark/db';
import { createModelRouter } from '@threadmark/model-router';
import { InMemorySearchIndex } from '@threadmark/search';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { extractAndChunk, embedChunks, indexChunks, type IngestionDeps } from './pipeline.js';
import { CHUNK_INDEX } from './shared.js';

// The db package ships its migrations next to its dist; resolve from the pkg.
const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

const MARKDOWN = `# External sharing
Users want to share dashboards with external stakeholders via secure links.

## Access controls
Links should support viewer-only access, expiry, and revoke.`;

let deps: IngestionDeps;
let documentId: string;

beforeEach(async () => {
  const pg = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pg, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  const db = pgliteDb as unknown as Database;

  const blob = new InMemoryBlobStore('memory');
  const search = new InMemorySearchIndex();
  const router = createModelRouter({
    generation: { provider: 'stub' },
    embedding: { provider: 'stub', dimensions: 384 },
    rerank: { provider: 'stub' },
  });
  const chunkers = createChunkerRegistry();
  deps = { db, blob, search, router, chunkers };

  const workspace = await findOrCreateWorkspaceByName(db, 'Test');
  const { uri } = await blob.put('doc.md', new TextEncoder().encode(MARKDOWN), 'text/markdown');
  const document = await createEvidenceDocument(db, {
    workspaceId: workspace.id,
    sourceType: 'product_doc',
    title: 'doc.md',
    blobUri: uri,
    checksum: 'sha-1',
  });
  documentId = document.id;
});

describe('ingestion pipeline', () => {
  it('extracts, chunks, embeds, and indexes end to end', async () => {
    const chunked = await extractAndChunk(deps, documentId);
    expect(chunked).toBeGreaterThan(0);

    let chunks = await getChunksByDocument(deps.db, documentId);
    expect(chunks).toHaveLength(chunked);
    expect(chunks.every((c) => c.embedding === null)).toBe(true);

    const embedded = await embedChunks(deps, documentId);
    expect(embedded).toBe(chunked);
    chunks = await getChunksByDocument(deps.db, documentId);
    expect(chunks.every((c) => c.embedding?.length === 384)).toBe(true);

    const indexed = await indexChunks(deps, documentId);
    expect(indexed).toBe(chunked);
    const hits = await deps.search.searchBm25(CHUNK_INDEX, 'external sharing links', 10);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('is idempotent and does not re-embed unchanged chunks on re-run', async () => {
    await extractAndChunk(deps, documentId);
    const first = await embedChunks(deps, documentId);
    expect(first).toBeGreaterThan(0);

    // Re-ingest: same content → chunks preserved, nothing left to embed.
    await extractAndChunk(deps, documentId);
    expect(await embedChunks(deps, documentId)).toBe(0);
  });
});
