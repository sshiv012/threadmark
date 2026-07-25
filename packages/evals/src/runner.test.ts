import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import {
  createEvidenceDocument,
  createWorkspace,
  getChunksByDocument,
  setChunkEmbedding,
  updateDocumentStatus,
  upsertChunks,
  type Database,
  type EvalJudgment,
  type EvalQueryWithJudgments,
} from '@threadmark/db';
import * as schema from '@threadmark/db';
import { createModelRouter, type ModelRouter } from '@threadmark/model-router';
import { CHUNK_INDEX, createRetriever, type Retriever } from '@threadmark/retrieval';
import { InMemorySearchIndex } from '@threadmark/search';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ArmDeps } from './arms.js';
import { resolveRelevanceMap, runEval } from './runner.js';

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url));

let db: Database;
let search: InMemorySearchIndex;
let router: ModelRouter;
let retriever: Retriever;
let armDeps: ArmDeps;

async function seedWorkspace(
  name: string,
  chunkDefs: { key: string; text: string }[],
): Promise<{ workspaceId: string; documentId: string; docTitle: string }> {
  const workspace = await createWorkspace(db, { name });
  const docTitle = `${name}-doc`;
  const doc = await createEvidenceDocument(db, {
    workspaceId: workspace.id,
    sourceType: 'product_doc',
    title: docTitle,
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
    stored.map((c) => ({ id: c.id, documentId: doc.id, workspaceId: workspace.id, text: c.text })),
  );
  await updateDocumentStatus(db, doc.id, 'ready');
  return { workspaceId: workspace.id, documentId: doc.id, docTitle };
}

function judgment(
  overrides: Partial<EvalJudgment> & Pick<EvalJudgment, 'docId' | 'chunkSourceKey' | 'relevance'>,
): EvalJudgment {
  return {
    id: 'stub-id',
    queryId: 'stub-query-id',
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(async () => {
  const pg = new PGlite({ extensions: { vector } });
  const pgliteDb = drizzle(pg, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  db = pgliteDb as unknown as Database;

  search = new InMemorySearchIndex();
  router = createModelRouter({
    generation: { provider: 'stub' },
    embedding: { provider: 'stub', dimensions: 384 },
    rerank: { provider: 'stub' },
  });
  retriever = createRetriever({ db, search, router });
  armDeps = { db, search, router, retriever };
});

describe('resolveRelevanceMap', () => {
  it('maps a judgment (docId, chunkSourceKey) to the seeded chunk uuid', async () => {
    const { workspaceId, documentId, docTitle } = await seedWorkspace('resolve-happy', [
      { key: 'overview', text: 'overview text' },
    ]);
    const [chunk] = await getChunksByDocument(db, documentId);

    const relevanceById = await resolveRelevanceMap(db, workspaceId, [
      judgment({ docId: docTitle, chunkSourceKey: 'overview', relevance: 2 }),
    ]);
    expect(relevanceById.size).toBe(1);
    expect(relevanceById.get(chunk!.id)).toBe(2);
  });

  describe('adversarial', () => {
    it('excludes a judgment whose docId matches no seeded document title', async () => {
      const { workspaceId } = await seedWorkspace('resolve-no-doc', [{ key: 'a', text: 'x' }]);
      const relevanceById = await resolveRelevanceMap(db, workspaceId, [
        judgment({ docId: 'never-seeded', chunkSourceKey: 'a', relevance: 3 }),
      ]);
      expect(relevanceById.size).toBe(0);
    });

    it('excludes a judgment whose chunkSourceKey matches no chunk of a real document', async () => {
      const { workspaceId, docTitle } = await seedWorkspace('resolve-no-chunk', [
        { key: 'a', text: 'x' },
      ]);
      const relevanceById = await resolveRelevanceMap(db, workspaceId, [
        judgment({ docId: docTitle, chunkSourceKey: 'does-not-exist', relevance: 3 }),
      ]);
      expect(relevanceById.size).toBe(0);
    });

    it('resolveRelevanceMap([]) returns an empty map', async () => {
      const { workspaceId } = await seedWorkspace('resolve-empty', []);
      expect((await resolveRelevanceMap(db, workspaceId, [])).size).toBe(0);
    });
  });

  describe('multi-tenant isolation', () => {
    it('resolves only the calling workspace chunk when two workspaces share the same doc title and sourceKey', async () => {
      const wsA = await seedWorkspace('iso-a', [{ key: 'k1', text: 'workspace A content' }]);
      const workspace = await createWorkspace(db, { name: 'iso-b' });
      const docB = await createEvidenceDocument(db, {
        workspaceId: workspace.id,
        sourceType: 'product_doc',
        title: wsA.docTitle, // identical title on purpose
        blobUri: 's3://memory/iso-b.md',
        checksum: 'chk-iso-b',
      });
      const [chunkB] = await upsertChunks(db, [
        {
          documentId: docB.id,
          ord: 0,
          sourceKey: 'k1', // identical sourceKey on purpose
          contentHash: 'h-iso-b',
          text: 'workspace B content',
          tokenCount: 3,
        },
      ]);
      await updateDocumentStatus(db, docB.id, 'ready');

      const relevanceById = await resolveRelevanceMap(db, wsA.workspaceId, [
        judgment({ docId: wsA.docTitle, chunkSourceKey: 'k1', relevance: 1 }),
      ]);
      expect(relevanceById.has(chunkB!.id)).toBe(false);
      expect(relevanceById.size).toBe(1);
    });
  });
});

describe('runEval', () => {
  function makeQuery(
    externalId: string,
    queryText: string,
    judgments: EvalJudgment[],
  ): EvalQueryWithJudgments {
    return {
      query: {
        id: `q-${externalId}`,
        workspaceId: 'stub',
        externalId,
        queryText,
        notes: null,
        createdAt: new Date(),
      },
      judgments,
    };
  }

  it('mean equals the hand-computed arithmetic average across a 3-query fixture with differing scores', async () => {
    const { workspaceId, docTitle } = await seedWorkspace('agg', [
      { key: 'a', text: 'external dashboard sharing via secure links' },
      { key: 'b', text: 'unrelated billing invoice content' },
    ]);

    const queries: EvalQueryWithJudgments[] = [
      // Judged chunk is a genuine top match — precision@8 should be high.
      makeQuery('q1', 'external dashboard sharing via secure links', [
        judgment({ docId: docTitle, chunkSourceKey: 'a', relevance: 3 }),
      ]),
      // Judgment references a chunk that can never resolve — precision must be 0.
      makeQuery('q2', 'external dashboard sharing via secure links', [
        judgment({ docId: docTitle, chunkSourceKey: 'no-such-chunk', relevance: 3 }),
      ]),
      makeQuery('q3', 'external dashboard sharing via secure links', [
        judgment({ docId: docTitle, chunkSourceKey: 'a', relevance: 3 }),
      ]),
    ];

    const [result] = await runEval(armDeps, workspaceId, queries, ['vector_only'], 8, 30);
    expect(result!.perQuery).toHaveLength(3);
    const expectedMeanPrecision =
      result!.perQuery.reduce((sum, q) => sum + q.precisionAtK, 0) / result!.perQuery.length;
    expect(result!.mean.precisionAtK).toBeCloseTo(expectedMeanPrecision, 10);
    // q2's judgment can never resolve to a real chunk, so its precision must be 0
    // while q1/q3 (a genuine top vector match) should be nonzero — proving the
    // mean is a real average across differing per-query values, not a constant.
    expect(result!.perQuery.find((q) => q.externalId === 'q2')!.precisionAtK).toBe(0);
    expect(result!.perQuery.find((q) => q.externalId === 'q1')!.precisionAtK).toBeGreaterThan(0);
  });

  it('returns one ArmResult per configName with empty perQuery and mean=0 (not NaN) when queries=[]', async () => {
    const { workspaceId } = await seedWorkspace('empty-queries', []);
    const results = await runEval(armDeps, workspaceId, [], ['lexical_only', 'vector_only'], 8, 30);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.perQuery).toEqual([]);
      expect(r.mean.precisionAtK).toBe(0);
      expect(r.mean.recallAtK).toBe(0);
      expect(r.mean.mrr).toBe(0);
      expect(r.mean.ndcgAtK).toBe(0);
    }
  });

  it('a query with empty judgments does not crash and scores 0, not NaN', async () => {
    const { workspaceId } = await seedWorkspace('empty-judgments', [
      { key: 'a', text: 'some content' },
    ]);
    const queries = [makeQuery('q1', 'some content', [])];
    const [result] = await runEval(armDeps, workspaceId, queries, ['vector_only'], 8, 30);
    expect(result!.perQuery[0]!.recallAtK).toBe(0);
    expect(result!.perQuery[0]!.ndcgAtK).toBe(0);
  });

  it('skips a query whose arm computation throws and continues the run', async () => {
    const { workspaceId, docTitle } = await seedWorkspace('partial-failure', [
      { key: 'a', text: 'dashboard sharing content one' },
      { key: 'b', text: 'dashboard sharing content two' },
      { key: 'c', text: 'dashboard sharing content three' },
    ]);
    let call = 0;
    const flakyRouter: ModelRouter = {
      ...router,
      rerank: (request) => {
        call += 1;
        if (call === 2) throw new Error('simulated rerank failure');
        return router.rerank(request);
      },
    };
    const flakyRetriever = createRetriever({ db, search, router: flakyRouter });
    const flakyDeps: ArmDeps = { db, search, router: flakyRouter, retriever: flakyRetriever };

    const queries = [
      makeQuery('q1', 'dashboard sharing content one', [
        judgment({ docId: docTitle, chunkSourceKey: 'a', relevance: 2 }),
      ]),
      makeQuery('q2', 'dashboard sharing content two', [
        judgment({ docId: docTitle, chunkSourceKey: 'b', relevance: 2 }),
      ]),
      makeQuery('q3', 'dashboard sharing content three', [
        judgment({ docId: docTitle, chunkSourceKey: 'c', relevance: 2 }),
      ]),
    ];

    const [result] = await runEval(flakyDeps, workspaceId, queries, ['hybrid_rerank'], 8, 30);
    expect(result!.perQuery.length).toBeLessThan(3);
    expect(result!.perQuery.some((q) => q.externalId === 'q2')).toBe(false);
  });

  it('mean.mrr is the average of reciprocalRank, not precision/recall/ndcg', async () => {
    const { workspaceId, docTitle } = await seedWorkspace('mrr-check', [
      { key: 'target', text: 'zzqz distinctive target phrase for ranking' },
      { key: 'filler1', text: 'filler content about dashboards' },
      { key: 'filler2', text: 'filler content about links' },
    ]);
    // Bias the target chunk to rank lower than filler by using a query that
    // only weakly matches it, so reciprocalRank != 1 while still nonzero.
    const queries = [
      makeQuery('q1', 'zzqz distinctive target phrase for ranking dashboards links filler', [
        judgment({ docId: docTitle, chunkSourceKey: 'target', relevance: 3 }),
      ]),
    ];
    const [result] = await runEval(armDeps, workspaceId, queries, ['hybrid_no_rerank'], 8, 30);
    const q = result!.perQuery[0]!;
    expect(result!.mean.mrr).toBeCloseTo(q.reciprocalRank, 10);
  });
});
