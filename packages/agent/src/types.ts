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
 * Injectable observability sink. This sub-PR (10.0) only ships an in-memory
 * default; PR10.1 adds a real DB-backed implementation
 * (appendAgentStep/withSpan/updateAgentStep, mirroring apps/worker's
 * withStep() shape) whose `recordStep` genuinely writes to Postgres, so the
 * return type must allow a promise — a synchronous-only contract would let
 * that implementation's rejection escape `safeRecordStep`'s best-effort
 * try/catch unawaited, and `runAgentQuery` could return before the row is
 * persisted. A recorder failure is still best-effort — see
 * `runAgentQuery`'s doc comment — it must never fail an otherwise-successful
 * run, the same way this codebase's telemetry (`withSpan`) is safe even if
 * the tracer itself is broken; the in-memory default here can keep
 * returning `void`.
 */
export interface StepRecorder {
  recordStep(step: RecordedStep): Promise<void> | void;
}
