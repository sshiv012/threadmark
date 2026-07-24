import { describe, expect, it } from 'vitest';
import type { ExtractedDocument } from '../types.js';
import { MarkdownChunker } from './markdown.js';

const chunker = new MarkdownChunker();
const opts = { maxTokens: 1000, overlapTokens: 100 };
const md = `# Overview
Intro text.

## Goals
Goal body here.

## Risks
Risk body here.`;

const doc = (text: string): ExtractedDocument => ({ sourceType: 'product_doc', text });

describe('MarkdownChunker', () => {
  it('splits by heading sections with a hierarchy path', async () => {
    const out = await chunker.chunk(doc(md), opts);
    const keys = out.map((c) => c.sourceKey);
    expect(keys).toContain('overview');
    expect(keys).toContain('overview>goals');
    expect(keys).toContain('overview>risks');
    const goals = out.find((c) => c.sourceKey === 'overview>goals')!;
    expect(goals.hierarchy).toEqual(['Overview', 'Goals']);
    expect(goals.text).toContain('Goal body');
  });

  it('keeps earlier chunks stable when a later section is edited', async () => {
    const before = await chunker.chunk(doc(md), opts);
    const after = await chunker.chunk(
      doc(md.replace('Risk body here.', 'Completely different risk content.')),
      opts,
    );
    const b = before.find((c) => c.sourceKey === 'overview>goals')!;
    const a = after.find((c) => c.sourceKey === 'overview>goals')!;
    expect(a.contentHash).toBe(b.contentHash); // unchanged section → no re-embed
  });

  it('keeps earlier chunks stable when a new section is inserted after', async () => {
    const before = await chunker.chunk(doc(md), opts);
    const after = await chunker.chunk(doc(`${md}\n\n## Appendix\nExtra.`), opts);
    const b = before.find((c) => c.sourceKey === 'overview>goals')!;
    const a = after.find((c) => c.sourceKey === 'overview>goals')!;
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('falls back to windowing for oversized sections, preserving the heading path', async () => {
    const big = `# Big\n${Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')}`;
    const out = await chunker.chunk(doc(big), { maxTokens: 10, overlapTokens: 2 });
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((c) => c.sourceKey.startsWith('big'))).toBe(true);
    expect(out.every((c) => c.hierarchy?.[0] === 'Big')).toBe(true);
  });
});
