import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Database } from '@threadmark/db';
import * as schema from '@threadmark/db';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

let db: Database;

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-value';
  const pg = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pg, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb as unknown as Database;
});

describe('buildApp', () => {
  it('produces a usable Fastify instance via inject() with no listening port', async () => {
    const app = buildApp({ db });
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: 'not@found.test' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('maps an unexpected thrown error to a generic 500 with no stack trace or internal message', async () => {
    const brokenDb = {
      select: () => {
        throw new Error('super secret internal detail — connection string leaked here');
      },
    } as unknown as Database;
    const app = buildApp({ db: brokenDb });
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: 'someone@acme.test' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('super secret internal detail');
    expect(response.body).not.toContain('stack');
    expect(JSON.parse(response.body)).toEqual({ error: 'internal_error' });
  });
});
