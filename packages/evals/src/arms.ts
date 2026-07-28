/**
 * Composes ranked chunk-id lists for each of 4 retrieval configurations, so
 * the eval harness can compare lexical-only / vector-only / hybrid-no-rerank
 * against the REAL production hybrid+rerank path. Zero changes to
 * packages/retrieval/src/retriever.ts — everything here is built from
 * already-exported primitives (searchChunksByVector, SearchIndex.searchBm25,
 * reciprocalRankFusion) plus the real Retriever for the hybrid_rerank arm.
 */
import { getRetrievalChunksByIds, searchChunksByVector, type Database } from '@threadmark/db';
import type { ModelRouter } from '@threadmark/model-router';
import {
  CHUNK_INDEX,
  RetrievalValidationError,
  reciprocalRankFusion,
  type Retriever,
} from '@threadmark/retrieval';
import type { SearchIndex } from '@threadmark/search';

export type ArmName = 'lexical_only' | 'vector_only' | 'hybrid_no_rerank' | 'hybrid_rerank';

export interface ArmDeps {
  db: Database;
  search: SearchIndex;
  router: ModelRouter;
  /** The real production hybrid+rerank retriever — used unmodified for 'hybrid_rerank'. */
  retriever: Retriever;
  chunkIndex?: string;
}

function validateArmInput(topK: number, candidateK: number): void {
  if (!Number.isInteger(topK) || topK <= 0) {
    throw new RetrievalValidationError(`topK must be a positive integer, got ${topK}`);
  }
  if (!Number.isInteger(candidateK) || candidateK <= 0) {
    throw new RetrievalValidationError(`candidateK must be a positive integer, got ${candidateK}`);
  }
  if (topK > candidateK) {
    throw new RetrievalValidationError(`topK (${topK}) must be <= candidateK (${candidateK})`);
  }
}

/**
 * Filters `candidateIds` down to workspace + ready-status chunks (same
 * defense-in-depth hydration the real retriever applies), preserving
 * candidate order, then truncates to `topK`. `searchBm25`/`InMemorySearchIndex`
 * have no status concept of their own, so lexical-only and hybrid-no-rerank
 * need this re-check to avoid leaking a non-ready document's chunk — a real
 * gap the underlying primitives don't close on their own.
 */
async function hydrateAndSlice(
  db: Database,
  candidateIds: string[],
  workspaceId: string,
  topK: number,
): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  const rows = await getRetrievalChunksByIds(db, candidateIds, workspaceId);
  const readyIds = new Set(rows.map((r) => r.chunkId));
  return candidateIds.filter((id) => readyIds.has(id)).slice(0, topK);
}

export async function runArm(
  armName: ArmName,
  deps: ArmDeps,
  query: string,
  workspaceId: string,
  topK: number,
  candidateK: number,
): Promise<string[]> {
  validateArmInput(topK, candidateK);
  const chunkIndex = deps.chunkIndex ?? CHUNK_INDEX;

  switch (armName) {
    case 'lexical_only': {
      const hits = await deps.search.searchBm25(chunkIndex, query, candidateK, workspaceId);
      return hydrateAndSlice(
        deps.db,
        hits.map((h) => h.id),
        workspaceId,
        topK,
      );
    }
    case 'vector_only': {
      const { vectors } = await deps.router.embed({ input: [query] });
      const hits = await searchChunksByVector(deps.db, workspaceId, vectors[0]!, candidateK);
      return hits.map((h) => h.chunkId).slice(0, topK);
    }
    case 'hybrid_no_rerank': {
      const { vectors } = await deps.router.embed({ input: [query] });
      const [vectorHits, lexicalHits] = await Promise.all([
        searchChunksByVector(deps.db, workspaceId, vectors[0]!, candidateK),
        deps.search.searchBm25(chunkIndex, query, candidateK, workspaceId),
      ]);
      const fused = reciprocalRankFusion([
        vectorHits.map((h) => h.chunkId),
        lexicalHits.map((h) => h.id),
      ]);
      const candidateIds = fused.slice(0, candidateK).map((f) => f.id);
      return hydrateAndSlice(deps.db, candidateIds, workspaceId, topK);
    }
    case 'hybrid_rerank': {
      const result = await deps.retriever.search(query, { workspaceId, topK, candidateK });
      return result.results.map((r) => r.chunkId);
    }
  }
}
