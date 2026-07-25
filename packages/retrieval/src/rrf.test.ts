import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from './rrf.js';

describe('reciprocalRankFusion', () => {
  it('rewards items ranked highly across lists', () => {
    // "b" is top of list 2 and 2nd in list 1 → should win.
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'd'],
    ]);
    expect(fused[0]!.id).toBe('b');
    expect(fused.map((f) => f.id)).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
  });

  it('records per-list ranks and is deterministic', () => {
    const fused = reciprocalRankFusion([['x', 'y'], ['y']]);
    const y = fused.find((f) => f.id === 'y')!;
    expect(y.ranks).toEqual([2, 1]);
    const x = fused.find((f) => f.id === 'x')!;
    expect(x.ranks).toEqual([1, undefined]);
  });

  it('returns an empty ranking for no lists', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it('does not give an id double credit when it appears twice in the same list', () => {
    // "dup" appears twice in list 1 (a bug scenario, not something a well-formed
    // retriever should produce) — its score must equal a single first-place
    // credit (1/(k+1)), not the sum of two positions.
    const withDup = reciprocalRankFusion([['dup', 'dup', 'other']]);
    const withoutDup = reciprocalRankFusion([['dup', 'other']]);
    const dupScore = withDup.find((f) => f.id === 'dup')!.score;
    const noDupScore = withoutDup.find((f) => f.id === 'dup')!.score;
    expect(dupScore).toBeCloseTo(noDupScore);
  });

  it('handles duplicate ids across different lists without inflation beyond normal fusion', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b'],
      ['a', 'b'],
    ]);
    // "a" is #1 in both lists → its score is the sum of two genuinely distinct
    // list contributions, which IS correct fusion (not the same as the
    // same-list-duplicate case above).
    const a = fused.find((f) => f.id === 'a')!;
    expect(a.score).toBeCloseTo(2 / (60 + 1));
  });
});
