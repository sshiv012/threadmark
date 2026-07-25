import type { Client } from '@opensearch-project/opensearch';
import { describe, expect, it, vi } from 'vitest';
import { OpenSearchIndex } from './opensearch.js';

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
        { id: 'ok-1', documentId: 'd', workspaceId: 'ws-1', text: 'a' },
        { id: 'bad-2', documentId: 'd', workspaceId: 'ws-1', text: 'b' },
      ]),
    ).rejects.toThrow(/bad-2/);
  });

  it('does not refresh by default', async () => {
    const bulk = vi.fn(async (_params: { body: unknown; refresh?: boolean }) => ({
      body: { errors: false, items: [] },
    }));
    const fakeClient = { bulk } as unknown as Client;
    const index = new OpenSearchIndex({ client: fakeClient });

    await index.indexChunks('chunks', [
      { id: 'x', documentId: 'd', workspaceId: 'ws-1', text: 't' },
    ]);
    expect(bulk.mock.calls[0]![0]).toMatchObject({ refresh: false });
  });

  it('includes workspaceId in the indexed document body', async () => {
    const bulk = vi.fn(async (_params: { body: unknown[] }) => ({
      body: { errors: false, items: [] },
    }));
    const fakeClient = { bulk } as unknown as Client;
    const index = new OpenSearchIndex({ client: fakeClient });

    await index.indexChunks('chunks', [
      { id: 'x', documentId: 'd', workspaceId: 'ws-42', text: 't' },
    ]);
    const body = bulk.mock.calls[0]![0].body as unknown[];
    // body is [actionMeta, source, actionMeta, source, ...]
    expect(body[1]).toMatchObject({ workspaceId: 'ws-42' });
  });
});

describe('OpenSearchIndex.searchBm25 workspace scoping', () => {
  it('sends a workspaceId term filter alongside the text match', async () => {
    const search = vi.fn(async (_params: { index: string; body: { query: unknown } }) => ({
      body: { hits: { hits: [] } },
    }));
    const fakeClient = { search } as unknown as Client;
    const index = new OpenSearchIndex({ client: fakeClient });

    await index.searchBm25('chunks', 'external sharing', 10, 'ws-42');

    const params = search.mock.calls[0]![0];
    const query = JSON.stringify(params.body.query);
    expect(query).toContain('ws-42');
    expect(query).toMatch(/workspaceId/);
  });
});
