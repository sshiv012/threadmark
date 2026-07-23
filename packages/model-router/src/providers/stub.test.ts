import { describe, expect, it } from 'vitest';
import { StubEmbeddingProvider, StubGenerationProvider, StubRerankProvider } from './stub.js';

describe('StubGenerationProvider', () => {
  it('is deterministic for the same request', async () => {
    const p = new StubGenerationProvider();
    expect((await p.generate({ prompt: 'hello' })).text).toBe(
      (await p.generate({ prompt: 'hello' })).text,
    );
    expect((await p.generate({ prompt: 'hello' })).model).toBe('stub');
  });

  it('varies output by prompt', async () => {
    const p = new StubGenerationProvider();
    expect((await p.generate({ prompt: 'hello' })).text).not.toBe(
      (await p.generate({ prompt: 'world' })).text,
    );
  });
});

describe('StubEmbeddingProvider', () => {
  it('produces vectors of the configured dimension', async () => {
    const p = new StubEmbeddingProvider(384);
    const { vectors, dimensions } = await p.embed({ input: ['a', 'b'] });
    expect(dimensions).toBe(384);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(384);
  });

  it('is deterministic and L2-normalized', async () => {
    const p = new StubEmbeddingProvider(16);
    const one = (await p.embed({ input: ['same'] })).vectors[0]!;
    const two = (await p.embed({ input: ['same'] })).vectors[0]!;
    expect(one).toEqual(two);
    const norm = Math.sqrt(one.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('different inputs yield different vectors', async () => {
    const p = new StubEmbeddingProvider(16);
    expect((await p.embed({ input: ['a'] })).vectors[0]).not.toEqual(
      (await p.embed({ input: ['b'] })).vectors[0],
    );
  });
});

describe('StubRerankProvider', () => {
  it('ranks by lexical overlap with the query, descending', async () => {
    const p = new StubRerankProvider();
    const { results } = await p.rerank({
      query: 'dashboard sharing external',
      documents: [
        { id: 'a', text: 'unrelated content about billing' },
        { id: 'b', text: 'external dashboard sharing feature request' },
        { id: 'c', text: 'dashboard access' },
      ],
    });
    expect(results.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });

  it('respects topK', async () => {
    const p = new StubRerankProvider();
    const { results } = await p.rerank({
      query: 'x',
      documents: [
        { id: 'a', text: 'x' },
        { id: 'b', text: 'y' },
        { id: 'c', text: 'z' },
      ],
      topK: 2,
    });
    expect(results).toHaveLength(2);
  });

  it('is deterministic with stable tie-breaking by original index', async () => {
    const p = new StubRerankProvider();
    const documents = [
      { id: 'a', text: 'none' },
      { id: 'b', text: 'none' },
    ];
    const r1 = await p.rerank({ query: 'zzz', documents });
    const r2 = await p.rerank({ query: 'zzz', documents });
    expect(r1.results.map((r) => r.id)).toEqual(r2.results.map((r) => r.id));
    expect(r1.results.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
