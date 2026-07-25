/**
 * `pnpm run seed` — ingest the whole dogfood corpus (per manifest.csv) into
 * the Dev Workspace.
 *
 * Requires the local stack (`pnpm infra:up`) and a running worker (`pnpm worker`).
 * Exits non-zero if any document fails to ingest, or if the ingested count
 * doesn't match the manifest — this is a verification command, not just a
 * convenience script, so a partial failure must be visible to a caller/CI.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { S3BlobStore } from '@threadmark/blob';
import { createDb, findOrCreateWorkspaceByName } from '@threadmark/db';
import { env } from '../env.js';
import { ingestFile } from '../ingest-file.js';
import { parseManifest } from './manifest.js';

const CORPUS_DIR = resolve('fixtures/dashboard-sharing');

async function main(): Promise<void> {
  const manifestRaw = await readFile(join(CORPUS_DIR, 'manifest.csv'), 'utf8');
  const manifest = parseManifest(manifestRaw);

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
    console.log(
      `seeding ${manifest.length} documents (per manifest.csv) into "${workspace.name}"…`,
    );

    let ok = 0;
    const failures: string[] = [];
    for (const entry of manifest) {
      const file = join(CORPUS_DIR, entry.path);
      try {
        const result = await ingestFile({ db, blob, workspaceId: workspace.id }, file);
        ok++;
        console.log(`  ✓ ${result.reused ? 'reused' : 'ingested'} ${entry.docId} (${entry.path})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${entry.docId} (${entry.path}): ${message}`);
        console.error(`  ✗ ${entry.docId} (${entry.path}): ${message}`);
      }
    }

    console.log(`done — ${ok}/${manifest.length} succeeded`);
    if (ok !== manifest.length) {
      console.error(
        `seed FAILED: expected ${manifest.length} documents per manifest.csv, ` +
          `only ${ok} succeeded (${failures.length} failure(s)):`,
      );
      for (const failure of failures) console.error(`  - ${failure}`);
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
