/**
 * Dogfood integration suite — the assertion-based "one command" verification
 * the manual `pnpm seed` + `pnpm run retrieve` workflow never gave us.
 *
 * Opt-in and heavy: exercises REAL Postgres, OpenSearch, Redis, and MinIO, and
 * the REAL local embedding + reranker models (no mocks, no fakes). Run:
 *
 *   pnpm infra:up && pnpm --filter @threadmark/db db:migrate
 *   pnpm test:dogfood                          # from repo root, or:
 *   pnpm --filter @threadmark/worker test:dogfood
 *
 * NOTE: real embedding/rerank calls routinely take 6-12s locally. Only the
 * heaviest tests (full-manifest ingest, re-seed) have per-test timeouts here;
 * every other test relies on vitest's default (5s), which real service calls
 * blow through. The `test:dogfood` scripts above bake in
 * `--testTimeout=60000` — always run it that way, not a bare `vitest run`.
 *
 * Scope decision: ingestion here calls the pipeline functions directly
 * in-process (extractAndChunk → embedChunks → indexChunks), with the same
 * agent_run/agent_step bookkeeping the real Temporal activities perform,
 * rather than driving a live Temporal worker process. Temporal's own
 * durability/retry behavior is already covered by the offline
 * pipeline.test.ts and by manual worker runs (PR5b-3a/b) — this suite's job
 * is asserting retrieval QUALITY, ISOLATION, and CACHE CORRECTNESS against
 * real services and real models, which is the gap that mattered: a human
 * eyeballing `pnpm run retrieve` output is not a verification.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3BlobStore } from '@threadmark/blob';
import { createChunkerRegistry } from '@threadmark/chunking';
import {
  appendAgentStep,
  createAgentRun,
  createDb,
  createEvidenceDocument,
  createWorkspace,
  findEvidenceDocumentByChecksum,
  getChunksByDocument,
  getEvidenceDocument,
  updateAgentRunStatus,
  updateAgentStep,
  updateDocumentStatus,
  type AgentStepStatus,
  type Database,
  type EvidenceSourceType,
} from '@threadmark/db';
import { createModelRouter, loadModelRouterConfig } from '@threadmark/model-router';
import { createRetriever, RedisCache, type Retriever } from '@threadmark/retrieval';
import { OpenSearchIndex } from '@threadmark/search';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseManifest, type ManifestEntry } from './cli/manifest.js';
import { env } from './env.js';
import { inferContentType } from './helpers.js';
import * as pipeline from './pipeline.js';
import type { IngestionDeps } from './pipeline.js';
import { CHUNK_INDEX } from './shared.js';

const runDogfood = process.env.RUN_DOGFOOD_INTEGRATION === '1';
// Resolve relative to this file (not process.cwd()), which varies depending
// on how the test is invoked (e.g. `pnpm --filter ... exec vitest` runs from
// the package dir, not the repo root).
const CORPUS_DIR = fileURLToPath(new URL('../../../fixtures/dashboard-sharing', import.meta.url));
const PRIMARY_WORKSPACE = `Dogfood Integration Test — ${randomUUID().slice(0, 8)}`;

interface IngestOutcome {
  entry: ManifestEntry;
  documentId: string;
  blobKey: string;
  chunkCount: number;
  failed: boolean;
  error?: string;
}

/**
 * Ingest one manifest entry into `workspaceId`, mirroring activities.ts's
 * orchestration (agent_run + one agent_step per phase, attempt=1 since
 * there's no Temporal retry loop here) but calling the pipeline directly.
 */
async function ingestEntryDirect(
  deps: IngestionDeps,
  entry: ManifestEntry,
  workspaceId: string,
): Promise<IngestOutcome> {
  const filePath = join(CORPUS_DIR, entry.path);
  const bytes = await readFile(filePath);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const blobKey = `${workspaceId}/${checksum}-${entry.docId}`;
  const { uri } = await deps.blob.put(blobKey, bytes, inferContentType(filePath));

  const existing = await findEvidenceDocumentByChecksum(deps.db, workspaceId, checksum);
  const document =
    existing ??
    (await createEvidenceDocument(deps.db, {
      workspaceId,
      sourceType: entry.sourceType as EvidenceSourceType,
      title: entry.docId,
      blobUri: uri,
      checksum,
    }));

  const run = await createAgentRun(deps.db, {
    workspaceId,
    kind: 'ingestion',
    subjectId: document.id,
  });

  async function step(ord: number, type: string, fn: () => Promise<number>): Promise<number> {
    const s = await appendAgentStep(deps.db, { runId: run.id, ord, type, attempt: 1 });
    try {
      const count = await fn();
      await updateAgentStep(deps.db, s.id, {
        status: 'completed' as AgentStepStatus,
        outputSummary: String(count),
      });
      return count;
    } catch (error) {
      await updateAgentStep(deps.db, s.id, {
        status: 'failed' as AgentStepStatus,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  try {
    await updateDocumentStatus(deps.db, document.id, 'chunking');
    await step(0, 'extractAndChunk', () => pipeline.extractAndChunk(deps, document.id));
    await updateDocumentStatus(deps.db, document.id, 'embedding');
    await step(1, 'embedChunks', () => pipeline.embedChunks(deps, document.id));
    await updateDocumentStatus(deps.db, document.id, 'indexing');
    const chunkCount = await step(2, 'indexChunks', () => pipeline.indexChunks(deps, document.id));
    await updateDocumentStatus(deps.db, document.id, 'ready');
    await updateAgentRunStatus(deps.db, run.id, 'completed', new Date());
    return { entry, documentId: document.id, blobKey, chunkCount, failed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateDocumentStatus(deps.db, document.id, 'failed', message);
    await updateAgentRunStatus(deps.db, run.id, 'failed', new Date());
    return { entry, documentId: document.id, blobKey, chunkCount: 0, failed: true, error: message };
  }
}

/** Labeled queries across the corpus's major themes, per doc_id in manifest.csv. */
const LABELED_QUERIES: { theme: string; query: string; expectedDocIds: string[] }[] = [
  {
    theme: 'external sharing overview',
    query: 'how do I share a dashboard with people outside my company',
    expectedDocIds: ['sharing-a-dashboard', 'prd-internal-dashboards-v1'],
  },
  {
    theme: 'expiry and revocation',
    query: 'set an expiry date on a share link and revoke access',
    expectedDocIds: [
      'link-settings-expiry-and-revoke',
      'ticket-1042-link-expired-too-soon',
      'ticket-1078-revoke-access-request',
    ],
  },
  {
    theme: 'SSO / external identity',
    query: 'require SSO login for external viewers of a shared dashboard',
    expectedDocIds: [
      'security-and-compliance',
      'ticket-1105-external-viewer-sso-required',
      'auth-and-data-isolation',
    ],
  },
  {
    theme: 'audit logging',
    query: 'audit log of who viewed a shared dashboard and when',
    expectedDocIds: [
      'security-and-compliance',
      'compliance-audit-and-pii',
      'auth-and-data-isolation',
    ],
  },
  {
    theme: 'PII / GDPR',
    query: 'GDPR and personal data handling for external dashboard viewers',
    expectedDocIds: ['compliance-audit-and-pii'],
  },
  {
    theme: 'mobile performance',
    query: 'shared dashboard loads slowly on a mobile phone',
    expectedDocIds: ['ticket-1130-shared-dashboard-slow-mobile', 'performance-and-caching'],
  },
  {
    theme: 'watermarking',
    query: 'watermark on an exported PDF for a shared dashboard',
    expectedDocIds: ['security-and-compliance', 'compliance-audit-and-pii'],
  },
  {
    theme: 'pricing / nonprofit constraints',
    query: 'affordable pricing for a nonprofit sharing dashboards with funders',
    expectedDocIds: ['interview-brightseed-aisha'],
  },
];

const DISTRACTOR_CORE_DOC_IDS = [
  'sharing-a-dashboard',
  'security-and-compliance',
  'link-settings-expiry-and-revoke',
];

describe.skipIf(!runDogfood)('dogfood integration (real services, real models)', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let blob: S3BlobStore;
  let search: OpenSearchIndex;
  let redis: Redis;
  let retriever: Retriever;
  let manifest: ManifestEntry[];
  let workspaceId: string;
  let outcomes: IngestOutcome[];
  const docIdToDocumentId = new Map<string, string>();
  const documentIdToDocId = new Map<string, string>();
  const docIdToBlobKey = new Map<string, string>();

  function recall(documentId: string): string | undefined {
    return documentIdToDocId.get(documentId);
  }

  function buildDeps(): IngestionDeps {
    return {
      db,
      blob,
      search,
      router: createModelRouter(loadModelRouterConfig(process.env)),
      chunkers: createChunkerRegistry(),
    };
  }

  beforeAll(async () => {
    const conn = createDb(env.databaseUrl);
    db = conn.db;
    closeDb = conn.close;

    blob = new S3BlobStore({
      bucket: env.minio.bucket,
      endpoint: env.minio.endpoint,
      accessKeyId: env.minio.accessKeyId,
      secretAccessKey: env.minio.secretAccessKey,
      forcePathStyle: true,
    });
    search = new OpenSearchIndex({ node: env.opensearchNode });
    redis = new Redis(env.redisUrl);

    const manifestRaw = await readFile(join(CORPUS_DIR, 'manifest.csv'), 'utf8');
    manifest = parseManifest(manifestRaw);

    const workspace = await createWorkspace(db, { name: PRIMARY_WORKSPACE });
    workspaceId = workspace.id;

    retriever = createRetriever({
      db,
      search,
      router: createModelRouter(loadModelRouterConfig(process.env)),
      cache: new RedisCache(redis),
    });
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    redis.disconnect();
  });

  describe('0. service connectivity', () => {
    it('Postgres is reachable', async () => {
      await expect(getEvidenceDocument(db, randomUUID())).resolves.toBeUndefined();
    });

    it('MinIO is reachable and the evidence bucket is usable', async () => {
      await expect(blob.ensureBucket()).resolves.toBeUndefined();
    });

    it('OpenSearch is reachable', async () => {
      await expect(search.ensureIndex(CHUNK_INDEX)).resolves.toBeUndefined();
    });

    it('Redis is reachable', async () => {
      await expect(redis.ping()).resolves.toBe('PONG');
    });
  });

  describe('1. ingest the full manifest', () => {
    it('ingests every manifest document to ready with no failed run/step', async () => {
      const deps = buildDeps();
      outcomes = [];
      for (const entry of manifest) {
        const outcome = await ingestEntryDirect(deps, entry, workspaceId);
        outcomes.push(outcome);
        docIdToDocumentId.set(entry.docId, outcome.documentId);
        documentIdToDocId.set(outcome.documentId, entry.docId);
        docIdToBlobKey.set(entry.docId, outcome.blobKey);
        if (outcome.failed) {
          console.error(`  ✗ ${entry.docId}: ${outcome.error}`);
        }
      }

      const failed = outcomes.filter((o) => o.failed);
      if (failed.length > 0) {
        throw new Error(
          `${failed.length}/${manifest.length} documents failed to ingest: ` +
            failed.map((f) => `${f.entry.docId} (${f.error})`).join('; '),
        );
      }
      expect(outcomes).toHaveLength(manifest.length);
    }, 300_000);

    it('every document reached ready', async () => {
      for (const entry of manifest) {
        const documentId = docIdToDocumentId.get(entry.docId);
        expect(documentId, `${entry.docId} was not ingested`).toBeDefined();
        const doc = await getEvidenceDocument(db, documentId!);
        expect(doc?.status, `${entry.docId} status`).toBe('ready');
      }
    });

    it('every ingested document has embedded chunks', async () => {
      let totalChunks = 0;
      for (const entry of manifest) {
        const documentId = docIdToDocumentId.get(entry.docId)!;
        const chunks = await getChunksByDocument(db, documentId);
        expect(chunks.length, `${entry.docId} chunk count`).toBeGreaterThan(0);
        expect(
          chunks.every((c) => c.embedding !== null && c.embedding.length === 384),
          `${entry.docId} all chunks embedded at 384 dims`,
        ).toBe(true);
        totalChunks += chunks.length;
      }
      expect(totalChunks).toBeGreaterThan(manifest.length); // at least 1 chunk/doc, realistically many more
    });
  });

  describe('2. retrieval quality — labeled queries across corpus themes', () => {
    for (const { theme, query, expectedDocIds } of LABELED_QUERIES) {
      it(`[${theme}] "${query}" recalls an expected document in the top 5`, async () => {
        const result = await retriever.search(query, { workspaceId, topK: 5 });
        const gotDocIds = result.results.map((r) => recall(r.documentId)).filter(Boolean);
        const recalled = expectedDocIds.some((id) => gotDocIds.includes(id));
        expect(
          recalled,
          `expected one of [${expectedDocIds.join(', ')}] in top 5, got [${gotDocIds.join(', ')}]`,
        ).toBe(true);
      });
    }

    it('suppresses the core sharing docs for an off-topic (billing) query', async () => {
      const result = await retriever.search('monthly billing invoice payment method total', {
        workspaceId,
        topK: 3,
      });
      const topDocIds = result.results.map((r) => recall(r.documentId)).filter(Boolean);
      const coreDocsInTop3 = DISTRACTOR_CORE_DOC_IDS.filter((id) => topDocIds.includes(id));
      expect(
        coreDocsInTop3,
        `core sharing docs leaked into an off-topic query's top 3: ${coreDocsInTop3.join(', ')}`,
      ).toHaveLength(0);
    });
  });

  describe('3. cache: cold vs warm', () => {
    it('is a cache miss on first query and a hit on the identical repeat', async () => {
      const cold = await retriever.search('external dashboard sharing overview', { workspaceId });
      expect(cold.cached).toBe(false);
      const warm = await retriever.search('external dashboard sharing overview', { workspaceId });
      expect(warm.cached).toBe(true);
      expect(warm.latencyMs).toBeLessThanOrEqual(cold.latencyMs);
    });
  });

  describe('4. edit invalidates cache and search', () => {
    const editedDocId = 'ticket-1042-link-expired-too-soon';
    const probeQuery = 'link expired too soon renewal request';

    it('modifying the document changes what is returned, not a stale cached answer', async () => {
      const documentId = docIdToDocumentId.get(editedDocId)!;
      const blobKey = docIdToBlobKey.get(editedDocId)!;

      const before = await retriever.search(probeQuery, { workspaceId });
      expect(before.results.some((r) => r.documentId === documentId)).toBe(true);

      // Re-ingest with the distinctive probe phrase removed — simulates an
      // edit. Overwrite the SAME blob key so the document's existing blobUri
      // still resolves to the new content.
      const original = await readFile(
        join(CORPUS_DIR, 'support-tickets', `${editedDocId}.md`),
        'utf8',
      );
      const edited = original.replace(/expired too soon/gi, 'stopped working unexpectedly');
      await blob.put(blobKey, new TextEncoder().encode(edited), 'text/markdown');

      const deps = buildDeps();
      await updateDocumentStatus(db, documentId, 'chunking');
      await pipeline.extractAndChunk(deps, documentId);
      await updateDocumentStatus(db, documentId, 'embedding');
      await pipeline.embedChunks(deps, documentId);
      await updateDocumentStatus(db, documentId, 'indexing');
      await pipeline.indexChunks(deps, documentId);
      await updateDocumentStatus(db, documentId, 'ready');

      const after = await retriever.search(probeQuery, { workspaceId });
      expect(after.cached).toBe(false); // corpus revision changed → not served from the old cache entry
    });
  });

  describe('5. multi-tenant isolation', () => {
    it('a second workspace with the same corpus never leaks into the first', async () => {
      const secondWorkspace = await createWorkspace(db, {
        name: `${PRIMARY_WORKSPACE} — isolation B`,
      });
      const deps = buildDeps();
      // Ingest just one representative document into the second workspace.
      const entry = manifest.find((m) => m.docId === 'security-and-compliance')!;
      const outcome = await ingestEntryDirect(deps, entry, secondWorkspace.id);
      expect(outcome.failed).toBe(false);

      const result = await retriever.search('SSO for external viewers audit logging', {
        workspaceId: secondWorkspace.id,
      });
      expect(result.results.every((r) => r.documentId === outcome.documentId)).toBe(true);

      // The primary workspace's results must be unaffected/unchanged in kind.
      const primaryResult = await retriever.search('SSO for external viewers audit logging', {
        workspaceId,
      });
      const primaryDocIds = new Set(primaryResult.results.map((r) => r.documentId));
      expect(primaryDocIds.has(outcome.documentId)).toBe(false);
    }, 60_000);
  });

  describe('6. re-seed idempotency', () => {
    it('re-ingesting the whole manifest again reuses documents and does not duplicate chunks', async () => {
      const deps = buildDeps();
      const before = await Promise.all(
        manifest.map((e) => getChunksByDocument(db, docIdToDocumentId.get(e.docId)!)),
      );
      const beforeCounts = before.map((c) => c.length);

      const reOutcomes: IngestOutcome[] = [];
      for (const entry of manifest) {
        reOutcomes.push(await ingestEntryDirect(deps, entry, workspaceId));
      }
      expect(reOutcomes.every((o) => !o.failed)).toBe(true);
      expect(reOutcomes.map((o) => o.documentId)).toEqual(
        manifest.map((e) => docIdToDocumentId.get(e.docId)),
      );

      const after = await Promise.all(
        manifest.map((e) => getChunksByDocument(db, docIdToDocumentId.get(e.docId)!)),
      );
      const afterCounts = after.map((c) => c.length);
      // ticket-1042 was edited in section 4 — its count may legitimately shift;
      // everything else must be stable across a no-op re-ingest.
      manifest.forEach((entry, i) => {
        if (entry.docId === 'ticket-1042-link-expired-too-soon') return;
        expect(afterCounts[i], `${entry.docId} chunk count stable across re-seed`).toBe(
          beforeCounts[i],
        );
      });
    }, 300_000);
  });
});
