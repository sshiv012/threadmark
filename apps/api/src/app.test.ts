import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Database } from '@threadmark/db';
import * as schema from '@threadmark/db';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

let db: Database;
let pglite: PGlite;

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-value';
  pglite = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pglite, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb as unknown as Database;
});

// Each test spins up a fresh in-process Postgres; without closing it, a full
// suite run accumulates open PGlite instances across every it() block and
// every test file, which was timing out CI (each instance holds real
// memory/file-descriptor-like resources even though it's in-process).
afterEach(async () => {
  await pglite.close();
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
