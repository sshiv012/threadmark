import { Client } from '@opensearch-project/opensearch';
import type { IndexedChunk, SearchHit, SearchIndex } from './types.js';

export interface OpenSearchIndexOptions {
  /** e.g. http://localhost:9200 */
  node: string;
}

interface SearchResponseBody {
  hits: { hits: Array<{ _id?: string; _score?: number | null }> };
}

/** OpenSearch-backed lexical index (security-disabled local dev / real cluster). */
export class OpenSearchIndex implements SearchIndex {
  private readonly client: Client;

  constructor(options: OpenSearchIndexOptions) {
    this.client = new Client({ node: options.node });
  }

  async ensureIndex(index: string): Promise<void> {
    const exists = await this.client.indices.exists({ index });
    if (!exists.body) {
      await this.client.indices.create({
        index,
        body: {
          mappings: {
            properties: {
              documentId: { type: 'keyword' },
              text: { type: 'text' },
            },
          },
        },
      });
    }
  }

  async indexChunks(index: string, chunks: IndexedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const body = chunks.flatMap((chunk) => [
      { index: { _index: index, _id: chunk.id } },
      { documentId: chunk.documentId, text: chunk.text },
    ]);
    await this.client.bulk({ body, refresh: true });
  }

  async searchBm25(index: string, query: string, topK: number): Promise<SearchHit[]> {
    const response = await this.client.search({
      index,
      body: { size: topK, query: { match: { text: query } } },
    });
    const hits = (response.body as SearchResponseBody).hits.hits;
    return hits.map((hit) => ({ id: String(hit._id), score: hit._score ?? 0 }));
  }

  async deleteByDocument(index: string, documentId: string): Promise<void> {
    await this.client.deleteByQuery({
      index,
      body: { query: { term: { documentId } } },
      refresh: true,
    });
  }
}
