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
});
