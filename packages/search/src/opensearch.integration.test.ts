import { afterAll, describe, expect, it } from 'vitest';
import { OpenSearchIndex } from './opensearch.js';

// Opt-in: exercises real OpenSearch. Skipped unless RUN_INTEGRATION=1.
// Run `pnpm infra:up` first.
const run = process.env.RUN_INTEGRATION === '1';
const index = 'threadmark-it-chunks';
const WS1 = 'it-ws-1';
const WS2 = 'it-ws-2';

describe.skipIf(!run)('OpenSearchIndex (integration)', () => {
  const search = new OpenSearchIndex({
    node: process.env.OPENSEARCH_NODE ?? 'http://localhost:9200',
  });

  afterAll(async () => {
    await search.deleteByDocument(index, 'd1').catch(() => undefined);
    await search.deleteByDocument(index, 'd2').catch(() => undefined);
  });

  it('indexes chunks and finds the relevant one via BM25, then deletes by document', async () => {
    await search.ensureIndex(index);
    await search.indexChunks(
      index,
      [
        {
          id: 'it-a',
          documentId: 'd1',
          workspaceId: WS1,
          text: 'the monthly billing invoice totals',
        },
        {
          id: 'it-b',
          documentId: 'd1',
          workspaceId: WS1,
          text: 'sharing dashboards externally via a public link',
        },
      ],
      { refresh: true },
    );
    const hits = await search.searchBm25(index, 'external dashboard sharing', 5, WS1);
    expect(hits[0]!.id).toBe('it-b');

    await search.deleteByDocument(index, 'd1');
    const after = await search.searchBm25(index, 'billing', 5, WS1);
    expect(after.find((h) => h.id === 'it-a')).toBeUndefined();
  }, 30_000);

  it('never returns a hit from another workspace, even with identical content', async () => {
    await search.ensureIndex(index);
    await search.indexChunks(
      index,
      [
        {
          id: 'iso-ws1',
          documentId: 'd2',
          workspaceId: WS1,
          text: 'unique isolation probe phrase zzyzx',
        },
        {
          id: 'iso-ws2',
          documentId: 'd2',
          workspaceId: WS2,
          text: 'unique isolation probe phrase zzyzx',
        },
      ],
      { refresh: true },
    );

    const ws1Hits = await search.searchBm25(index, 'unique isolation probe phrase zzyzx', 10, WS1);
    expect(ws1Hits.map((h) => h.id)).toEqual(['iso-ws1']);

    const ws2Hits = await search.searchBm25(index, 'unique isolation probe phrase zzyzx', 10, WS2);
    expect(ws2Hits.map((h) => h.id)).toEqual(['iso-ws2']);

    await search.deleteByDocument(index, 'd2');
  }, 30_000);
});
