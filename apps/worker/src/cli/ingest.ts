/**
 * `pnpm ingest <file>` — store a file as evidence and run the ingestion workflow.
 *
 * Requires the local stack (`pnpm infra:up`) and a running worker (`pnpm worker`).
 */
import { resolve } from 'node:path';
import { S3BlobStore } from '@threadmark/blob';
import { createDb, findOrCreateWorkspaceByName } from '@threadmark/db';
import { env } from '../env.js';
import { ingestFile } from '../ingest-file.js';

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: pnpm ingest <file>');
    process.exit(1);
  }

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
    const result = await ingestFile({ db, blob, workspaceId: workspace.id }, resolve(input));
    console.log(`✓ ${result.reused ? 'reused' : 'ingested'} document ${result.documentId}`);
    console.log(
      `  Temporal UI: http://localhost:8233/namespaces/default/workflows/${result.workflowId}`,
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
