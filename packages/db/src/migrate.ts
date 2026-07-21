/**
 * Apply pending migrations against a real Postgres (postgres.js driver).
 *
 * Run from the repo root or the package dir:
 *   node --env-file=../../.env src/migrate.ts
 *
 * DATABASE_URL must point at a Postgres with the pgvector extension available
 * (the local stack enables it via infra/docker/postgres/init).
 */
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to run migrations');
}

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const client = postgres(url, { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder });
  console.log('✓ migrations applied');
} finally {
  await client.end();
}
