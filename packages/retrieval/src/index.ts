/**
 * @threadmark/retrieval — hybrid retrieval: dense (pgvector) + lexical
 * (OpenSearch BM25) candidate generation, Reciprocal Rank Fusion, then
 * cross-encoder reranking, with an optional Redis cache.
 */
export * from './types.js';
export * from './rrf.js';
export * from './cache.js';
export * from './retriever.js';

export const PACKAGE_NAME = '@threadmark/retrieval';
