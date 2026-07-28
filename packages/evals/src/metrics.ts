/**
 * Pure information-retrieval metrics — no DB, no I/O, no randomness. Generic
 * string ids and a plain relevance map (not RetrievedChunk[] or any
 * @threadmark/retrieval type) are deliberate: a future trajectory/LLM-judge
 * eval tier over agent traces can reuse these exact functions unchanged,
 * passing agent/step ids and judge grades instead of chunk ids.
 *
 * Conventions (see PR7.1 design notes for the reasoning):
 * - An id in `rankedIds` absent from `relevanceById` is relevance 0.
 * - precisionAtK / recallAtK / reciprocalRank use BINARIZED relevance
 *   (grade > 0 = relevant); ndcgAtK uses the full graded scale for gain.
 * - precisionAtK's denominator is the fixed `k`, not min(k, rankedIds.length)
 *   — returning fewer than k candidates is penalized, not forgiven.
 * - recallAtK's denominator is the count of relevance>0 across the FULL
 *   relevanceById map, not just what appears in rankedIds.
 * - ndcgAtK's gain function is 2^rel - 1 (exponential/TREC-standard).
 * - Degenerate 0/0 cases (zero total positives; IDCG=0) return 0, never NaN.
 * - `k` must be a positive integer; k<=0 throws rather than computing off a
 *   raw `Array.slice(0,k)` (negative k drops from the END in JS, not an
 *   empty prefix — a real landmine if left unvalidated).
 * - A repeated id within `rankedIds` never earns credit past its FIRST
 *   occurrence, but — critically — repeats are NOT removed from the list
 *   before applying the k cutoff. Removing them first would shrink the list
 *   and promote later, genuinely-lower-ranked results into better rank
 *   slots than they earned (e.g. [dup, dup, relevant] with the dup at rank
 *   1-2 would incorrectly score `relevant` as if it were rank 2, not its
 *   true rank 3, inflating precision/recall/MRR/nDCG in the process — the
 *   opposite of the "can't inflate its own score" goal). Repeats are instead
 *   treated as a zero-gain slot IN PLACE, preserving every other id's true
 *   rank position.
 */

function validateK(k: number): void {
  if (!Number.isInteger(k) || k <= 0) {
    throw new RangeError(`k must be a positive integer, got ${k}`);
  }
}

/**
 * Per-position relevance for scoring: the real graded relevance for an id's
 * first occurrence, 0 for every occurrence after that, and 0 for an id
 * absent from `relevanceById` — same length and order as `rankedIds`, so no
 * rank position is ever shifted or removed.
 */
function effectiveRelevances(rankedIds: string[], relevanceById: Map<string, number>): number[] {
  const seen = new Set<string>();
  return rankedIds.map((id) => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return relevanceById.get(id) ?? 0;
  });
}

export function precisionAtK(
  rankedIds: string[],
  relevanceById: Map<string, number>,
  k: number,
): number {
  validateK(k);
  const top = effectiveRelevances(rankedIds, relevanceById).slice(0, k);
  const relevantCount = top.filter((rel) => rel > 0).length;
  return relevantCount / k;
}

export function recallAtK(
  rankedIds: string[],
  relevanceById: Map<string, number>,
  k: number,
): number {
  validateK(k);
  const totalPositives = [...relevanceById.values()].filter((rel) => rel > 0).length;
  if (totalPositives === 0) return 0;
  const top = effectiveRelevances(rankedIds, relevanceById).slice(0, k);
  const hits = top.filter((rel) => rel > 0).length;
  return hits / totalPositives;
}

export function reciprocalRank(rankedIds: string[], relevanceById: Map<string, number>): number {
  const relevances = effectiveRelevances(rankedIds, relevanceById);
  const rank = relevances.findIndex((rel) => rel > 0);
  return rank === -1 ? 0 : 1 / (rank + 1);
}

function gain(relevance: number): number {
  return 2 ** relevance - 1;
}

function discountedGainSum(relevances: number[]): number {
  return relevances.reduce((sum, rel, i) => sum + gain(rel) / Math.log2(i + 2), 0);
}

export function ndcgAtK(
  rankedIds: string[],
  relevanceById: Map<string, number>,
  k: number,
): number {
  validateK(k);
  const top = effectiveRelevances(rankedIds, relevanceById).slice(0, k);
  const dcg = discountedGainSum(top);

  const idealRelevances = [...relevanceById.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = discountedGainSum(idealRelevances);

  return idcg === 0 ? 0 : dcg / idcg;
}
