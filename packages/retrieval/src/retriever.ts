import { createHash } from 'node:crypto';
import { getRetrievalChunksByIds, searchChunksByVector, type Database } from '@threadmark/db';
import type { ModelRouter } from '@threadmark/model-router';
import type { SearchIndex } from '@threadmark/search';
import { NoopCache } from './cache.js';
import { reciprocalRankFusion } from './rrf.js';
import type {
  HybridSearchOptions,
  RetrievalCache,
  RetrievalResult,
  RetrievedChunk,
} from './types.js';

/** Must match the index the ingestion pipeline writes to. */
export const CHUNK_INDEX = 'threadmark-chunks';

export interface RetrieverDeps {
  db: Database;
  search: SearchIndex;
  router: ModelRouter;
  cache?: RetrievalCache;
  chunkIndex?: string;
}

export interface Retriever {
  search(query: string, options: HybridSearchOptions): Promise<RetrievalResult>;
}

function cacheKey(query: string, workspaceId: string, topK: number, candidateK: number): string {
  return createHash('sha256')
    .update(`${query}|${workspaceId}|${topK}|${candidateK}`)
    .digest('hex')
    .slice(0, 32);
}

export function createRetriever(deps: RetrieverDeps): Retriever {
  const cache = deps.cache ?? new NoopCache();
  const chunkIndex = deps.chunkIndex ?? CHUNK_INDEX;

  return {
    async search(query, options) {
      const topK = options.topK ?? 8;
      const candidateK = options.candidateK ?? 30;
      const key = cacheKey(query, options.workspaceId, topK, candidateK);
      const start = Date.now();

      const hit = await cache.get(key);
      if (hit) {
        return { query, results: hit, cached: true, latencyMs: Date.now() - start };
      }

      // Hybrid candidate generation: dense (pgvector) + lexical (BM25).
      const { vectors } = await deps.router.embed({ input: [query] });
      const [vectorHits, lexicalHits] = await Promise.all([
        searchChunksByVector(deps.db, options.workspaceId, vectors[0]!, candidateK),
        deps.search.searchBm25(chunkIndex, query, candidateK),
      ]);

      const vectorIds = vectorHits.map((h) => h.chunkId);
      const lexicalIds = lexicalHits.map((h) => h.id);
      const fused = reciprocalRankFusion([vectorIds, lexicalIds]);
      const candidateIds = fused.slice(0, candidateK).map((f) => f.id);
      if (candidateIds.length === 0) {
        return { query, results: [], cached: false, latencyMs: Date.now() - start };
      }

      const rows = await getRetrievalChunksByIds(deps.db, candidateIds);
      const byId = new Map(rows.map((r) => [r.chunkId, r]));
      const vectorRank = new Map(vectorIds.map((id, i) => [id, i + 1]));
      const lexicalRank = new Map(lexicalIds.map((id, i) => [id, i + 1]));

      // Rerank the fused candidates with the cross-encoder; it decides final order.
      const reranked = await deps.router.rerank({
        query,
        documents: candidateIds
          .filter((id) => byId.has(id))
          .map((id) => ({ id, text: byId.get(id)!.text })),
        topK,
      });

      const results: RetrievedChunk[] = reranked.results.map((r) => {
        const row = byId.get(r.id)!;
        return {
          chunkId: row.chunkId,
          documentId: row.documentId,
          documentTitle: row.documentTitle,
          sourceType: row.sourceType,
          text: row.text,
          rerankScore: r.score,
          ...(vectorRank.has(r.id) ? { vectorRank: vectorRank.get(r.id)! } : {}),
          ...(lexicalRank.has(r.id) ? { lexicalRank: lexicalRank.get(r.id)! } : {}),
        };
      });

      await cache.set(key, results);
      return { query, results, cached: false, latencyMs: Date.now() - start };
    },
  };
}
