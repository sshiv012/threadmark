import { describe, expect, it } from 'vitest';
import { createModelRouter } from './router.js';
import type { ModelRouterConfig } from './config.js';

const stubConfig: ModelRouterConfig = {
  generation: { provider: 'stub' },
  embedding: { provider: 'stub', dimensions: 384 },
  rerank: { provider: 'stub' },
};

describe('createModelRouter', () => {
  it('wires stub providers for all three capabilities', async () => {
    const router = createModelRouter(stubConfig);
    expect((await router.generate({ prompt: 'x' })).model).toBe('stub');
    expect((await router.embed({ input: ['x'] })).dimensions).toBe(384);
    const reranked = await router.rerank({ query: 'x', documents: [{ id: 'a', text: 'x' }] });
    expect(reranked.results).toHaveLength(1);
    expect(router.providers.embedding.name).toBe('stub');
  });

  it('builds a Gemini generation provider when configured with a key', () => {
    const router = createModelRouter({
      ...stubConfig,
      generation: { provider: 'gemini', apiKey: 'k' },
    });
    expect(router.providers.generation.name).toBe('gemini');
  });

  it('throws if gemini generation is configured without an api key', () => {
    expect(() => createModelRouter({ ...stubConfig, generation: { provider: 'gemini' } })).toThrow(
      /api key/i,
    );
  });
});
