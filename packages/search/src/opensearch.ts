import { Client } from '@opensearch-project/opensearch';
import type { IndexedChunk, IndexOptions, SearchHit, SearchIndex } from './types.js';

export interface OpenSearchIndexOptions {
  /** e.g. http://localhost:9200 */
  node?: string;
  /** Pre-built client (used by tests to inject a fake). */
  client?: Client;
}

interface SearchResponseBody {
  hits: { hits: Array<{ _id?: string; _score?: number | null }> };
}

interface BulkResponseBody {
  errors: boolean;
  items: Array<{ index?: { _id?: string; error?: unknown } }>;
}

/** OpenSearch-backed lexical index (security-disabled local dev / real cluster). */
export class OpenSearchIndex implements SearchIndex {
  private readonly client: Client;

  constructor(options: OpenSearchIndexOptions) {
    this.client = options.client ?? new Client({ node: options.node ?? 'http://localhost:9200' });
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

  async indexChunks(
    index: string,
    chunks: IndexedChunk[],
    options: IndexOptions = {},
  ): Promise<void> {
    if (chunks.length === 0) return;
    const body = chunks.flatMap((chunk) => [
      { index: { _index: index, _id: chunk.id } },
      { documentId: chunk.documentId, text: chunk.text },
    ]);
    // refresh defaults to false — forcing a refresh per batch throttles throughput.
    const response = await this.client.bulk({ body, refresh: options.refresh ?? false });

    // Bulk can return HTTP 200 with per-item failures; surface them so the
    // caller (Temporal activity) fails and retries rather than silently
    // marking a document indexed with missing chunks.
    const result = response.body as BulkResponseBody;
    if (result.errors) {
      const failed = result.items
        .filter((item) => item.index?.error)
        .map((item) => item.index?._id ?? '<unknown>');
      throw new Error(
        `OpenSearch bulk indexing failed for ${failed.length} chunk(s): ${failed.join(', ')}`,
      );
    }
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
