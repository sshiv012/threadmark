import { createDb, type Database } from '@threadmark/db';
import { createModelRouter, loadModelRouterConfig } from '@threadmark/model-router';
import { RedisCache, createRetriever, type Retriever } from '@threadmark/retrieval';
import { OpenSearchIndex } from '@threadmark/search';
import { Redis } from 'ioredis';
import { env } from './env';

// Lazily-created singletons so `next build` doesn't open connections/models.
let dbHandle: Database | undefined;
let retrieverHandle: Retriever | undefined;

export function getDb(): Database {
  dbHandle ??= createDb(env.databaseUrl).db;
  return dbHandle;
}

export function getRetriever(): Retriever {
  retrieverHandle ??= createRetriever({
    db: getDb(),
    search: new OpenSearchIndex({ node: env.opensearchNode }),
    router: createModelRouter(loadModelRouterConfig(process.env)),
    cache: new RedisCache(new Redis(env.redisUrl)),
  });
  return retrieverHandle;
}
