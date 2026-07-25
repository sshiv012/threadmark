import { describe, expect, it } from 'vitest';
import {
  TransformersEmbeddingProvider,
  TransformersRerankProvider,
  type CrossEncoder,
  type FeatureExtractor,
} from './transformers.js';

// ── Unit tests: inject fake models so the transformation logic is verified
// offline (no weight download, runs in CI). ─────────────────────────────────
describe('TransformersEmbeddingProvider (injected)', () => {
  const fakeExtractor =
    (dim: number): FeatureExtractor =>
    (texts) =>
      Promise.resolve({ tolist: () => texts.map(() => new Array<number>(dim).fill(0.5)) });

  it('returns number[][] with the configured dimension', async () => {
    const provider = new TransformersEmbeddingProvider({
      dimensions: 4,
      load: () => Promise.resolve(fakeExtractor(4)),
    });
    const { vectors, dimensions, model } = await provider.embed({ input: ['a', 'b'] });
    expect(dimensions).toBe(4);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(model).toContain('bge-small');
  });

  it('lazy-loads the model once across calls', async () => {
    let loads = 0;
    const provider = new TransformersEmbeddingProvider({
      dimensions: 1,
      load: () => {
        loads++;
        return Promise.resolve(fakeExtractor(1));
      },
    });
    await provider.embed({ input: ['a'] });
    await provider.embed({ input: ['b'] });
    expect(loads).toBe(1);
  });

  it('throws if the model dimension disagrees with config', async () => {
    const provider = new TransformersEmbeddingProvider({
      dimensions: 384,
      load: () => Promise.resolve(fakeExtractor(3)),
    });
    await expect(provider.embed({ input: ['a'] })).rejects.toThrow(/dimension/i);
  });

  it('returns empty for empty input without loading the model', async () => {
    const provider = new TransformersEmbeddingProvider({
      dimensions: 4,
      load: () => Promise.reject(new Error('should not load')),
    });
    expect((await provider.embed({ input: [] })).vectors).toEqual([]);
  });
});

describe('TransformersRerankProvider (injected)', () => {
  // The fake stands in for the real cross-encoder, which emits raw logits
  // (unbounded reals) — these values are deliberately NOT in (0,1) so tests
  // prove the provider normalizes them, rather than merely being consistent
  // with an already-normalized fake.
  const fakeEncoder: CrossEncoder = {
    score: (_query, documents) =>
      Promise.resolve(documents.map((d) => (d.includes('good') ? 4.5 : -3.2))),
  };

  it('sorts by cross-encoder score descending', async () => {
    const provider = new TransformersRerankProvider({ load: () => Promise.resolve(fakeEncoder) });
    const { results } = await provider.rerank({
      query: 'q',
      documents: [
        { id: 'a', text: 'bad' },
        { id: 'b', text: 'good match' },
        { id: 'c', text: 'bad' },
      ],
    });
    expect(results.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('normalizes raw logits to a (0,1) relevance score (sigmoid)', async () => {
    const provider = new TransformersRerankProvider({ load: () => Promise.resolve(fakeEncoder) });
    const { results } = await provider.rerank({
      query: 'q',
      documents: [
        { id: 'a', text: 'bad' },
        { id: 'b', text: 'good match' },
      ],
    });
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(1);
    }
    const good = results.find((r) => r.id === 'b')!;
    const bad = results.find((r) => r.id === 'a')!;
    expect(good.score).toBeCloseTo(1 / (1 + Math.exp(-4.5)), 6);
    expect(bad.score).toBeCloseTo(1 / (1 + Math.exp(3.2)), 6);
  });

  it('respects topK with stable tie-breaking', async () => {
    const provider = new TransformersRerankProvider({ load: () => Promise.resolve(fakeEncoder) });
    const { results } = await provider.rerank({
      query: 'q',
      documents: [
        { id: 'a', text: 'bad' },
        { id: 'b', text: 'bad' },
        { id: 'c', text: 'good' },
      ],
      topK: 2,
    });
    expect(results.map((r) => r.id)).toEqual(['c', 'a']);
  });
});

// ── Integration tests: exercise the REAL models. Skipped unless
// RUN_MODEL_INTEGRATION=1 (they download ONNX weights and are slow). ─────────
const runIntegration = process.env.RUN_MODEL_INTEGRATION === '1';

describe.skipIf(!runIntegration)('Transformers integration (real models)', () => {
  it('bge-small produces 384-dim deterministic embeddings', async () => {
    const provider = new TransformersEmbeddingProvider({ dimensions: 384 });
    const first = await provider.embed({ input: ['external dashboard sharing'] });
    expect(first.vectors[0]).toHaveLength(384);
    const second = await provider.embed({ input: ['external dashboard sharing'] });
    expect(second.vectors[0]).toEqual(first.vectors[0]);
  }, 180_000);

  it('bge-reranker ranks a relevant doc above an irrelevant one', async () => {
    const provider = new TransformersRerankProvider();
    const { results } = await provider.rerank({
      query: 'how do I share a dashboard externally',
      documents: [
        { id: 'rel', text: 'You can share dashboards with external users via a public link.' },
        { id: 'irr', text: 'The billing cycle resets on the first of each month.' },
      ],
    });
    expect(results[0]!.id).toBe('rel');
  }, 180_000);
});
