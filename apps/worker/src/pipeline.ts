/**
 * Ingestion pipeline core — pure functions over injected dependencies so they
 * unit-test offline (in-memory blob/search + pglite + stub model). The Temporal
 * activities in activities.ts wrap these with real deps + observability.
 *
 * Handoff between phases is the DB (chunks table), not the workflow payload, so
 * activities pass only small counts and stay independently retryable/idempotent.
 */
import type { BlobStore } from '@threadmark/blob';
import { DEFAULT_CHUNKING_OPTIONS, type ChunkerRegistry } from '@threadmark/chunking';
import {
  getChunksByDocument,
  getEvidenceDocument,
  setChunkEmbedding,
  upsertChunks,
  type Database,
} from '@threadmark/db';
import type { ModelRouter } from '@threadmark/model-router';
import type { SearchIndex } from '@threadmark/search';
import { inferContentType } from './helpers.js';
import { CHUNK_INDEX } from './shared.js';

export interface IngestionDeps {
  db: Database;
  blob: BlobStore;
  search: SearchIndex;
  router: ModelRouter;
  chunkers: ChunkerRegistry;
}

/** `s3://bucket/a/b.txt` → `a/b.txt` (BlobStore keys are bucket-relative). */
function blobKeyFromUri(uri: string): string {
  return new URL(uri).pathname.replace(/^\//, '');
}

export function extractText(bytes: Uint8Array, contentType: string): string {
  if (!contentType.startsWith('text/')) {
    throw new Error(`unsupported content type for extraction: ${contentType}`);
  }
  return new TextDecoder().decode(bytes);
}

/** Load the blob, extract text, chunk it, and persist chunks (no embeddings). */
export async function extractAndChunk(deps: IngestionDeps, documentId: string): Promise<number> {
  const document = await getEvidenceDocument(deps.db, documentId);
  if (!document) throw new Error(`document not found: ${documentId}`);

  const { bytes } = await deps.blob.get(blobKeyFromUri(document.blobUri));
  const text = extractText(bytes, inferContentType(document.title));

  const chunker = deps.chunkers.get(document.sourceType);
  const candidates = await chunker.chunk(
    { sourceType: document.sourceType, text },
    DEFAULT_CHUNKING_OPTIONS,
  );

  await upsertChunks(
    deps.db,
    candidates.map((c) => ({
      documentId,
      ord: c.ord,
      sourceKey: c.sourceKey,
      contentHash: c.contentHash,
      text: c.text,
      tokenCount: c.tokenCount,
    })),
  );
  return candidates.length;
}

/** Embed only chunks missing a vector (new/changed content); returns how many. */
export async function embedChunks(deps: IngestionDeps, documentId: string): Promise<number> {
  const chunks = await getChunksByDocument(deps.db, documentId);
  const pending = chunks.filter((chunk) => chunk.embedding === null);
  if (pending.length === 0) return 0;

  const { vectors } = await deps.router.embed({ input: pending.map((c) => c.text) });
  for (let i = 0; i < pending.length; i++) {
    await setChunkEmbedding(deps.db, pending[i]!.id, vectors[i]!);
  }
  return pending.length;
}

/** Index chunk text into OpenSearch for BM25 retrieval; returns how many. */
export async function indexChunks(deps: IngestionDeps, documentId: string): Promise<number> {
  const chunks = await getChunksByDocument(deps.db, documentId);
  await deps.search.ensureIndex(CHUNK_INDEX);
  await deps.search.indexChunks(
    CHUNK_INDEX,
    chunks.map((chunk) => ({ id: chunk.id, documentId, text: chunk.text })),
    { refresh: true },
  );
  return chunks.length;
}
