import { describe, expect, it } from 'vitest';
import { loadModelRouterConfig, modelRouterConfigSchema } from './config.js';

describe('loadModelRouterConfig', () => {
  it('defaults everything to stub when no GEMINI_API_KEY is present (boots offline)', () => {
    const cfg = loadModelRouterConfig({});
    expect(cfg.generation.provider).toBe('stub');
    expect(cfg.embedding.provider).toBe('stub');
    expect(cfg.rerank.provider).toBe('stub');
    expect(cfg.embedding.dimensions).toBe(384);
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
