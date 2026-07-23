import { describe, expect, it } from 'vitest';
import { InMemorySearchIndex } from './in-memory.js';

const chunks = [
  { id: 'a', documentId: 'd1', text: 'billing invoice totals' },
  { id: 'b', documentId: 'd1', text: 'external dashboard sharing feature' },
  { id: 'c', documentId: 'd2', text: 'dashboard access control' },
];

describe('InMemorySearchIndex', () => {
  it('ranks by query-term overlap, descending', async () => {
    const idx = new InMemorySearchIndex();
    await idx.ensureIndex('chunks');
    await idx.indexChunks('chunks', chunks);
    const hits = await idx.searchBm25('chunks', 'external dashboard sharing', 10);
    expect(hits.map((h) => h.id)).toEqual(['b', 'c']);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  it('respects topK and omits non-matches', async () => {
    const idx = new InMemorySearchIndex();
    await idx.indexChunks('chunks', chunks);
    const hits = await idx.searchBm25('chunks', 'dashboard', 1);
    expect(hits).toHaveLength(1);
  });

  it('deletes all chunks for a document', async () => {
    const idx = new InMemorySearchIndex();
    await idx.indexChunks('chunks', chunks);
    await idx.deleteByDocument('chunks', 'd1');
    const hits = await idx.searchBm25('chunks', 'dashboard', 10);
    expect(hits.map((h) => h.id)).toEqual(['c']);
  });
});
