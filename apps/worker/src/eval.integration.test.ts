/**
 * Eval regression-guard suite — opt-in and heavy, exercises REAL Postgres,
 * OpenSearch, and the REAL local embedding + reranker models against the
 * dedicated eval-corpus workspace. Requires that workspace to already be
 * seeded (`pnpm eval:seed`); this suite does not seed it itself, so a missing
 * workspace fails loudly with a clear next step rather than silently
 * creating an empty one.
 *
 *   pnpm infra:up && pnpm --filter @threadmark/db db:migrate
 *   pnpm eval:seed
 *   pnpm test:eval                              # from repo root, or:
 *   pnpm --filter @threadmark/worker test:eval
 *
 * NOTE: real embedding/rerank calls routinely take 6-12s locally, and this
 * suite scores the FULL labeled set (23 queries) across all 4 configs in one
 * test — the test:eval scripts bake in `--testTimeout=300000` (5 min) —
 * always run it that way, not a bare `vitest run`.
 */
import {
  createDb,
  createEvalReport,
  findWorkspaceByName,
  listEvalQueriesWithJudgments,
  type Database,
} from '@threadmark/db';
import { runEval, type ArmDeps, type ArmName } from '@threadmark/evals';
import { createModelRouter, loadModelRouterConfig } from '@threadmark/model-router';
import { createRetriever, type Retriever } from '@threadmark/retrieval';
import { OpenSearchIndex } from '@threadmark/search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from './env.js';
import { EVAL_WORKSPACE_NAME } from './shared.js';

const runEvalIntegration = process.env.RUN_EVAL_INTEGRATION === '1';
const CONFIG_NAMES: ArmName[] = [
  'lexical_only',
  'vector_only',
  'hybrid_no_rerank',
  'hybrid_rerank',
];
const TOP_K = 8;
const CANDIDATE_K = 30;

describe.skipIf(!runEvalIntegration)('eval integration (real services, real models)', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let armDeps: ArmDeps;
  let workspaceId: string;

  beforeAll(async () => {
    const conn = createDb(env.databaseUrl);
    db = conn.db;
    closeDb = conn.close;

    const search = new OpenSearchIndex({ node: env.opensearchNode });
    const router = createModelRouter(loadModelRouterConfig(process.env));
    const retriever: Retriever = createRetriever({ db, search, router });
    armDeps = { db, search, router, retriever };

    const workspace = await findWorkspaceByName(db, EVAL_WORKSPACE_NAME);
    if (!workspace) {
      throw new Error(
        `Eval corpus workspace "${EVAL_WORKSPACE_NAME}" not found — run \`pnpm eval:seed\` first.`,
      );
    }
    workspaceId = workspace.id;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  it('hybrid+rerank does not regress below lexical-only on nDCG for the labeled set', async () => {
    const queries = await listEvalQueriesWithJudgments(db, workspaceId);
    // Sanity: the workspace exists but eval:seed's judgment-loading step
    // may not have completed — fail loudly rather than silently scoring
    // against zero queries.
    expect(queries.length).toBeGreaterThan(0);

    const results = await runEval(armDeps, workspaceId, queries, CONFIG_NAMES, TOP_K, CANDIDATE_K);

    for (const result of results) {
      await createEvalReport(db, {
        workspaceId,
        configName: result.configName,
        config: {
          topK: TOP_K,
          candidateK: CANDIDATE_K,
          embeddingModel: armDeps.router.providers.embedding.model,
          rerankModel: armDeps.router.providers.rerank.model,
        },
        metrics: result.mean,
        perQuery: result.perQuery,
      });
      console.log(
        `${result.configName}: ` +
          `precision@${TOP_K}=${result.mean.precisionAtK.toFixed(3)} ` +
          `recall@${TOP_K}=${result.mean.recallAtK.toFixed(3)} ` +
          `mrr=${result.mean.mrr.toFixed(3)} ` +
          `ndcg@${TOP_K}=${result.mean.ndcgAtK.toFixed(3)}`,
      );
    }

    const lexical = results.find((r) => r.configName === 'lexical_only')!;
    const hybridRerank = results.find((r) => r.configName === 'hybrid_rerank')!;
    expect(hybridRerank.mean.ndcgAtK).toBeGreaterThanOrEqual(lexical.mean.ndcgAtK);
  }, 300_000);
});
