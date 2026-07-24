import type { Client } from '@opensearch-project/opensearch';
import { describe, expect, it, vi } from 'vitest';
import { OpenSearchIndex } from './opensearch.js';

// Unit test the bulk-error handling with an injected fake client (offline).
describe('OpenSearchIndex.indexChunks error handling', () => {
  it('throws with the failed chunk ids when a bulk item fails', async () => {
    const bulk = vi.fn(async () => ({
      body: {
        errors: true,
        items: [
          { index: { _id: 'ok-1' } },
          { index: { _id: 'bad-2', error: { type: 'mapper_parsing_exception' } } },
        ],
      },
    }));
    const fakeClient = { bulk } as unknown as Client;
    const index = new OpenSearchIndex({ client: fakeClient });

    await expect(
      index.indexChunks('chunks', [
        { id: 'ok-1', documentId: 'd', text: 'a' },
        { id: 'bad-2', documentId: 'd', text: 'b' },
      ]),
    ).rejects.toThrow(/bad-2/);
  });

  it('does not refresh by default', async () => {
    const bulk = vi.fn(async (_params: { body: unknown; refresh?: boolean }) => ({
      body: { errors: false, items: [] },
    }));
    const fakeClient = { bulk } as unknown as Client;
    const index = new OpenSearchIndex({ client: fakeClient });

    await index.indexChunks('chunks', [{ id: 'x', documentId: 'd', text: 't' }]);
    expect(bulk.mock.calls[0]![0]).toMatchObject({ refresh: false });
  });
});
