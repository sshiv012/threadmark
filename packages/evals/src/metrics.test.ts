import { describe, expect, it } from 'vitest';
import { ndcgAtK, precisionAtK, recallAtK, reciprocalRank } from './metrics.js';

// Shared fixture used by several cases below: a mixed-relevance labeled set.
// Binarized-relevant (grade > 0): d1(3), d3(1), d4(2) — 3 total positives.
const MIXED = new Map([
  ['d1', 3],
  ['d2', 0],
  ['d3', 1],
  ['d4', 2],
  ['d5', 0],
]);
const MIXED_RANKED = ['d1', 'd2', 'd3', 'd4', 'd5'];

describe('precisionAtK', () => {
  it('computes 2/3 for a mixed-relevance top-3 slice (binarized: grade>0 counts)', () => {
    expect(precisionAtK(MIXED_RANKED, MIXED, 3)).toBeCloseTo(2 / 3, 6);
  });

  it('k=1 boundary', () => {
    expect(
      precisionAtK(
        ['a', 'b'],
        new Map([
          ['a', 1],
          ['b', 0],
        ]),
        1,
      ),
    ).toBe(1.0);
  });

  it('denominator is the fixed k, not min(k, rankedIds.length) — penalizes short result lists', () => {
    const relevanceById = new Map([
      ['a', 1],
      ['b', 0],
    ]);
    expect(precisionAtK(['a', 'b'], relevanceById, 5)).toBeCloseTo(0.2, 6);
  });

  it('empty rankedIds returns 0, not a throw', () => {
    expect(precisionAtK([], new Map([['a', 1]]), 3)).toBe(0);
  });

  it('is order- and grade-blind (binarized only) — stays flat across orderings that change nDCG', () => {
    const relevanceById = new Map([
      ['g3', 3],
      ['g1', 1],
    ]);
    expect(precisionAtK(['g3', 'g1'], relevanceById, 2)).toBe(1.0);
    expect(precisionAtK(['g1', 'g3'], relevanceById, 2)).toBe(1.0);
  });

  it('a repeated relevant id only earns credit on its first occurrence', () => {
    const relevanceById = new Map([
      ['a', 1],
      ['b', 0],
    ]);
    // Repeats are zero-gain IN PLACE, not removed: effective relevances for
    // ['a','a','b'] are [1, 0, 0] (2nd 'a' earns nothing). Top-2 -> [1,0] ->
    // 1 relevant / k=2 = 0.5 — the naive "count occurrences" answer (2/2=1.0)
    // would let a duplicated relevant id inflate its own score.
    expect(precisionAtK(['a', 'a', 'b'], relevanceById, 2)).toBeCloseTo(0.5, 6);
  });

  it('a duplicate does NOT promote a later relevant id past the k cutoff (regression)', () => {
    // [dup, dup, relevant] — if duplicates were removed before slicing (the
    // original, buggy implementation), the list would shrink to
    // [dup, relevant] and 'relevant' would be incorrectly scored as rank 2,
    // inside a k=2 cutoff. Repeats must be zero-gain IN PLACE instead, so
    // 'relevant' stays at its true rank 3, outside top-2 -> precision@2 = 0.
    const relevanceById = new Map([
      ['dup', 0],
      ['relevant', 1],
    ]);
    expect(precisionAtK(['dup', 'dup', 'relevant'], relevanceById, 2)).toBe(0);
  });

  it.each([0, -1])('throws for k=%d rather than computing off a raw negative-index slice', (k) => {
    expect(() => precisionAtK(['a', 'b', 'c'], new Map([['a', 1]]), k)).toThrow(/k must be/i);
  });
});

describe('recallAtK', () => {
  it('computes 2/3 against the FULL positive set, not just what appears in the top-k', () => {
    expect(recallAtK(MIXED_RANKED, MIXED, 3)).toBeCloseTo(2 / 3, 6);
  });

  it('denominator is the true total positive count, not capped by k or rankedIds.length', () => {
    const relevanceById = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 1],
      ['e', 0],
    ]);
    // 4 true positives (a,b,c,d); only 'a' appears in the ranked list.
    expect(recallAtK(['a', 'x', 'y'], relevanceById, 3)).toBeCloseTo(0.25, 6);
  });

  it('k larger than rankedIds.length does not change recall', () => {
    const relevanceById = new Map([
      ['a', 1],
      ['b', 0],
    ]);
    expect(recallAtK(['a', 'b'], relevanceById, 5)).toBe(1.0);
  });

  it('returns 0 (not NaN or throw) when there are zero total positives', () => {
    expect(
      recallAtK(
        ['a', 'b'],
        new Map([
          ['a', 0],
          ['b', 0],
        ]),
        3,
      ),
    ).toBe(0);
    expect(recallAtK(['a', 'b'], new Map(), 3)).toBe(0);
  });

  it.each([0, -1])('throws for k=%d', (k) => {
    expect(() => recallAtK(['a'], new Map([['a', 1]]), k)).toThrow(/k must be/i);
  });
});

describe('reciprocalRank', () => {
  const singleRelevant = new Map([['r', 2]]);

  it('first relevant id at rank 1 gives RR=1.0', () => {
    expect(reciprocalRank(['r', 'n2', 'n3'], singleRelevant)).toBe(1.0);
  });

  it('first relevant id at rank 5 gives RR=0.2', () => {
    expect(reciprocalRank(['n1', 'n2', 'n3', 'n4', 'r'], singleRelevant)).toBeCloseTo(0.2, 6);
  });

  it('no relevant id present gives RR=0', () => {
    expect(reciprocalRank(['n1', 'n2', 'n3'], singleRelevant)).toBe(0);
  });

  it('mixed fixture: first relevant (d1) at rank 1 gives RR=1.0', () => {
    expect(reciprocalRank(MIXED_RANKED, MIXED)).toBe(1.0);
  });

  it('a duplicate above the relevant id does NOT promote it — RR=1/3, not 1/2 (regression)', () => {
    // The reviewer's exact example: [x, x, relevant]. Removing duplicates
    // before scoring (the original bug) shrinks this to [x, relevant],
    // scoring 'relevant' as rank 2 (RR=1/2). Correct behavior treats the
    // repeat as a zero-gain slot in place, leaving 'relevant' at its true
    // rank 3 (RR=1/3).
    const relevanceById = new Map([
      ['x', 0],
      ['relevant', 2],
    ]);
    expect(reciprocalRank(['x', 'x', 'relevant'], relevanceById)).toBeCloseTo(1 / 3, 6);
  });
});

describe('ndcgAtK', () => {
  it('computes ≈0.7985 for the mixed-relevance top-3 slice (DCG=7.5, IDCG≈9.3928)', () => {
    expect(ndcgAtK(MIXED_RANKED, MIXED, 3)).toBeCloseTo(0.79848, 4);
  });

  it('k equal to rankedIds.length (k=5) — trailing zero-relevance ranks contribute 0 gain', () => {
    // DCG = 7/1 + 0 + 1/2 + 3/log2(5) + 0 = 8.79203; IDCG unchanged at 9.39279
    // (the extra ranks in the ideal ordering are also relevance-0).
    expect(ndcgAtK(MIXED_RANKED, MIXED, 5)).toBeCloseTo(8.79203 / 9.39279, 4);
  });

  it('perfect ranking scores exactly 1.0', () => {
    const relevanceById = new Map([
      ['a', 3],
      ['b', 2],
      ['c', 1],
      ['d', 0],
    ]);
    expect(ndcgAtK(['a', 'b', 'c', 'd'], relevanceById, 4)).toBeCloseTo(1.0, 6);
  });

  it('reverse-perfect ranking is the minimum for this multiset, ≈0.5479', () => {
    const relevanceById = new Map([
      ['a', 3],
      ['b', 2],
      ['c', 1],
      ['d', 0],
    ]);
    expect(ndcgAtK(['d', 'c', 'b', 'a'], relevanceById, 4)).toBeCloseTo(0.5479, 3);
  });

  it('ties in relevance are order-independent for IDCG', () => {
    const relevanceById = new Map([
      ['a', 2],
      ['b', 2],
      ['c', 2],
      ['d', 0],
    ]);
    const viaA = ndcgAtK(['a', 'd'], relevanceById, 2);
    const viaB = ndcgAtK(['b', 'd'], relevanceById, 2);
    expect(viaA).toBeCloseTo(viaB, 10);
  });

  it('top-ranked grade-3 vs. the same grade-3 id moved to the bottom differ in the expected direction', () => {
    const relevanceById = new Map([
      ['g3', 3],
      ['g1', 1],
    ]);
    const top = ndcgAtK(['g3', 'g1'], relevanceById, 2);
    const bottom = ndcgAtK(['g1', 'g3'], relevanceById, 2);
    expect(top).toBeCloseTo(1.0, 6);
    expect(bottom).toBeCloseTo(0.7098, 3);
    expect(bottom).toBeLessThan(top);
  });

  it('returns 0 (not NaN) when IDCG is 0 (all-zero or empty relevance map)', () => {
    expect(
      ndcgAtK(
        ['a', 'b'],
        new Map([
          ['a', 0],
          ['b', 0],
        ]),
        2,
      ),
    ).toBe(0);
    expect(ndcgAtK(['a', 'b'], new Map(), 2)).toBe(0);
  });

  it('a duplicate does NOT promote a below-cutoff relevant id into the nDCG@k window (regression)', () => {
    // 'relevant' sits at true rank 3, outside a k=2 cutoff. Removing the
    // duplicate before scoring (the original bug) would pull it into rank 2
    // and give it nDCG credit it never earned; treating the repeat as an
    // in-place zero-gain slot correctly keeps it out of the top-2 window.
    const relevanceById = new Map([
      ['x', 0],
      ['relevant', 3],
    ]);
    expect(ndcgAtK(['x', 'x', 'relevant'], relevanceById, 2)).toBe(0);
  });

  it.each([0, -1])('throws for k=%d', (k) => {
    expect(() => ndcgAtK(['a'], new Map([['a', 1]]), k)).toThrow(/k must be/i);
  });
});
