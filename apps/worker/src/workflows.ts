/**
 * Deterministic workflow code. It only sequences activities (via
 * proxyActivities) — no I/O, no Date.now/random. Bundled by the worker and
 * replayed by Temporal, so it must stay deterministic.
 *
 * IngestionWorkflow: begin run → extract+chunk → embed → index → finish. On any
 * failure (after per-activity retries), the run + document are marked failed and
 * the error is rethrown so the workflow surfaces it.
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities.js';
import type { IngestionWorkflowInput } from './shared.js';

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function ingestionWorkflow(input: IngestionWorkflowInput): Promise<void> {
  const { documentId } = input;
  const { runId } = await acts.beginRun(documentId);
  try {
    await acts.extractAndChunk({ documentId, runId, ord: 0 });
    await acts.embedChunks({ documentId, runId, ord: 1 });
    await acts.indexChunks({ documentId, runId, ord: 2 });
    await acts.finishRun({ documentId, runId });
  } catch (error) {
    await acts.failRun({ documentId, runId, reason: errorMessage(error) });
    throw error;
  }
}
