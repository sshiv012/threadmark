/**
 * Lexical (BM25) search boundary over OpenSearch. This is a derived index:
 * rebuildable from Postgres. Retrieval (PR6) composes hybrid search on top of
 * this plus pgvector.
 */
export interface IndexedChunk {
  /** Chunk id (matches the chunks table primary key). */
  id: string;
  documentId: string;
  text: string;
}

export interface SearchHit {
  id: string;
  score: number;
}

export interface SearchIndex {
  ensureIndex(index: string): Promise<void>;
  indexChunks(index: string, chunks: IndexedChunk[]): Promise<void>;
  searchBm25(index: string, query: string, topK: number): Promise<SearchHit[]>;
  /** Remove all chunks belonging to a document (re-ingest / delete). */
  deleteByDocument(index: string, documentId: string): Promise<void>;
}
