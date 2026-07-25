/**
 * Resolves labeled judgments to live chunk ids, runs all requested arms over
 * a labeled query set, and aggregates the 4 metrics per config.
 */
import {
  findEvidenceDocumentByTitle,
  getChunksByDocument,
  type Chunk,
  type Database,
  type EvalJudgment,
  type EvalQueryWithJudgments,
} from '@threadmark/db';
import { ndcgAtK, precisionAtK, recallAtK, reciprocalRank } from './metrics.js';
import { runArm, type ArmDeps, type ArmName } from './arms.js';

/**
 * Resolves each judgment's (docId, chunkSourceKey) natural key to the real,
 * currently-live chunk uuid for `workspaceId`, building a relevance map keyed
 * by chunk id that the metrics functions can score `runArm`'s output against.
 * A judgment that can't resolve (doc never seeded, or sourceKey no longer
 * matches any chunk — e.g. after a corpus edit) is silently excluded, not
 * thrown — matching this codebase's established "defensive, not throw"
 * convention (e.g. retriever.ts drops unknown reranker ids rather than
 * crashing). Re-resolves fresh on every call — no caching, so it can never
 * see stale doc/chunk state within or across runs.
 */
export async function resolveRelevanceMap(
  db: Database,
  workspaceId: string,
  judgments: EvalJudgment[],
): Promise<Map<string, number>> {
  const relevanceById = new Map<string, number>();
  const docIds = [...new Set(judgments.map((j) => j.docId))];
  const chunksByDocId = new Map<string, Chunk[]>();
  for (const docId of docIds) {
    const doc = await findEvidenceDocumentByTitle(db, workspaceId, docId);
    if (!doc) continue;
    chunksByDocId.set(docId, await getChunksByDocument(db, doc.id));
  }
  for (const judgment of judgments) {
    const chunk = chunksByDocId
      .get(judgment.docId)
      ?.find((c) => c.sourceKey === judgment.chunkSourceKey);
    if (!chunk) continue;
    relevanceById.set(chunk.id, judgment.relevance);
  }
  return relevanceById;
}

export interface QueryScore {
  externalId: string;
  precisionAtK: number;
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
}

export interface ArmMeans {
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
  ndcgAtK: number;
}

export interface ArmResult {
  configName: ArmName;
  mean: ArmMeans;
  perQuery: QueryScore[];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function computeMean(perQuery: QueryScore[]): ArmMeans {
  return {
    precisionAtK: average(perQuery.map((q) => q.precisionAtK)),
    recallAtK: average(perQuery.map((q) => q.recallAtK)),
    mrr: average(perQuery.map((q) => q.reciprocalRank)),
    ndcgAtK: average(perQuery.map((q) => q.ndcgAtK)),
  };
}

/**
 * Runs every `configNames` arm over every query in `queries`, scoring each
 * against its own labeled judgments. A query whose arm computation throws
 * (e.g. a transient rerank error) is skipped — logged, not fatal — and the
 * run continues with the rest: this is a human-driven tuning tool, not a
 * production request path, so one flaky query shouldn't discard every other
 * valid score in the same run.
 */
export async function runEval(
  armDeps: ArmDeps,
  workspaceId: string,
  queries: EvalQueryWithJudgments[],
  configNames: ArmName[],
  topK: number,
  candidateK: number,
): Promise<ArmResult[]> {
  const results: ArmResult[] = [];
  for (const configName of configNames) {
    const perQuery: QueryScore[] = [];
    for (const { query, judgments } of queries) {
      try {
        const rankedIds = await runArm(
          configName,
          armDeps,
          query.queryText,
          workspaceId,
          topK,
          candidateK,
        );
        const relevanceById = await resolveRelevanceMap(armDeps.db, workspaceId, judgments);
        perQuery.push({
          externalId: query.externalId,
          precisionAtK: precisionAtK(rankedIds, relevanceById, topK),
          recallAtK: recallAtK(rankedIds, relevanceById, topK),
          reciprocalRank: reciprocalRank(rankedIds, relevanceById),
          ndcgAtK: ndcgAtK(rankedIds, relevanceById, topK),
        });
      } catch (error) {
        console.warn(
          `[evals] skipping query "${query.externalId}" for config "${configName}":`,
          error,
        );
      }
    }
    results.push({ configName, mean: computeMean(perQuery), perQuery });
  }
  return results;
}
