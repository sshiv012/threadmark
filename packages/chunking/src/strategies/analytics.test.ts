import { describe, expect, it } from 'vitest';
import type { ExtractedDocument } from '../types.js';
import { AnalyticsChunker } from './analytics.js';

const chunker = new AnalyticsChunker();
const opts = { maxTokens: 1000, overlapTokens: 100 };
const doc = (text: string): ExtractedDocument => ({ sourceType: 'analytics', text });

const csv = `feature,requests,quarter
external_sharing,42,Q1
sso,17,Q2`;

describe('AnalyticsChunker', () => {
  it('emits one chunk per row, keyed by the first column, with header context', async () => {
    const out = await chunker.chunk(doc(csv), opts);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.sourceKey)).toEqual(['row:external_sharing', 'row:sso']);
    expect(out[0]!.text).toContain('requests: 42');
    expect(out[0]!.text).toContain('quarter: Q1');
    expect(out[0]!.metadata?.requests).toBe('42');
  });

  it('respects quoted fields containing commas', async () => {
    const quoted = `name,note\nalpha,"a, b, c"`;
    const out = await chunker.chunk(doc(quoted), opts);
    expect(out).toHaveLength(1);
    expect(out[0]!.metadata?.note).toBe('a, b, c');
  });

  it('falls back to token-window when the text is not CSV-like', async () => {
    const out = await chunker.chunk(doc('no commas here just prose'), opts);
    expect(out[0]!.sourceKey.startsWith('win:')).toBe(true);
  });
});
