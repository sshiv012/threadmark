import { describe, expect, it } from 'vitest';
import { loadModelRouterConfig, modelRouterConfigSchema } from './config.js';

describe('loadModelRouterConfig', () => {
  it('defaults generation to stub (no key) and embedding/rerank to local transformers', () => {
    const cfg = loadModelRouterConfig({});
    expect(cfg.generation.provider).toBe('stub');
    expect(cfg.embedding.provider).toBe('transformers');
    expect(cfg.rerank.provider).toBe('transformers');
    expect(cfg.embedding.dimensions).toBe(384);
  });

  it('allows forcing stub embedding/rerank via env (fast offline dev)', () => {
    const cfg = loadModelRouterConfig({
      MODEL_EMBEDDING_PROVIDER: 'stub',
      MODEL_RERANK_PROVIDER: 'stub',
    });
    expect(cfg.embedding.provider).toBe('stub');
    expect(cfg.rerank.provider).toBe('stub');
  });

  it('defaults generation to gemini when a key is present', () => {
    const cfg = loadModelRouterConfig({ GEMINI_API_KEY: 'k' });
    expect(cfg.generation.provider).toBe('gemini');
    expect(cfg.generation.apiKey).toBe('k');
  });

  it('honors an explicit generation provider even when a key is present', () => {
    const cfg = loadModelRouterConfig({ MODEL_GENERATION_PROVIDER: 'stub', GEMINI_API_KEY: 'k' });
    expect(cfg.generation.provider).toBe('stub');
  });

  it('reads a custom embedding dimension', () => {
    const cfg = loadModelRouterConfig({ MODEL_EMBEDDING_DIMENSIONS: '768' });
    expect(cfg.embedding.dimensions).toBe(768);
  });

  it('reads custom embedding and rerank model names from env', () => {
    const cfg = loadModelRouterConfig({
      MODEL_EMBEDDING_MODEL: 'Xenova/bge-base-en-v1.5',
      MODEL_RERANK_MODEL: 'Xenova/bge-reranker-large',
    });
    expect(cfg.embedding.model).toBe('Xenova/bge-base-en-v1.5');
    expect(cfg.rerank.model).toBe('Xenova/bge-reranker-large');
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      modelRouterConfigSchema.parse({
        generation: { provider: 'openai' },
        embedding: { provider: 'stub', dimensions: 384 },
        rerank: { provider: 'stub' },
      }),
    ).toThrow();
  });
});
