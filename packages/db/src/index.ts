/**
 * @threadmark/db — Drizzle schema, migrations, and repositories over
 * Postgres + pgvector. Postgres is the system of record; OpenSearch and the
 * pgvector index are derived and rebuildable.
 */
export * from './schema.js';
export * from './client.js';
export * from './repositories.js';

export const PACKAGE_NAME = '@threadmark/db';
