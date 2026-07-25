/**
 * Lexical (BM25) search boundary over OpenSearch. This is a derived index:
 * rebuildable from Postgres. Retrieval (PR6) composes hybrid search on top of
 * this plus pgvector.
 */
export interface IndexedChunk {
  /** Chunk id (matches the chunks table primary key). */
  id: string;
  documentId: string;
  /** Owning workspace — indexed and required at query time to prevent cross-workspace leaks. */
  workspaceId: string;
  text: string;
}

export interface SearchHit {
  id: string;
  score: number;
}

export interface IndexOptions {
  /**
   * Force an index refresh so writes are immediately searchable. Defaults to
   * false — refreshing after every batch throttles indexing throughput; enable
   * it only when you need read-after-write (e.g. tests).
   */
  refresh?: boolean;
}

export interface SearchIndex {
  ensureIndex(index: string): Promise<void>;
  indexChunks(index: string, chunks: IndexedChunk[], options?: IndexOptions): Promise<void>;
  /**
   * workspaceId is REQUIRED and must be enforced as a filter by every
   * implementation — never rely on the caller re-checking results. This is the
   * hard boundary that prevents one workspace's evidence leaking into another's
   * search results.
   */
  searchBm25(index: string, query: string, topK: number, workspaceId: string): Promise<SearchHit[]>;
  /** Remove all chunks belonging to a document (re-ingest / delete). */
  deleteByDocument(index: string, documentId: string): Promise<void>;
}
