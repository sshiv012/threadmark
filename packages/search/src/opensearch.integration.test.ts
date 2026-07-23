import { afterAll, describe, expect, it } from 'vitest';
import { OpenSearchIndex } from './opensearch.js';

// Opt-in: exercises real OpenSearch. Skipped unless RUN_INTEGRATION=1.
// Run `pnpm infra:up` first.
const run = process.env.RUN_INTEGRATION === '1';
const index = 'threadmark-it-chunks';

describe.skipIf(!run)('OpenSearchIndex (integration)', () => {
  const search = new OpenSearchIndex({
    node: process.env.OPENSEARCH_NODE ?? 'http://localhost:9200',
  });

  afterAll(async () => {
    await search.deleteByDocument(index, 'd1').catch(() => undefined);
  });

  it('indexes chunks and finds the relevant one via BM25, then deletes by document', async () => {
    await search.ensureIndex(index);
    await search.indexChunks(index, [
      { id: 'it-a', documentId: 'd1', text: 'the monthly billing invoice totals' },
      { id: 'it-b', documentId: 'd1', text: 'sharing dashboards externally via a public link' },
    ]);
    const hits = await search.searchBm25(index, 'external dashboard sharing', 5);
    expect(hits[0]!.id).toBe('it-b');

    await search.deleteByDocument(index, 'd1');
    const after = await search.searchBm25(index, 'billing', 5);
    expect(after.find((h) => h.id === 'it-a')).toBeUndefined();
  }, 30_000);
});
