import { describe, expect, it } from 'vitest';
import { inferContentType, inferSourceType } from './helpers.js';

describe('inferSourceType', () => {
  it('maps evidence folders to source types', () => {
    expect(inferSourceType('fixtures/dashboard-sharing/interviews/a.md')).toBe('interview');
    expect(inferSourceType('x/support-tickets/t.md')).toBe('support_ticket');
    expect(inferSourceType('x/prior-prd/p.md')).toBe('prior_prd');
    expect(inferSourceType('x/analytics/u.csv')).toBe('analytics');
  });

  it('falls back by extension, then to other', () => {
    expect(inferSourceType('random/data.csv')).toBe('analytics');
    expect(inferSourceType('random/notes.md')).toBe('other');
  });
});

describe('inferContentType', () => {
  it('maps known extensions', () => {
    expect(inferContentType('a.md')).toBe('text/markdown');
    expect(inferContentType('a.csv')).toBe('text/csv');
    expect(inferContentType('a.txt')).toBe('text/plain');
    expect(inferContentType('a.bin')).toBe('application/octet-stream');
  });
});
