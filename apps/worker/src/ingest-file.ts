/** Shared "ingest one file" used by both the ingest CLI and the seed script. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BlobStore } from '@threadmark/blob';
import {
  createEvidenceDocument,
  findEvidenceDocumentByChecksum,
  type Database,
} from '@threadmark/db';
import { runIngestionWorkflow } from './client.js';
import { inferContentType, inferSourceType } from './helpers.js';

export interface IngestContext {
  db: Database;
  blob: BlobStore;
  workspaceId: string;
}

export interface IngestResult {
  documentId: string;
  reused: boolean;
  workflowId: string;
}

export async function ingestFile(ctx: IngestContext, filePath: string): Promise<IngestResult> {
  const bytes = await readFile(filePath);
  const fileName = basename(filePath);
  const checksum = createHash('sha256').update(bytes).digest('hex');

  const key = `${ctx.workspaceId}/${checksum}-${fileName}`;
  const { uri } = await ctx.blob.put(key, bytes, inferContentType(filePath));

  // Idempotent by (workspace, checksum): re-ingesting reuses the document.
  const existing = await findEvidenceDocumentByChecksum(ctx.db, ctx.workspaceId, checksum);
  const document =
    existing ??
    (await createEvidenceDocument(ctx.db, {
      workspaceId: ctx.workspaceId,
      sourceType: inferSourceType(filePath),
      title: fileName,
      blobUri: uri,
      checksum,
    }));

  const workflowId = await runIngestionWorkflow({ documentId: document.id });
  return { documentId: document.id, reused: existing !== undefined, workflowId };
}
