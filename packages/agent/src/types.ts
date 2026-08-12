/**
 * Public result of a single cited-Q&A run. `citedChunkIds` are `[chunk:id]`
 * markers in the answer that match a chunk id actually returned by
 * `search_evidence` THIS run; `unverifiedCitations` are markers that don't —
 * a structural (not semantic) hallucination check. Deeper "does the cited
 * chunk actually support the claim" grounding verification is out of scope
 * here (a future eval-tier-2 concern, riding the reserved
 * `eval_report_kind.trajectory` value).
 */
export interface AgentAnswer {
  readonly answer: string;
  readonly citedChunkIds: string[];
  readonly unverifiedCitations: string[];
  readonly toolCalled: boolean;
}

/**
 * Why a recorded step failed. Distinguishing these matters: an
 * 'authorization_denied' or 'invalid_query' step failure is the tool
 * working correctly (the run still completes normally); an
 * 'infrastructure_error' step failure means the run itself must fail —
 * never represented as a trustworthy "no evidence found" answer.
 */
export type StepErrorCode = 'authorization_denied' | 'invalid_query' | 'infrastructure_error';

export interface RecordedStep {
  readonly ord: number;
  readonly kind: 'tool_call' | 'final_answer';
  readonly toolName?: string;
  readonly status: 'success' | 'failed';
  readonly error?: string;
  readonly errorCode?: StepErrorCode;
}

/**
 * Injectable observability sink. PR10.0 shipped an in-memory default; PR10.1
 * adds `createDbStepRecorder` — a real Postgres-backed implementation
 * (appendAgentStep/withSpan, mirroring apps/worker's withStep() shape,
 * without the insert-then-update-completion split since a step here is
 * already fully resolved by the time it's recorded — see dbStepRecorder.ts).
 * The return type allows a promise because a real DB-backed recorder
 * genuinely writes to Postgres: a synchronous-only contract would let its
 * rejection escape `safeRecordStep`'s best-effort try/catch unawaited, and
 * `runAgentQuery` could return before the row is persisted. A recorder
 * failure is still best-effort — see `runAgentQuery`'s doc comment — it
 * must never fail an otherwise-successful run, the same way this codebase's
 * telemetry (`withSpan`) is safe even if the tracer itself is broken.
 * Returning a promise is optional: the in-memory recorder stays synchronous.
 */
export interface StepRecorder {
  recordStep(step: RecordedStep): Promise<void> | void;
}
