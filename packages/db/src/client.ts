/**
 * Database client + a driver-agnostic `Database` type.
 *
 * Production/dev uses the postgres.js driver (`createDb`). Tests use the
 * in-process pglite driver. Both produce a drizzle instance assignable to
 * `Database`, so repositories are written once against that type.
 */
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Schema = typeof schema;

/** Driver-agnostic drizzle handle bound to the Threadmark schema. */
export type Database = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export interface DbConnection {
  db: Database;
  /** Underlying postgres.js client; call `close()` to release the pool. */
  close: () => Promise<void>;
}

/** Create a postgres.js-backed connection. */
export function createDb(connectionString: string): DbConnection {
  const client = postgres(connectionString, { max: 10 });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}
