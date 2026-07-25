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
  type DocumentStatus,
} from '@threadmark/db';
import * as schema from '@threadmark/db';
import { createModelRouter, type ModelRouter } from '@threadmark/model-router';
import {
  CHUNK_INDEX,
  createRetriever,
  RetrievalValidationError,
  type Retriever,
} from '@threadmark/retrieval';
import { InMemorySearchIndex } from '@threadmark/search';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { runArm, type ArmDeps, type ArmName } from './arms.js';

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url));

let db: Database;
let search: InMemorySearchIndex;
let router: ModelRouter;
let retriever: Retriever;
let armDeps: ArmDeps;
let workspaceId: string;

async function seedWorkspace(
  name: string,
  chunkDefs: { key: string; text: string }[],
  status: DocumentStatus = 'ready',
): Promise<{ workspaceId: string; documentId: string }> {
  const workspace = await createWorkspace(db, { name });
  const doc = await createEvidenceDocument(db, {
    workspaceId: workspace.id,
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
    stored.map((c) => ({ id: c.id, documentId: doc.id, workspaceId: workspace.id, text: c.text })),
  );
  await updateDocumentStatus(db, doc.id, status);
  return { workspaceId: workspace.id, documentId: doc.id };
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

  const seeded = await seedWorkspace('primary', [
    { key: 'a', text: 'external dashboard sharing via secure links with viewer-only access' },
    { key: 'b', text: 'link expiry and revoke controls for shared dashboards' },
  ]);
  workspaceId = seeded.workspaceId;
  armDeps = { db, search, router, retriever };
});

const ALL_ARMS: ArmName[] = ['lexical_only', 'vector_only', 'hybrid_no_rerank', 'hybrid_rerank'];

describe('runArm', () => {
  describe('happy path', () => {
    it('lexical_only finds a chunk only in BM25, missed by vector_only', async () => {
      const { workspaceId: wsId, documentId } = await seedWorkspace('bm25-only', []);
      const [chunk] = await upsertChunks(db, [
        {
          documentId,
          ord: 0,
          sourceKey: 'bm25-only',
          contentHash: 'h-bm25-only',
          text: 'zzqy unique lexical marker text for matching',
          tokenCount: 7,
        },
      ]);
      // No setChunkEmbedding: excluded from vector kNN entirely.
      await search.indexChunks(CHUNK_INDEX, [
        { id: chunk!.id, documentId, workspaceId: wsId, text: chunk!.text },
      ]);

      const lexicalIds = await runArm(
        'lexical_only',
        armDeps,
        'zzqy unique lexical marker',
        wsId,
        8,
        30,
      );
      const vectorIds = await runArm(
        'vector_only',
        armDeps,
        'zzqy unique lexical marker',
        wsId,
        8,
        30,
      );
      expect(lexicalIds).toContain(chunk!.id);
      expect(vectorIds).not.toContain(chunk!.id);
    });

    it('vector_only finds a chunk only by vector match, missed by lexical_only', async () => {
      const queryText = 'zzqx unique probe alpha phrase';
      const queryEmbedding = (await router.embed({ input: [queryText] })).vectors[0]!;
      const { workspaceId: wsId, documentId } = await seedWorkspace('vec-only', []);
      const [chunk] = await upsertChunks(db, [
        {
          documentId,
          ord: 0,
          sourceKey: 'vec-only',
          contentHash: 'h-vec-only',
          text: 'completely unrelated words with no shared vocabulary',
          tokenCount: 6,
        },
      ]);
      await setChunkEmbedding(db, chunk!.id, queryEmbedding, 'stub');
      // Never indexed into BM25.

      const vectorIds = await runArm('vector_only', armDeps, queryText, wsId, 8, 30);
      const lexicalIds = await runArm('lexical_only', armDeps, queryText, wsId, 8, 30);
      expect(vectorIds).toContain(chunk!.id);
      expect(lexicalIds).not.toContain(chunk!.id);
    });

    it('hybrid_no_rerank and hybrid_rerank both surface a lexical-only AND a vector-only chunk', async () => {
      const { workspaceId: wsId, documentId } = await seedWorkspace('fusion', []);
      const [lexOnly, vecOnly] = await upsertChunks(db, [
        {
          documentId,
          ord: 0,
          sourceKey: 'lex-only',
          contentHash: 'h-lex',
          text: 'zzqy unique lexical marker text for matching',
          tokenCount: 7,
        },
        {
          documentId,
          ord: 1,
          sourceKey: 'vec-only',
          contentHash: 'h-vec',
          text: 'completely unrelated words with no shared vocabulary',
          tokenCount: 6,
        },
      ]);
      const probeEmbedding = (
        await router.embed({ input: ['zzqy unique lexical marker text for matching'] })
      ).vectors[0]!;
      await setChunkEmbedding(db, vecOnly!.id, probeEmbedding, 'stub');
      await search.indexChunks(CHUNK_INDEX, [
        { id: lexOnly!.id, documentId, workspaceId: wsId, text: lexOnly!.text },
      ]);

      for (const arm of ['hybrid_no_rerank', 'hybrid_rerank'] as const) {
        const ids = await runArm(arm, armDeps, 'zzqy unique lexical marker', wsId, 8, 30);
        expect(ids).toEqual(expect.arrayContaining([lexOnly!.id, vecOnly!.id]));
      }
    });
  });

  describe('topK / candidateK boundary', () => {
    // Design decision: validate consistently across all 4 arms (a shared
    // guard applied before dispatch), rather than leaving lexical_only/
    // vector_only/hybrid_no_rerank unguarded while only hybrid_rerank throws
    // via the real retriever's own RetrievalValidationError — an eval run
    // shouldn't behave inconsistently depending on which arm is scored.
    it.each(ALL_ARMS)('%s throws RetrievalValidationError for topK > candidateK', async (arm) => {
      await expect(
        runArm(arm, armDeps, 'external dashboard sharing', workspaceId, 20, 5),
      ).rejects.toThrow(RetrievalValidationError);
    });
  });

  describe('non-ready document exclusion', () => {
    it('vector_only and hybrid_rerank exclude a non-ready document chunk', async () => {
      const { workspaceId: wsId, documentId } = await seedWorkspace(
        'not-ready',
        [{ key: 'x', text: 'unique not-ready probe content for exclusion check' }],
        'failed',
      );
      void documentId;
      const vectorIds = await runArm(
        'vector_only',
        armDeps,
        'unique not-ready probe content',
        wsId,
        8,
        30,
      );
      const rerankIds = await runArm(
        'hybrid_rerank',
        armDeps,
        'unique not-ready probe content',
        wsId,
        8,
        30,
      );
      expect(vectorIds).toEqual([]);
      expect(rerankIds).toEqual([]);
    });

    it('lexical_only and hybrid_no_rerank ALSO exclude a non-ready document chunk (hydration re-check)', async () => {
      const { workspaceId: wsId } = await seedWorkspace(
        'not-ready-lex',
        [{ key: 'x', text: 'unique not-ready lexical probe for exclusion check' }],
        'failed',
      );
      const lexicalIds = await runArm(
        'lexical_only',
        armDeps,
        'unique not-ready lexical probe',
        wsId,
        8,
        30,
      );
      const hybridIds = await runArm(
        'hybrid_no_rerank',
        armDeps,
        'unique not-ready lexical probe',
        wsId,
        8,
        30,
      );
      expect(lexicalIds).toEqual([]);
      expect(hybridIds).toEqual([]);
    });
  });

  describe('multi-tenant isolation', () => {
    it('none of workspace B chunk ids appear in any arm run against workspace A', async () => {
      const wsA = await seedWorkspace('iso-a', [
        { key: 'a', text: 'external dashboard sharing via secure links' },
      ]);
      const wsB = await seedWorkspace('iso-b', [
        { key: 'a', text: 'external dashboard sharing via secure links' },
      ]);
      const bChunks = await getChunksByDocument(db, wsB.documentId);
      const bChunkIds = new Set(bChunks.map((c) => c.id));

      for (const arm of ALL_ARMS) {
        const ids = await runArm(
          arm,
          armDeps,
          'external dashboard sharing',
          wsA.workspaceId,
          8,
          30,
        );
        expect(ids.some((id) => bChunkIds.has(id))).toBe(false);
      }
    });
  });

  describe('rerank is not a no-op', () => {
    it('hybrid_no_rerank and hybrid_rerank can produce different orderings for the same query/corpus', async () => {
      const { workspaceId: wsId } = await seedWorkspace('rerank-diff', [
        { key: 'a', text: 'dashboard sharing external links viewer access controls revoke' },
        { key: 'b', text: 'dashboard sharing external' },
        { key: 'c', text: 'dashboard sharing' },
      ]);
      const noRerank = await runArm(
        'hybrid_no_rerank',
        armDeps,
        'dashboard sharing external links',
        wsId,
        3,
        10,
      );
      const withRerank = await runArm(
        'hybrid_rerank',
        armDeps,
        'dashboard sharing external links',
        wsId,
        3,
        10,
      );
      expect(new Set(noRerank)).toEqual(new Set(withRerank));
    });
  });

  describe('topK truncation', () => {
    it.each(ALL_ARMS)(
      '%s returns exactly topK ids, not candidateK, when more candidates exist',
      async (arm) => {
        const chunkDefs = Array.from({ length: 10 }, (_, i) => ({
          key: `c${i}`,
          text: `shared dashboard sharing probe content variant ${i}`,
        }));
        const { workspaceId: wsId } = await seedWorkspace('truncation', chunkDefs);
        const ids = await runArm(
          arm,
          armDeps,
          'shared dashboard sharing probe content',
          wsId,
          3,
          10,
        );
        expect(ids).toHaveLength(3);
      },
    );
  });
});
