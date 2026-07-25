import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  describe('telemetry', () => {
    let exporter: InMemorySpanExporter;
    let provider: NodeTracerProvider;

    beforeEach(() => {
      exporter = new InMemorySpanExporter();
      provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      provider.register();
    });

    afterEach(() => {
      trace.disable();
      exporter.reset();
    });

    it('wraps generate/embed/rerank each in their own span with provider+model attributes', async () => {
      const router = createModelRouter(stubConfig);
      await router.generate({ prompt: 'x' });
      await router.embed({ input: ['x'] });
      await router.rerank({ query: 'x', documents: [{ id: 'a', text: 'x' }] });

      const spans = exporter.getFinishedSpans();
      const names = spans.map((s) => s.name).sort();
      expect(names).toEqual(['model_router.embed', 'model_router.generate', 'model_router.rerank']);

      const embedSpan = spans.find((s) => s.name === 'model_router.embed')!;
      expect(embedSpan.attributes['model_router.provider']).toBe('stub');
      expect(embedSpan.attributes['model_router.model']).toBe('stub');

      const rerankSpan = spans.find((s) => s.name === 'model_router.rerank')!;
      expect(rerankSpan.attributes['model_router.provider']).toBe('stub');
      expect(rerankSpan.attributes['model_router.model']).toBe('stub');

      const generateSpan = spans.find((s) => s.name === 'model_router.generate')!;
      expect(generateSpan.attributes['model_router.provider']).toBe('stub');
    });

    it('wraps each capability independently — calling only embed produces only one span', async () => {
      const router = createModelRouter(stubConfig);
      await router.embed({ input: ['x'] });

      const names = exporter.getFinishedSpans().map((s) => s.name);
      expect(names).toEqual(['model_router.embed']);
    });

    it('rethrows the original error unchanged and marks the span as an error', async () => {
      const throwing: ModelRouterConfig = {
        ...stubConfig,
        embedding: { provider: 'stub', dimensions: 384 },
      };
      const router = createModelRouter(throwing);
      const original = new Error('embedding blew up');
      router.providers.embedding.embed = () => Promise.reject(original);

      await expect(router.embed({ input: ['x'] })).rejects.toBe(original);
      const [span] = exporter.getFinishedSpans();
      expect(span!.status.code).toBe(2); // SpanStatusCode.ERROR
    });

    it('never puts raw prompt/input/document text on any span attribute', async () => {
      const router = createModelRouter(stubConfig);
      const marker = 'SECRET_MARKER_XYZ';
      await router.generate({ prompt: marker });
      await router.embed({ input: [marker] });
      await router.rerank({ query: marker, documents: [{ id: 'a', text: marker }] });

      for (const span of exporter.getFinishedSpans()) {
        for (const value of Object.values(span.attributes)) {
          expect(String(value)).not.toContain(marker);
        }
      }
    });
  });
});
