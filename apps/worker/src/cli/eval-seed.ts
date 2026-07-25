/**
 * `pnpm eval:seed` — idempotently seed the dedicated eval-corpus workspace:
 * ingest the full manifest (direct in-process pipeline, no live Temporal
 * worker needed — mirrors the dogfood suite's scope decision) and load
 * fixtures/dashboard-sharing/eval-queries.csv as judged eval_queries/
 * eval_judgments, resolving each row's snippet to a real chunk's source_key.
 *
 * Requires the local stack (`pnpm infra:up`). Exits non-zero on any
 * ingestion failure or unresolved snippet — this is a verification command,
 * not just a convenience script.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { S3BlobStore } from '@threadmark/blob';
import { createChunkerRegistry } from '@threadmark/chunking';
import {
  createEvalQuery,
  createDb,
  findEvidenceDocumentByTitle,
  findOrCreateWorkspaceByName,
  getChunksByDocument,
  upsertEvalJudgment,
} from '@threadmark/db';
import { parseEvalQueries } from '@threadmark/evals';
import { createModelRouter, loadModelRouterConfig } from '@threadmark/model-router';
import { OpenSearchIndex } from '@threadmark/search';
import { CORPUS_DIR, ingestEntryDirect } from '../direct-ingest.js';
import { env } from '../env.js';
import type { IngestionDeps } from '../pipeline.js';
import { parseManifest } from './manifest.js';
import { EVAL_WORKSPACE_NAME } from '../shared.js';

async function main(): Promise<void> {
  const { db, close } = createDb(env.databaseUrl);
  const blob = new S3BlobStore({
    bucket: env.minio.bucket,
    endpoint: env.minio.endpoint,
    accessKeyId: env.minio.accessKeyId,
    secretAccessKey: env.minio.secretAccessKey,
    forcePathStyle: true,
  });
  const search = new OpenSearchIndex({ node: env.opensearchNode });
  const deps: IngestionDeps = {
    db,
    blob,
    search,
    router: createModelRouter(loadModelRouterConfig(process.env)),
    chunkers: createChunkerRegistry(),
  };

  try {
    await blob.ensureBucket();
    const workspace = await findOrCreateWorkspaceByName(db, EVAL_WORKSPACE_NAME);
    console.log(`seeding eval corpus into "${workspace.name}"…`);

    const manifestRaw = await readFile(join(CORPUS_DIR, 'manifest.csv'), 'utf8');
    const manifest = parseManifest(manifestRaw);

    let ok = 0;
    const ingestFailures: string[] = [];
    for (const entry of manifest) {
      const outcome = await ingestEntryDirect(deps, entry, workspace.id);
      if (outcome.failed) {
        ingestFailures.push(`${entry.docId}: ${outcome.error}`);
        console.error(`  ✗ ${entry.docId}: ${outcome.error}`);
      } else {
        ok++;
        console.log(`  ✓ ingested ${entry.docId} (${outcome.chunkCount} chunks)`);
      }
    }

    if (ok !== manifest.length) {
      console.error(`eval:seed FAILED: ${ingestFailures.length} document(s) failed to ingest:`);
      for (const failure of ingestFailures) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }

    const fixtureRaw = await readFile(join(CORPUS_DIR, 'eval-queries.csv'), 'utf8');
    const fixtureRows = parseEvalQueries(fixtureRaw);
    console.log(`loading ${fixtureRows.length} judged rows from eval-queries.csv…`);

    const unresolved: string[] = [];
    let judgmentsOk = 0;
    for (const row of fixtureRows) {
      const query = await createEvalQuery(db, {
        workspaceId: workspace.id,
        externalId: row.externalId,
        queryText: row.query,
        notes: row.notes,
      });

      const doc = await findEvidenceDocumentByTitle(db, workspace.id, row.docId);
      if (!doc) {
        unresolved.push(`${row.externalId} (${row.docId}): document not found`);
        continue;
      }
      const chunks = await getChunksByDocument(db, doc.id);
      const matches = chunks.filter((c) =>
        c.text.toLowerCase().includes(row.snippet.toLowerCase()),
      );
      if (matches.length !== 1) {
        unresolved.push(
          `${row.externalId} (${row.docId}): snippet "${row.snippet}" matched ` +
            `${matches.length} chunk(s), expected exactly 1`,
        );
        continue;
      }
      await upsertEvalJudgment(db, {
        queryId: query.id,
        docId: row.docId,
        chunkSourceKey: matches[0]!.sourceKey,
        relevance: row.relevance,
      });
      judgmentsOk++;
    }

    console.log(`done — ${judgmentsOk}/${fixtureRows.length} judgments resolved`);
    if (unresolved.length > 0) {
      console.error(`eval:seed FAILED: ${unresolved.length} judgment(s) could not resolve:`);
      for (const failure of unresolved) console.error(`  - ${failure}`);
      process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
