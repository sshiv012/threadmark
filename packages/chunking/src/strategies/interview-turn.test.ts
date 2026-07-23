import { describe, expect, it } from 'vitest';
import type { ExtractedDocument } from '../types.js';
import { InterviewTurnChunker } from './interview-turn.js';

const chunker = new InterviewTurnChunker();
const opts = { maxTokens: 1000, overlapTokens: 100 };
const doc = (text: string): ExtractedDocument => ({ sourceType: 'interview', text });

const transcript = `Alice: We really need external dashboard sharing.
It keeps coming up with customers.
Bob: Agreed, and it must respect access controls.
Alice: Right, no public data leaks.`;

describe('InterviewTurnChunker', () => {
  it('splits into speaker turns with speaker metadata', async () => {
    const out = await chunker.chunk(doc(transcript), opts);
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.sourceKey)).toEqual(['turn:0', 'turn:1', 'turn:2']);
    expect(out.map((c) => c.metadata?.speaker)).toEqual(['Alice', 'Bob', 'Alice']);
    // continuation line stays with its turn
    expect(out[0]!.text).toContain('keeps coming up');
    expect(out[0]!.hierarchy).toEqual(['Alice']);
  });

  it('falls back to token-window when there are no speaker labels', async () => {
    const out = await chunker.chunk(doc('just a plain paragraph with no speakers here'), opts);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]!.sourceKey.startsWith('win:')).toBe(true);
  });
});
