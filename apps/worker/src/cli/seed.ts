/**
 * `pnpm seed` — ingest the whole dogfood corpus into the Dev Workspace.
 *
 * Requires the local stack (`pnpm infra:up`) and a running worker (`pnpm worker`).
 */
import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { S3BlobStore } from '@threadmark/blob';
import { createDb, findOrCreateWorkspaceByName } from '@threadmark/db';
import { env } from '../env.js';
import { ingestFile } from '../ingest-file.js';

const CORPUS_DIR = resolve('fixtures/dashboard-sharing');
const INGESTIBLE = new Set(['.md', '.csv', '.txt']);
const SKIP = new Set(['README.md', 'manifest.csv']);

async function main(): Promise<void> {
  const entries = await readdir(CORPUS_DIR, { recursive: true });
  const files = entries
    .filter((rel) => INGESTIBLE.has(extname(rel)) && !SKIP.has(rel.split('/').pop() ?? ''))
    .map((rel) => join(CORPUS_DIR, rel))
    .sort();

  const { db, close } = createDb(env.databaseUrl);
  const blob = new S3BlobStore({
    bucket: env.minio.bucket,
    endpoint: env.minio.endpoint,
    accessKeyId: env.minio.accessKeyId,
    secretAccessKey: env.minio.secretAccessKey,
    forcePathStyle: true,
  });

  try {
    await blob.ensureBucket();
    const workspace = await findOrCreateWorkspaceByName(db, 'Dev Workspace');
    console.log(`seeding ${files.length} documents into "${workspace.name}"…`);
    let ok = 0;
    for (const file of files) {
      try {
        const result = await ingestFile({ db, blob, workspaceId: workspace.id }, file);
        ok++;
        console.log(
          `  ✓ ${result.reused ? 'reused' : 'ingested'} ${file.replace(CORPUS_DIR + '/', '')}`,
        );
      } catch (error) {
        console.error(`  ✗ ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`done — ${ok}/${files.length} succeeded`);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
