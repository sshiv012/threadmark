import { describe, expect, it } from 'vitest';
import { hashContent, heuristicTokenCounter, slug } from './tokens.js';

describe('heuristicTokenCounter', () => {
  it('counts whitespace-separated words', () => {
    expect(heuristicTokenCounter.count('one two three')).toBe(3);
    expect(heuristicTokenCounter.count('   ')).toBe(0);
  });
});

describe('hashContent', () => {
  it('ignores insignificant whitespace and is deterministic', () => {
    expect(hashContent('a b')).toBe(hashContent('a   b'));
    expect(hashContent('a b')).toBe(hashContent('  a b  '));
  });
  it('changes when the meaningful content changes', () => {
    expect(hashContent('a b')).not.toBe(hashContent('a c'));
    expect(hashContent('a b')).toMatch(/^[0-9a-f]+$/);
  });
});

describe('slug', () => {
  it('lowercases and hyphenates', () => {
    expect(slug('External Dashboard Sharing!')).toBe('external-dashboard-sharing');
  });
});
