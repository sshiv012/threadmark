/**
 * Ingest one fixtures/dashboard-sharing manifest entry directly in-process
 * (extractAndChunk → embedChunks → indexChunks), mirroring activities.ts's
 * agent_run/agent_step orchestration (attempt=1, since there's no Temporal
 * retry loop here) without driving a live Temporal worker process.
 *
 * Shared by the dogfood integration suite and the eval-corpus seed CLI —
 * extracted so both exercise identical ingestion behavior rather than two
 * near-duplicate copies drifting apart.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendAgentStep,
  createAgentRun,
  createEvidenceDocument,
  findEvidenceDocumentByChecksum,
  updateAgentRunStatus,
  updateAgentStep,
  updateDocumentStatus,
  type AgentStepStatus,
  type EvidenceSourceType,
} from '@threadmark/db';
import type { ManifestEntry } from './cli/manifest.js';
import { inferContentType } from './helpers.js';
import * as pipeline from './pipeline.js';
import type { IngestionDeps } from './pipeline.js';

// Resolve relative to this file (not process.cwd()), which varies depending
// on how a caller is invoked (e.g. `pnpm --filter ... exec vitest` runs from
// the package dir, not the repo root).
export const CORPUS_DIR = fileURLToPath(
  new URL('../../../fixtures/dashboard-sharing', import.meta.url),
);

export interface IngestOutcome {
  entry: ManifestEntry;
  documentId: string;
  blobKey: string;
  chunkCount: number;
  failed: boolean;
  error?: string;
}

export async function ingestEntryDirect(
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
