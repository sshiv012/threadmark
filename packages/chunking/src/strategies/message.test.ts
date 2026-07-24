import { describe, expect, it } from 'vitest';
import type { ExtractedDocument } from '../types.js';
import { MessageChunker } from './message.js';

const chunker = new MessageChunker();
const opts = { maxTokens: 1000, overlapTokens: 100 };
const doc = (text: string): ExtractedDocument => ({ sourceType: 'support_ticket', text });

const ticket = `From: customer@acme.com
We need to share dashboards with external stakeholders.

From: support
A public sharing link is on the roadmap.`;

describe('MessageChunker', () => {
  it('splits into messages with author metadata', async () => {
    const out = await chunker.chunk(doc(ticket), opts);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.sourceKey)).toEqual(['msg:0', 'msg:1']);
    expect(out[0]!.metadata?.author).toBe('customer@acme.com');
    expect(out[1]!.metadata?.author).toBe('support');
    expect(out[0]!.text).toContain('external stakeholders');
  });

  it('handles --- separators between messages', async () => {
    const out = await chunker.chunk(doc('first message\n---\nsecond message'), opts);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.text)).toEqual(['first message', 'second message']);
  });
});
