import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNKING_OPTIONS, type ExtractedDocument } from '../types.js';
import { TokenWindowChunker } from './token-window.js';

const chunker = new TokenWindowChunker();
const doc = (text: string): ExtractedDocument => ({ sourceType: 'other', text });

describe('TokenWindowChunker', () => {
  it('returns a single chunk when the text fits one window', async () => {
    const out = await chunker.chunk(doc('one two three'), { maxTokens: 10, overlapTokens: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('one two three');
    expect(out[0]!.tokenCount).toBe(3);
    expect(out[0]!.ord).toBe(0);
  });

  it('splits into overlapping windows', async () => {
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`).join(' ');
    const out = await chunker.chunk(doc(words), { maxTokens: 5, overlapTokens: 2 });
    expect(out.map((c) => c.ord)).toEqual([0, 1, 2]);
    expect(out[0]!.text).toBe('w0 w1 w2 w3 w4');
    expect(out[1]!.text).toBe('w3 w4 w5 w6 w7');
    expect(out[2]!.text).toBe('w6 w7 w8 w9');
    // adjacent windows overlap by overlapTokens words
    expect(out[0]!.text.split(' ').slice(-2)).toEqual(out[1]!.text.split(' ').slice(0, 2));
  });

  it('is deterministic and content-addressed', async () => {
    const a = await chunker.chunk(doc('alpha beta gamma'), DEFAULT_CHUNKING_OPTIONS);
    const b = await chunker.chunk(doc('alpha beta gamma'), DEFAULT_CHUNKING_OPTIONS);
    expect(a[0]!.contentHash).toBe(b[0]!.contentHash);
    expect(a[0]!.contentHash).toMatch(/^[0-9a-f]+$/);
  });

  it('returns nothing for empty text', async () => {
    expect(await chunker.chunk(doc('   '), DEFAULT_CHUNKING_OPTIONS)).toEqual([]);
  });
});
