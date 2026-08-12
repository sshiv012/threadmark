import { appendAgentStep, type Database } from '@threadmark/db';
import { withSpan } from '@threadmark/telemetry';
import type { RecordedStep, StepRecorder } from './types.js';

/**
 * Real Postgres-backed `StepRecorder`, one instance bound to a single
 * `agent_runs.id`. Unlike apps/worker's `withStep()` (which brackets LIVE
 * work — insert as 'running', do the work, then update to
 * completed/failed), a `RecordedStep` here is already fully resolved by the
 * time `recordStep` is called (the tool call already ran inside
 * `generateText()`) — so this does a single insert with the final status
 * already known, rather than an insert-then-update pair that would only add
 * a round trip without adding any real observability. The `withSpan` wrap
 * still gives trace correlation (span duration reflects DB write latency,
 * not tool-call latency — that's expected here).
 */
export function createDbStepRecorder(db: Database, runId: string): StepRecorder {
  return {
    async recordStep(step: RecordedStep): Promise<void> {
      const type = step.kind === 'tool_call' ? (step.toolName ?? 'tool_call') : 'final_answer';
      await withSpan(
        `agent_step.${type}`,
        {
          'agent_step.run_id': runId,
          'agent_step.ord': step.ord,
          'agent_step.attempt': 1,
        },
        async () => {
          await appendAgentStep(db, {
            runId,
            ord: step.ord,
            type,
            // No Temporal here — every call is attempt 1, there is no
            // retry-attempt concept in a single in-process runAgentQuery call.
            attempt: 1,
            status: step.status === 'success' ? 'completed' : 'failed',
            error: step.error ?? null,
            errorCode: step.errorCode ?? null,
            endedAt: new Date(),
          });
        },
      );
    },
  };
}
