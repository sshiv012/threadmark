/**
 * Temporal activities — the only place ingestion touches the outside world.
 * Each wraps a pipeline step with an agent_step record (one row per attempt, so
 * retries stay visible) and the matching document status transition.
 */
import { Context } from '@temporalio/activity';
import { S3BlobStore } from '@threadmark/blob';
import { createChunkerRegistry } from '@threadmark/chunking';
import {
  appendAgentStep,
  createAgentRun,
  createDb,
  getEvidenceDocument,
  updateAgentRunStatus,
  updateAgentStep,
  updateDocumentStatus,
  type Database,
} from '@threadmark/db';
import { createModelRouter, loadModelRouterConfig } from '@threadmark/model-router';
import { OpenSearchIndex } from '@threadmark/search';
import { withSpan } from '@threadmark/telemetry';
import { env } from './env.js';
import * as pipeline from './pipeline.js';
import type { IngestionDeps } from './pipeline.js';
import type { StepInput } from './shared.js';

// Module-level singletons: activities run in the long-lived worker process.
const { db } = createDb(env.databaseUrl);
const blob = new S3BlobStore({
  bucket: env.minio.bucket,
  endpoint: env.minio.endpoint,
  accessKeyId: env.minio.accessKeyId,
  secretAccessKey: env.minio.secretAccessKey,
  forcePathStyle: true,
});
const search = new OpenSearchIndex({ node: env.opensearchNode });
const router = createModelRouter(loadModelRouterConfig(process.env));
const chunkers = createChunkerRegistry();
const deps: IngestionDeps = { db, blob, search, router, chunkers };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Record one agent_step per attempt (Temporal retries → distinct rows) and
 * wrap the attempt in a matching OTel span — one call site feeds both the DB
 * projection (UI) and the OTel backend (ops). `db` is a parameter (not the
 * module-level singleton) so this is independently unit-testable.
 */
export async function withStep(
  db: Database,
  input: StepInput,
  type: string,
  run: () => Promise<number>,
): Promise<number> {
  const attempt = Context.current().info.attempt;
  const step = await appendAgentStep(db, {
    runId: input.runId,
    ord: input.ord,
    type,
    attempt,
    status: 'running',
  });
  return withSpan(
    `agent_step.${type}`,
    {
      'agent_step.run_id': input.runId,
      'agent_step.step_id': step.id,
      'agent_step.ord': input.ord,
      'agent_step.attempt': attempt,
    },
    async () => {
      try {
        const count = await run();
        await updateAgentStep(db, step.id, { status: 'completed', outputSummary: String(count) });
        return count;
      } catch (error) {
        await updateAgentStep(db, step.id, { status: 'failed', error: errorMessage(error) });
        throw error;
      }
    },
  );
}

export async function beginRun(documentId: string): Promise<{ runId: string }> {
  const document = await getEvidenceDocument(db, documentId);
  if (!document) throw new Error(`document not found: ${documentId}`);
  const run = await createAgentRun(db, {
    workspaceId: document.workspaceId,
    kind: 'ingestion',
    subjectId: documentId,
  });
  return { runId: run.id };
}

export async function extractAndChunk(input: StepInput): Promise<number> {
  await updateDocumentStatus(db, input.documentId, 'chunking');
  return withStep(db, input, 'extractAndChunk', () =>
    pipeline.extractAndChunk(deps, input.documentId),
  );
}

export async function embedChunks(input: StepInput): Promise<number> {
  await updateDocumentStatus(db, input.documentId, 'embedding');
  return withStep(db, input, 'embedChunks', () => pipeline.embedChunks(deps, input.documentId));
}

export async function indexChunks(input: StepInput): Promise<number> {
  await updateDocumentStatus(db, input.documentId, 'indexing');
  return withStep(db, input, 'indexChunks', () => pipeline.indexChunks(deps, input.documentId));
}

export async function finishRun(input: { documentId: string; runId: string }): Promise<void> {
  await updateDocumentStatus(db, input.documentId, 'ready');
  await updateAgentRunStatus(db, input.runId, 'completed', new Date());
}

export async function failRun(input: {
  documentId: string;
  runId: string;
  reason: string;
}): Promise<void> {
  await updateDocumentStatus(db, input.documentId, 'failed', input.reason);
  await updateAgentRunStatus(db, input.runId, 'failed', new Date());
}
