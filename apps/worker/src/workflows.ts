/**
 * Deterministic workflow code. It only sequences activities (via
 * proxyActivities) — no I/O, no Date.now/random. Bundled by the worker and
 * replayed by Temporal, so it must stay deterministic.
 *
 * PR5b-3a: a trivial pipeline (queued → ready) proving the harness. The real
 * extract→chunk→embed→index sequence + agent-run observability lands in 5b-3b.
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities.js';
import type { IngestionWorkflowInput } from './shared.js';

const { markDocumentReady } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

export async function ingestionWorkflow(input: IngestionWorkflowInput): Promise<void> {
  await markDocumentReady(input.documentId);
}
