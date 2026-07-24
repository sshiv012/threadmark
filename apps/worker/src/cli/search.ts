/**
 * `pnpm search "<query>"` — hybrid retrieval over the Dev Workspace corpus.
 * Runs the query twice to show the Redis cache latency win.
 *
 * Requires the local stack (`pnpm infra:up`); no worker needed.
 */
import { createDb, findOrCreateWorkspaceByName } from '@threadmark/db';
import { createModelRouter, loadModelRouterConfig } from '@threadmark/model-router';
import { RedisCache, createRetriever } from '@threadmark/retrieval';
import { OpenSearchIndex } from '@threadmark/search';
import { Redis } from 'ioredis';
import { env } from '../env.js';

async function main(): Promise<void> {
  const query = process.argv[2];
  if (!query) {
    console.error('usage: pnpm search "<query>"');
    process.exit(1);
  }

  const { db, close } = createDb(env.databaseUrl);
  const redis = new Redis(env.redisUrl);
  const retriever = createRetriever({
    db,
    search: new OpenSearchIndex({ node: env.opensearchNode }),
    router: createModelRouter(loadModelRouterConfig(process.env)),
    cache: new RedisCache(redis),
  });

  try {
    const workspace = await findOrCreateWorkspaceByName(db, 'Dev Workspace');
    const cold = await retriever.search(query, { workspaceId: workspace.id });
    const warm = await retriever.search(query, { workspaceId: workspace.id });

    console.log(`\nquery: "${query}"`);
    console.log(
      `cold: ${cold.latencyMs}ms (cached=${cold.cached})  |  warm: ${warm.latencyMs}ms (cached=${warm.cached})\n`,
    );
    cold.results.forEach((r, i) => {
      const provenance = [
        r.vectorRank ? `vec#${r.vectorRank}` : null,
        r.lexicalRank ? `bm25#${r.lexicalRank}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      console.log(
        `${String(i + 1).padStart(2)}. [${r.sourceType}] ${r.documentTitle}  (rerank ${r.rerankScore.toFixed(3)}; ${provenance})`,
      );
      console.log(`    ${r.text.replace(/\s+/g, ' ').slice(0, 140)}`);
    });
  } finally {
    await close();
    redis.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
