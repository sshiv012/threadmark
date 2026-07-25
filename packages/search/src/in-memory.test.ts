import { describe, expect, it } from 'vitest';
import { InMemorySearchIndex } from './in-memory.js';

const WS1 = 'ws-1';
const WS2 = 'ws-2';

const chunks = [
  { id: 'a', documentId: 'd1', workspaceId: WS1, text: 'billing invoice totals' },
  { id: 'b', documentId: 'd1', workspaceId: WS1, text: 'external dashboard sharing feature' },
  { id: 'c', documentId: 'd2', workspaceId: WS1, text: 'dashboard access control' },
];

describe('InMemorySearchIndex', () => {
  it('ranks by query-term overlap, descending', async () => {
    const idx = new InMemorySearchIndex();
    await idx.ensureIndex('chunks');
    await idx.indexChunks('chunks', chunks);
    const hits = await idx.searchBm25('chunks', 'external dashboard sharing', 10, WS1);
    expect(hits.map((h) => h.id)).toEqual(['b', 'c']);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  it('respects topK and omits non-matches', async () => {
    const idx = new InMemorySearchIndex();
    await idx.indexChunks('chunks', chunks);
    const hits = await idx.searchBm25('chunks', 'dashboard', 1, WS1);
    expect(hits).toHaveLength(1);
  });

  it('deletes all chunks for a document', async () => {
    const idx = new InMemorySearchIndex();
    await idx.indexChunks('chunks', chunks);
    await idx.deleteByDocument('chunks', 'd1');
    const hits = await idx.searchBm25('chunks', 'dashboard', 10, WS1);
    expect(hits.map((h) => h.id)).toEqual(['c']);
  });

  describe('workspace isolation', () => {
    it('never returns a hit from another workspace, even with lexically similar content', async () => {
      const idx = new InMemorySearchIndex();
      await idx.indexChunks('chunks', [
        {
          id: 'ws1-a',
          documentId: 'd1',
          workspaceId: WS1,
          text: 'external dashboard sharing access controls',
        },
        {
          id: 'ws2-a',
          documentId: 'd2',
          workspaceId: WS2,
          text: 'external dashboard sharing access controls',
        },
      ]);

      const ws1Hits = await idx.searchBm25('chunks', 'external dashboard sharing', 10, WS1);
      expect(ws1Hits.map((h) => h.id)).toEqual(['ws1-a']);

      const ws2Hits = await idx.searchBm25('chunks', 'external dashboard sharing', 10, WS2);
      expect(ws2Hits.map((h) => h.id)).toEqual(['ws2-a']);
    });

    it('returns no hits for a workspace with no matching content, even if another workspace does', async () => {
      const idx = new InMemorySearchIndex();
      await idx.indexChunks('chunks', [
        { id: 'ws1-a', documentId: 'd1', workspaceId: WS1, text: 'external dashboard sharing' },
      ]);
      const hits = await idx.searchBm25('chunks', 'external dashboard sharing', 10, WS2);
      expect(hits).toEqual([]);
    });
  });
});
