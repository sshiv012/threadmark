/**
 * @threadmark/search — lexical (BM25) index boundary. `OpenSearchIndex` for
 * real use; `InMemorySearchIndex` for tests. Retrieval (PR6) builds hybrid
 * search on top of this.
 */
export * from './types.js';
export * from './in-memory.js';
export * from './opensearch.js';

export const PACKAGE_NAME = '@threadmark/search';
