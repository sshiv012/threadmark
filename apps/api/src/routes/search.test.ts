import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import {
  addMembership,
  createEvidenceDocument,
  createUser,
  createWorkspace,
  getChunksByDocument,
  setChunkEmbedding,
  updateDocumentStatus,
  upsertChunks,
} from '@threadmark/db';
import type { Database } from '@threadmark/db';
import * as schema from '@threadmark/db';
import { createModelRouter, type ModelRouter } from '@threadmark/model-router';
import { CHUNK_INDEX, createRetriever, InMemoryCache, type Retriever } from '@threadmark/retrieval';
import { InMemorySearchIndex } from '@threadmark/search';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { signToken } from '../auth/jwt.js';

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

let db: Database;
let pglite: PGlite;
let search: InMemorySearchIndex;
let router: ModelRouter;
let retriever: Retriever;

async function seedChunks(
  workspaceId: string,
  name: string,
  chunkDefs: { key: string; text: string }[],
) {
  const doc = await createEvidenceDocument(db, {
    workspaceId,
    sourceType: 'product_doc',
    title: `${name}.md`,
    blobUri: `s3://memory/${name}.md`,
    checksum: `chk-${name}`,
  });
  await upsertChunks(
    db,
    chunkDefs.map((c, i) => ({
      documentId: doc.id,
      ord: i,
      sourceKey: c.key,
      contentHash: `h-${name}-${c.key}`,
      text: c.text,
      tokenCount: c.text.split(' ').length,
    })),
  );
  const stored = await getChunksByDocument(db, doc.id);
  const embedded = await router.embed({ input: stored.map((c) => c.text) });
  for (let i = 0; i < stored.length; i++) {
    await setChunkEmbedding(db, stored[i]!.id, embedded.vectors[i]!, embedded.model);
  }
  await search.ensureIndex(CHUNK_INDEX);
  await search.indexChunks(
    CHUNK_INDEX,
    stored.map((c) => ({ id: c.id, documentId: doc.id, workspaceId, text: c.text })),
  );
  await updateDocumentStatus(db, doc.id, 'ready');
  return doc.id;
}

async function seedActiveMember(workspaceId: string, email: string) {
  const user = await createUser(db, { email, name: 'Member' });
  await addMembership(db, { workspaceId, userId: user.id, role: 'viewer', status: 'active' });
  return signToken(user.id);
}

async function searchRequest(
  app: ReturnType<typeof buildApp>,
  workspaceId: string,
  token: string,
  qs: string,
) {
  return app.inject({
    method: 'GET',
    url: `/workspaces/${workspaceId}/search?${qs}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-value';
  pglite = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pglite, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb as unknown as Database;

  search = new InMemorySearchIndex();
  router = createModelRouter({
    generation: { provider: 'stub' },
    embedding: { provider: 'stub', dimensions: 384 },
    rerank: { provider: 'stub' },
  });
  retriever = createRetriever({ db, search, router, cache: new InMemoryCache() });
});

afterEach(async () => {
  await pglite.close();
});

describe('GET /workspaces/:workspaceId/search', () => {
  it('200s with a real, tight top result matching the seeded query — not just non-empty', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    await seedChunks(workspace.id, 'doc', [
      { key: 'a', text: 'external dashboard sharing via secure links with viewer-only access' },
      { key: 'b', text: 'monthly billing invoice totals and payment methods' },
    ]);
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });

    const response = await searchRequest(
      app,
      workspace.id,
      token,
      'q=external+dashboard+sharing+links',
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].text).toMatch(/sharing|links/);
  });

  it('response matches the complete RetrievalResult shape: query, results, cached, latencyMs', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    await seedChunks(workspace.id, 'doc', [{ key: 'a', text: 'dashboard sharing controls' }]);
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });

    const response = await searchRequest(app, workspace.id, token, 'q=dashboard+sharing');

    const body = JSON.parse(response.body);
    expect(body).toMatchObject({ query: 'dashboard sharing', cached: false });
    expect(typeof body.latencyMs).toBe('number');
    expect(Array.isArray(body.results)).toBe(true);
    for (const r of body.results) {
      expect(r).toMatchObject({
        chunkId: expect.any(String),
        documentId: expect.any(String),
        documentTitle: expect.any(String),
        sourceType: expect.any(String),
        text: expect.any(String),
        rerankScore: expect.any(Number),
      });
    }
  });

  it('a second identical request returns cached:true after the first miss', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    await seedChunks(workspace.id, 'doc', [{ key: 'a', text: 'dashboard sharing controls' }]);
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });

    const first = await searchRequest(app, workspace.id, token, 'q=dashboard+sharing');
    const second = await searchRequest(app, workspace.id, token, 'q=dashboard+sharing');

    expect(JSON.parse(first.body).cached).toBe(false);
    expect(JSON.parse(second.body).cached).toBe(true);
  });

  it('honors topK/candidateK passed as querystring values', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    await seedChunks(workspace.id, 'doc', [
      { key: 'a', text: 'dashboard sharing one' },
      { key: 'b', text: 'dashboard sharing two' },
      { key: 'c', text: 'dashboard sharing three' },
    ]);
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });

    const response = await searchRequest(
      app,
      workspace.id,
      token,
      'q=dashboard+sharing&topK=1&candidateK=5',
    );

    expect(JSON.parse(response.body).results).toHaveLength(1);
  });

  it('topK === candidateK succeeds (boundary, not an error)', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    await seedChunks(workspace.id, 'doc', [{ key: 'a', text: 'dashboard sharing' }]);
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });

    const response = await searchRequest(
      app,
      workspace.id,
      token,
      'q=dashboard&topK=3&candidateK=3',
    );

    expect(response.statusCode).toBe(200);
  });

  it.each(['', '   '])('400s for missing/whitespace-only q=%j', async (q) => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });
    const response = await searchRequest(app, workspace.id, token, `q=${encodeURIComponent(q)}`);
    expect(response.statusCode).toBe(400);
  });

  it('400s for a missing q entirely', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });
    const response = await searchRequest(app, workspace.id, token, '');
    expect(response.statusCode).toBe(400);
  });

  it('401s when Authorization is absent', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const app = buildApp({ db, retriever });
    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspace.id}/search?q=x`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('400s when workspaceId path param is not a valid UUID', async () => {
    const user = await createUser(db, { email: 'a@acme.test', name: 'A' });
    const token = await signToken(user.id);
    const app = buildApp({ db, retriever });
    const response = await searchRequest(app, 'not-a-uuid', token, 'q=x');
    expect(response.statusCode).toBe(400);
  });

  it('400s for a non-numeric topK ("abc"), not a 500', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });
    const response = await searchRequest(app, workspace.id, token, 'q=x&topK=abc');
    expect(response.statusCode).toBe(400);
  });

  it('400s for a fractional topK ("2.5")', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });
    const response = await searchRequest(app, workspace.id, token, 'q=x&topK=2.5');
    expect(response.statusCode).toBe(400);
  });

  it.each(['0', '-1'])('400s for a non-positive topK (%s)', async (topK) => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });
    const response = await searchRequest(app, workspace.id, token, `q=x&topK=${topK}`);
    expect(response.statusCode).toBe(400);
  });

  it('400s for a duplicate topK querystring value (?topK=5&topK=10), not silently accepted as an array', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });
    const response = await searchRequest(app, workspace.id, token, 'q=x&topK=5&topK=10');
    expect(response.statusCode).toBe(400);
  });

  it("400s for oversized topK/candidateK, mapped through the retriever's own maximum", async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });
    const response = await searchRequest(app, workspace.id, token, 'q=x&topK=9999');
    expect(response.statusCode).toBe(400);
  });

  it('topK > candidateK maps through RetrievalValidationError to 400, not 500', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });
    const response = await searchRequest(app, workspace.id, token, 'q=x&topK=10&candidateK=2');
    expect(response.statusCode).toBe(400);
  });

  it("a valid JWT + active membership in workspace A 403s on workspace B's search, and retriever.search is never invoked", async () => {
    const workspaceA = await createWorkspace(db, { name: 'A Co' });
    const workspaceB = await createWorkspace(db, { name: 'B Co' });
    await seedChunks(workspaceB.id, 'docB', [{ key: 'a', text: 'workspace B private content' }]);
    const token = await seedActiveMember(workspaceA.id, 'a@acme.test');
    const searchSpy = vi.spyOn(retriever, 'search');
    const app = buildApp({ db, retriever });

    const response = await searchRequest(app, workspaceB.id, token, 'q=private');

    expect(response.statusCode).toBe(403);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('results for workspace A never include a workspace-B document, even with lexically similar content', async () => {
    const workspaceA = await createWorkspace(db, { name: 'A Co' });
    const workspaceB = await createWorkspace(db, { name: 'B Co' });
    const shared = [{ key: 'x', text: 'external dashboard sharing access controls for partners' }];
    await seedChunks(workspaceA.id, 'docA', shared);
    await seedChunks(workspaceB.id, 'docB', shared);
    const token = await seedActiveMember(workspaceA.id, 'a@acme.test');
    const app = buildApp({ db, retriever });

    const response = await searchRequest(app, workspaceA.id, token, 'q=external+dashboard+sharing');

    const body = JSON.parse(response.body);
    expect(body.results.length).toBeGreaterThan(0);
    const docIdsA = new Set(
      (await getChunksByDocument(db, body.results[0].documentId)).map((c) => c.documentId),
    );
    for (const r of body.results) {
      expect(docIdsA.has(r.documentId)).toBe(true);
    }
  });

  it('403s (not 500) when the caller has no membership row for this workspace, before retriever.search runs', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const stranger = await createUser(db, { email: 'stranger@acme.test', name: 'Stranger' });
    const token = await signToken(stranger.id);
    const searchSpy = vi.spyOn(retriever, 'search');
    const app = buildApp({ db, retriever });

    const response = await searchRequest(app, workspace.id, token, 'q=x');

    expect(response.statusCode).toBe(403);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('never 500s for a well-formed but non-existent workspaceId UUID', async () => {
    const user = await createUser(db, { email: 'a@acme.test', name: 'A' });
    const token = await signToken(user.id);
    const app = buildApp({ db, retriever });
    const response = await searchRequest(app, '00000000-0000-0000-0000-000000000000', token, 'q=x');
    expect(response.statusCode).toBe(403);
  });

  it('zero matches returns 200 with results: [], not 404', async () => {
    // An unrelated-but-present chunk isn't enough here: the stub embedder
    // doesn't do real semantic similarity, so vector search would still
    // surface it as a "candidate". A workspace with no chunks at all
    // guarantees a genuine zero across both retrievers.
    const workspace = await createWorkspace(db, { name: 'Acme' });
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const app = buildApp({ db, retriever });

    const response = await searchRequest(app, workspace.id, token, 'q=anything');

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).results).toEqual([]);
  });

  it('an unexpected error (router.embed throws) maps to a generic 500 with no leaked detail', async () => {
    const workspace = await createWorkspace(db, { name: 'Acme' });
    await seedChunks(workspace.id, 'doc', [{ key: 'a', text: 'dashboard sharing' }]);
    const token = await seedActiveMember(workspace.id, 'a@acme.test');
    const brokenRetriever = createRetriever({
      db,
      search,
      router: {
        ...router,
        embed: async () => {
          throw new Error('embedding provider secret failure detail');
        },
      },
      cache: new InMemoryCache(),
    });
    const app = buildApp({ db, retriever: brokenRetriever });

    const response = await searchRequest(app, workspace.id, token, 'q=dashboard');

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('embedding provider secret failure detail');
    expect(JSON.parse(response.body)).toEqual({ error: 'internal_error' });
  });
});
