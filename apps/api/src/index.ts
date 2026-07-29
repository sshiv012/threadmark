/**
 * @threadmark/api — Fastify HTTP/JSON API. Auth, authorization, request
 * validation (Zod), starting/signaling Temporal workflows, and serving reads.
 * Owns no long-running logic.
 *
 * Run (after build): `node --env-file=.env apps/api/dist/index.js`
 */
import { createDb } from '@threadmark/db';
import { createModelRouter, loadModelRouterConfig } from '@threadmark/model-router';
import { RedisCache, createRetriever } from '@threadmark/retrieval';
import { OpenSearchIndex } from '@threadmark/search';
import { initTelemetry } from '@threadmark/telemetry';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { env } from './env.js';

export const APP_NAME = '@threadmark/api';

async function main(): Promise<void> {
  const shutdownTelemetry = initTelemetry('threadmark-api');
  const { db, close } = createDb(env.databaseUrl);
  const redis = new Redis(env.redisUrl);
  const retriever = createRetriever({
    db,
    search: new OpenSearchIndex({ node: env.opensearchNode }),
    router: createModelRouter(loadModelRouterConfig(process.env)),
    cache: new RedisCache(redis),
  });
  const app = buildApp({ db, retriever });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await close();
    redis.disconnect();
    await shutdownTelemetry();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen({ port: 3001, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
