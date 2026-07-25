export interface FusedItem {
  id: string;
  score: number;
  /** 1-based rank in each input list, by list index (undefined if absent). */
  ranks: (number | undefined)[];
}

/**
 * Reciprocal Rank Fusion. Combines several ranked id-lists into one ranking:
 * score = Σ 1/(k + rank). `k` damps the influence of top ranks (60 is the
 * common default). Deterministic tie-break by id.
 */
export function reciprocalRankFusion(lists: string[][], k = 60): FusedItem[] {
  const scores = new Map<string, number>();
  const ranks = new Map<string, (number | undefined)[]>();

  lists.forEach((list, listIndex) => {
    // A well-formed retriever never repeats an id within one list, but guard
    // against it anyway: only the id's FIRST (best) position in this list
    // counts, so a duplicate can never earn double credit here.
    const seenInThisList = new Set<string>();
    list.forEach((id, position) => {
      if (seenInThisList.has(id)) return;
      seenInThisList.add(id);
      const rank = position + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
      const perList = ranks.get(id) ?? new Array<number | undefined>(lists.length).fill(undefined);
      perList[listIndex] = rank;
      ranks.set(id, perList);
    });
  });

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, ranks: ranks.get(id)! }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
