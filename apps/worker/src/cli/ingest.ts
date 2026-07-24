/**
 * `pnpm ingest <file>` — store a file as evidence and run the ingestion workflow.
 *
 * Requires the local stack (`pnpm infra:up`) and a running worker
 * (`pnpm --filter @threadmark/worker worker`). Run: from repo root,
 * `pnpm ingest fixtures/dashboard-sharing/interviews/interview-northwind-dana.md`
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { S3BlobStore } from '@threadmark/blob';
import { createDb, createEvidenceDocument, findOrCreateWorkspaceByName } from '@threadmark/db';
import { runIngestionWorkflow } from '../client.js';
import { env } from '../env.js';
import { inferContentType, inferSourceType } from '../helpers.js';

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: pnpm ingest <file>');
    process.exit(1);
  }

  const filePath = resolve(input);
  const bytes = await readFile(filePath);
  const fileName = basename(filePath);
  const checksum = createHash('sha256').update(bytes).digest('hex');

  const { db, close } = createDb(env.databaseUrl);
  const blob = new S3BlobStore({
    bucket: env.minio.bucket,
    endpoint: env.minio.endpoint,
    accessKeyId: env.minio.accessKeyId,
    secretAccessKey: env.minio.secretAccessKey,
    forcePathStyle: true,
  });

  try {
    const workspace = await findOrCreateWorkspaceByName(db, 'Dev Workspace');

    await blob.ensureBucket();
    const key = `${workspace.id}/${checksum}-${fileName}`;
    const { uri } = await blob.put(key, bytes, inferContentType(filePath));

    const document = await createEvidenceDocument(db, {
      workspaceId: workspace.id,
      sourceType: inferSourceType(filePath),
      title: fileName,
      blobUri: uri,
      checksum,
    });
    console.log(`created document ${document.id} (${document.sourceType}) → ${uri}`);

    const workflowId = await runIngestionWorkflow({ documentId: document.id });
    console.log(`✓ ingestion complete — workflow ${workflowId}`);
    console.log(`  Temporal UI: http://localhost:8233/namespaces/default/workflows/${workflowId}`);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
