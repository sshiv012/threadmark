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
 * - Duplicate ids within `rankedIds` are de-duplicated by first occurrence
 *   before scoring, so a misbehaving retriever can't inflate its own score.
 */

function validateK(k: number): void {
  if (!Number.isInteger(k) || k <= 0) {
    throw new RangeError(`k must be a positive integer, got ${k}`);
  }
}

function dedupeFirstOccurrence(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function isRelevant(id: string, relevanceById: Map<string, number>): boolean {
  return (relevanceById.get(id) ?? 0) > 0;
}

export function precisionAtK(
  rankedIds: string[],
  relevanceById: Map<string, number>,
  k: number,
): number {
  validateK(k);
  const top = dedupeFirstOccurrence(rankedIds).slice(0, k);
  const relevantCount = top.filter((id) => isRelevant(id, relevanceById)).length;
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
  const top = dedupeFirstOccurrence(rankedIds).slice(0, k);
  const hits = top.filter((id) => isRelevant(id, relevanceById)).length;
  return hits / totalPositives;
}

export function reciprocalRank(rankedIds: string[], relevanceById: Map<string, number>): number {
  const deduped = dedupeFirstOccurrence(rankedIds);
  const rank = deduped.findIndex((id) => isRelevant(id, relevanceById));
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
  const top = dedupeFirstOccurrence(rankedIds).slice(0, k);
  const dcg = discountedGainSum(top.map((id) => relevanceById.get(id) ?? 0));

  const idealRelevances = [...relevanceById.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = discountedGainSum(idealRelevances);

  return idcg === 0 ? 0 : dcg / idcg;
}
