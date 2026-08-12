import { getConflictPolicy, type ConflictResolutionStrategy, type Database } from '@threadmark/db';

export interface ConflictPolicy {
  strategy: ConflictResolutionStrategy;
  config: unknown;
}

/** Thin wrapper over the repo function — deliberately does NOT catch/swallow.
 *  The best-effort/fallback decision (what happens if this rejects) belongs
 *  to the caller (runAgentQuery), not here, mirroring the same separation
 *  of concerns PR10.1 established between dbStepRecorder (never swallows)
 *  and safeRecordStep (the caller's best-effort wrapper). */
export async function fetchConflictPolicy(
  db: Database,
  workspaceId: string,
): Promise<ConflictPolicy> {
  return getConflictPolicy(db, workspaceId);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string');
}

/**
 * Pure function: policy -> a persona-prompt-appendable instruction. No
 * hidden state, no I/O — calling it twice with the same policy always
 * produces the same string.
 *
 * `config.sourceTypePriority` is validated defensively here too (not just at
 * the PATCH API boundary) since this function has no guarantee its caller
 * validated first — a missing/empty/malformed value falls back to
 * flag_for_review-style language rather than rendering "undefined" or
 * crashing.
 *
 * IMPORTANT — this instruction is advisory only, never enforced. Nothing in
 * `runAgentQuery` checks that the model actually applied the configured
 * strategy, resolved a real disagreement correctly, or emitted a
 * `[conflict: ...]` tag at all. The only structural check that exists is
 * citation *existence*: any chunk id inside a `[conflict: ...]` tag is
 * verified against ids `search_evidence` actually returned this run, exactly
 * like a bare `[chunk:id]` citation — that catches a hallucinated chunk id,
 * not a wrong or silently-skipped conflict resolution. A model that ignores
 * this instruction entirely still produces a successfully completed run.
 */
export function renderPolicyInstruction(policy: ConflictPolicy): string {
  if (policy.strategy === 'most_recent') {
    return (
      'If retrieved evidence disagrees on a fact, prefer the source with the latest creation date, ' +
      'but you MUST name every disagreeing source in your answer, not only the one you used. Mark ' +
      'any conflict you resolve with a tag like [conflict: chunk:A vs chunk:B → resolved chunk:A via most_recent].'
    );
  }

  if (policy.strategy === 'highest_priority_source') {
    const config = policy.config as { sourceTypePriority?: unknown } | null | undefined;
    const priority = config?.sourceTypePriority;
    if (isNonEmptyStringArray(priority)) {
      return (
        `If retrieved evidence disagrees on a fact, prefer sources in this priority order: ` +
        `${priority.join(', ')}. You MUST name every disagreeing source in your answer, not only ` +
        'the one you used. Mark any conflict you resolve with a tag like ' +
        '[conflict: chunk:A vs chunk:B → resolved chunk:A via highest_priority_source].'
      );
    }
    // No usable priority configured — fall back to the safe default rather
    // than silently picking or rendering a broken instruction.
    return renderPolicyInstruction({ strategy: 'flag_for_review', config: {} });
  }

  // 'flag_for_review' (also the default fallback above).
  return (
    'If retrieved evidence disagrees on a fact, do not pick one — say so explicitly and list all ' +
    'disagreeing sources. Mark any conflict with a tag like ' +
    '[conflict: chunk:A vs chunk:B → flagged for review].'
  );
}
