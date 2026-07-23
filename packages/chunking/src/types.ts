/**
 * The chunking boundary. Ingestion selects a Chunker by document source type
 * and turns an extracted document into ChunkCandidates. Strategies are
 * interchangeable behind the Chunker interface.
 *
 * Chunk identity is derived from stable source identity + content, NOT from a
 * global ordinal — so editing one part of a document does not shift the
 * identity of unrelated chunks and force needless re-embedding.
 */

/** A document after text extraction, ready for chunking. */
export interface ExtractedDocument {
  /** Evidence source type (e.g. 'product_doc', 'interview'); drives strategy selection. */
  sourceType: string;
  text: string;
}

export interface ChunkingOptions {
  /** Target maximum tokens per chunk. */
  maxTokens: number;
  /** Tokens of overlap between adjacent chunks (token-window strategy). */
  overlapTokens: number;
}

export interface ChunkCandidate {
  text: string;
  tokenCount: number;
  /** Ordering / display position only — NOT identity. */
  ord: number;
  /**
   * Stable identity within the document, independent of ordinal position
   * (e.g. a heading path, a message id, a row key, or a window index).
   */
  sourceKey: string;
  /** Hash of the normalized text; a change here means the chunk must re-embed. */
  contentHash: string;
  /** Character offsets into the source text, when known. */
  offsets?: { start: number; end: number };
  /** Structural context, e.g. the heading path leading to this chunk. */
  hierarchy?: string[];
  /** Strategy-specific extras (speaker, ticket id, row keys, …). */
  metadata?: Record<string, unknown>;
}

export interface Chunker {
  readonly name: string;
  readonly version: string;
  chunk(document: ExtractedDocument, options: ChunkingOptions): Promise<ChunkCandidate[]>;
}

/** Counts tokens for a piece of text. Injectable so chunking stays offline. */
export interface TokenCounter {
  count(text: string): number;
}

export interface ChunkerRegistry {
  /** Returns the chunker for a source type, falling back to token-window. */
  get(sourceType: string): Chunker;
}

export const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  maxTokens: 512,
  overlapTokens: 64,
};
