import { createHash } from 'node:crypto';
import {
  getRetrievalChunksByIds,
  getWorkspaceRetrievalRevision,
  searchChunksByVector,
  type Database,
} from '@threadmark/db';
import type { ModelRouter } from '@threadmark/model-router';
import type { SearchIndex } from '@threadmark/search';
import { withSpan } from '@threadmark/telemetry';
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

/** Thrown for caller-supplied input that must never reach Postgres/OpenSearch. */
export class RetrievalValidationError extends Error {}

const MAX_TOP_K = 50;
const MAX_CANDIDATE_K = 200;

function validatePositiveInt(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RetrievalValidationError(`${name} must be a positive integer, got ${value}`);
  }
  if (value > max) {
    throw new RetrievalValidationError(`${name} exceeds the maximum of ${max}, got ${value}`);
  }
}

/** Validate and default the search inputs. Throws RetrievalValidationError. */
function validateSearchInput(
  query: string,
  options: HybridSearchOptions,
): { topK: number; candidateK: number } {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new RetrievalValidationError('query must be a non-empty, non-whitespace string');
  }
  if (typeof options.workspaceId !== 'string' || options.workspaceId.trim() === '') {
    throw new RetrievalValidationError('workspaceId is required');
  }
  const topK = options.topK ?? 8;
  const candidateK = options.candidateK ?? 30;
  validatePositiveInt('topK', topK, MAX_TOP_K);
  validatePositiveInt('candidateK', candidateK, MAX_CANDIDATE_K);
  if (topK > candidateK) {
    throw new RetrievalValidationError(`topK (${topK}) must be <= candidateK (${candidateK})`);
  }
  return { topK, candidateK };
}

/**
 * Bump when retrieval logic changes in a way that would make an old cached
 * result wrong under unchanged models (e.g. the RRF algorithm, the candidate
 * generation strategy). Model changes are captured separately via
 * embeddingModel/rerankModel below — this is for everything else.
 */
const RETRIEVAL_CONFIG_VERSION = 1;

/**
 * Cache key incorporates the embedding + reranker model identifiers (so a
 * model upgrade invalidates old entries) and the workspace's retrieval
 * revision (so ingestion — a document added/removed/reaching ready — also
 * invalidates old entries, instead of serving stale results for a corpus that
 * has since changed shape).
 */
function cacheKey(
  query: string,
  workspaceId: string,
  topK: number,
  candidateK: number,
  embeddingModel: string,
  rerankModel: string,
  corpusRevision: string,
): string {
  return createHash('sha256')
    .update(
      `v${RETRIEVAL_CONFIG_VERSION}|${query}|${workspaceId}|${topK}|${candidateK}|${embeddingModel}|${rerankModel}|${corpusRevision}`,
    )
    .digest('hex')
    .slice(0, 32);
}

export function createRetriever(deps: RetrieverDeps): Retriever {
  const cache = deps.cache ?? new NoopCache();
  const chunkIndex = deps.chunkIndex ?? CHUNK_INDEX;

  return {
    search(query, options) {
      return withSpan(
        'retrieval.search',
        { 'retrieval.workspace_id': options.workspaceId ?? '' },
        async (span) => {
          const { topK, candidateK } = validateSearchInput(query, options);
          span?.setAttribute('retrieval.top_k', topK);
          span?.setAttribute('retrieval.candidate_k', candidateK);

          const start = Date.now();
          const corpusRevision = await getWorkspaceRetrievalRevision(deps.db, options.workspaceId);
          const key = cacheKey(
            query,
            options.workspaceId,
            topK,
            candidateK,
            deps.router.providers.embedding.model,
            deps.router.providers.rerank.model,
            corpusRevision,
          );

          const hit = await cache.get(key);
          if (hit) {
            const latencyMs = Date.now() - start;
            span?.setAttribute('retrieval.cached', true);
            span?.setAttribute('retrieval.result_count', hit.length);
            span?.setAttribute('retrieval.latency_ms', latencyMs);
            return { query, results: hit, cached: true, latencyMs };
          }

          // Hybrid candidate generation: dense (pgvector) + lexical (BM25). Both
          // MUST be scoped to the caller's workspace — this is the boundary that
          // prevents one workspace's evidence leaking into another's results.
          const { vectors } = await deps.router.embed({ input: [query] });
          const [vectorHits, lexicalHits] = await Promise.all([
            searchChunksByVector(deps.db, options.workspaceId, vectors[0]!, candidateK),
            deps.search.searchBm25(chunkIndex, query, candidateK, options.workspaceId),
          ]);

          const vectorIds = vectorHits.map((h) => h.chunkId);
          const lexicalIds = lexicalHits.map((h) => h.id);
          const fused = reciprocalRankFusion([vectorIds, lexicalIds]);
          const candidateIds = fused.slice(0, candidateK).map((f) => f.id);
          if (candidateIds.length === 0) {
            // Cache the negative result too — a "no matches" answer is just as
            // valid to reuse as a positive one, and skipping it meant every repeat
            // of a no-hit query recomputed from scratch.
            await cache.set(key, []);
            const latencyMs = Date.now() - start;
            span?.setAttribute('retrieval.cached', false);
            span?.setAttribute('retrieval.result_count', 0);
            span?.setAttribute('retrieval.latency_ms', latencyMs);
            return { query, results: [], cached: false, latencyMs };
          }

          // Defense in depth: even if a candidate id leaked from another workspace,
          // hydration re-checks workspace + ready-status and drops it silently.
          const rows = await getRetrievalChunksByIds(deps.db, candidateIds, options.workspaceId);
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

          // Defensive against a misbehaving RerankProvider: an id it returns that
          // we never sent (unknown/hallucinated) is dropped rather than crashing;
          // a repeated id is deduped, keeping only its first (best-ranked) entry.
          const results: RetrievedChunk[] = [];
          const seenResultIds = new Set<string>();
          for (const r of reranked.results) {
            if (seenResultIds.has(r.id)) continue;
            const row = byId.get(r.id);
            if (!row) continue;
            seenResultIds.add(r.id);
            results.push({
              chunkId: row.chunkId,
              documentId: row.documentId,
              documentTitle: row.documentTitle,
              sourceType: row.sourceType,
              text: row.text,
              rerankScore: r.score,
              ...(vectorRank.has(r.id) ? { vectorRank: vectorRank.get(r.id)! } : {}),
              ...(lexicalRank.has(r.id) ? { lexicalRank: lexicalRank.get(r.id)! } : {}),
            });
          }

          await cache.set(key, results);
          const latencyMs = Date.now() - start;
          span?.setAttribute('retrieval.cached', false);
          span?.setAttribute('retrieval.result_count', results.length);
          span?.setAttribute('retrieval.latency_ms', latencyMs);
          return { query, results, cached: false, latencyMs };
        },
      );
    },
  };
}
