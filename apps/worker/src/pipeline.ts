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
  deleteChunksNotIn,
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

  const blob = await deps.blob.get(blobKeyFromUri(document.blobUri));
  // Prefer the blob's stored content type; titles may be renamed/extensionless.
  const contentType = blob.contentType ?? inferContentType(document.title);
  const text = extractText(blob.bytes, contentType);

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
  // Reconcile: drop chunks whose source section was removed since last ingest.
  await deleteChunksNotIn(
    deps.db,
    documentId,
    candidates.map((c) => c.sourceKey),
  );
  return candidates.length;
}

/** Max chunks per embedding model call — bounds memory + activity duration. */
const EMBED_BATCH_SIZE = 64;

/**
 * Embed chunks that are missing a vector OR whose stored embedding was produced
 * by a different model than the currently-configured one (so a model upgrade
 * re-embeds rather than mixing vector generations). Processed in bounded batches.
 */
export async function embedChunks(deps: IngestionDeps, documentId: string): Promise<number> {
  const model = deps.router.providers.embedding.model;
  const chunks = await getChunksByDocument(deps.db, documentId);
  const pending = chunks.filter(
    (chunk) => chunk.embedding === null || chunk.embeddingModel !== model,
  );
  if (pending.length === 0) return 0;

  for (let start = 0; start < pending.length; start += EMBED_BATCH_SIZE) {
    const batch = pending.slice(start, start + EMBED_BATCH_SIZE);
    const { vectors, model: usedModel } = await deps.router.embed({
      input: batch.map((c) => c.text),
    });
    for (let i = 0; i < batch.length; i++) {
      await setChunkEmbedding(deps.db, batch[i]!.id, vectors[i]!, usedModel);
    }
  }
  return pending.length;
}

/** Replace this document's OpenSearch entries with its current chunks. */
export async function indexChunks(deps: IngestionDeps, documentId: string): Promise<number> {
  const chunks = await getChunksByDocument(deps.db, documentId);
  await deps.search.ensureIndex(CHUNK_INDEX);
  // Delete-then-index so chunk ids removed/renamed since last ingest don't
  // linger as searchable entries.
  await deps.search.deleteByDocument(CHUNK_INDEX, documentId);
  await deps.search.indexChunks(
    CHUNK_INDEX,
    chunks.map((chunk) => ({ id: chunk.id, documentId, text: chunk.text })),
    { refresh: true },
  );
  return chunks.length;
}
