import type { IndexedChunk, SearchHit, SearchIndex } from './types.js';

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * In-memory SearchIndex for tests / offline unit tests of downstream code.
 * Scores by query-term overlap — a test double, NOT real BM25; real ranking is
 * validated against OpenSearch in the integration test and in eval (PR7).
 */
export class InMemorySearchIndex implements SearchIndex {
  private readonly indices = new Map<string, Map<string, IndexedChunk>>();

  private index(name: string): Map<string, IndexedChunk> {
    let map = this.indices.get(name);
    if (!map) {
      map = new Map();
      this.indices.set(name, map);
    }
    return map;
  }

  ensureIndex(index: string): Promise<void> {
    this.index(index);
    return Promise.resolve();
  }

  indexChunks(index: string, chunks: IndexedChunk[]): Promise<void> {
    const map = this.index(index);
    for (const chunk of chunks) map.set(chunk.id, chunk);
    return Promise.resolve();
  }

  searchBm25(index: string, query: string, topK: number): Promise<SearchHit[]> {
    const queryTerms = new Set(tokenize(query));
    const hits: SearchHit[] = [];
    for (const chunk of this.index(index).values()) {
      let score = 0;
      for (const term of tokenize(chunk.text)) if (queryTerms.has(term)) score++;
      if (score > 0) hits.push({ id: chunk.id, score });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return Promise.resolve(hits.slice(0, topK));
  }

  deleteByDocument(index: string, documentId: string): Promise<void> {
    const map = this.index(index);
    for (const [id, chunk] of map) if (chunk.documentId === documentId) map.delete(id);
    return Promise.resolve();
  }
}
