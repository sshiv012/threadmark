import type { EvidenceSourceType } from '@threadmark/db';

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sourceType: EvidenceSourceType;
  text: string;
  /** Cross-encoder relevance score from the reranker. */
  rerankScore: number;
  /** 1-based rank in the vector list (undefined if it wasn't a vector hit). */
  vectorRank?: number;
  /** 1-based rank in the BM25 list (undefined if it wasn't a lexical hit). */
  lexicalRank?: number;
}

export interface RetrievalResult {
  query: string;
  results: RetrievedChunk[];
  cached: boolean;
  latencyMs: number;
}

export interface HybridSearchOptions {
  workspaceId: string;
  /** Final number of results after reranking. */
  topK?: number;
  /** Candidates pulled from each retriever before fusion/rerank. */
  candidateK?: number;
}

export interface RetrievalCache {
  get(key: string): Promise<RetrievedChunk[] | null>;
  set(key: string, value: RetrievedChunk[]): Promise<void>;
}
