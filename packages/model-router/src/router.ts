/**
 * Assemble a ModelRouter from a validated config. This is the only place that
 * decides which concrete provider backs each capability.
 */
import type { ModelRouterConfig } from './config.js';
import { GeminiGenerationProvider } from './providers/gemini.js';
import {
  StubEmbeddingProvider,
  StubGenerationProvider,
  StubRerankProvider,
} from './providers/stub.js';
import {
  TransformersEmbeddingProvider,
  TransformersRerankProvider,
} from './providers/transformers.js';
import type {
  EmbeddingProvider,
  GenerationProvider,
  ModelRouter,
  RerankProvider,
} from './types.js';

function buildGeneration(config: ModelRouterConfig['generation']): GenerationProvider {
  if (config.provider === 'gemini') {
    if (!config.apiKey) {
      throw new Error('Gemini generation requires an API key (set GEMINI_API_KEY)');
    }
    return new GeminiGenerationProvider(
      config.model !== undefined
        ? { apiKey: config.apiKey, model: config.model }
        : { apiKey: config.apiKey },
    );
  }
  return new StubGenerationProvider();
}

function buildEmbedding(config: ModelRouterConfig['embedding']): EmbeddingProvider {
  if (config.provider === 'transformers') {
    return new TransformersEmbeddingProvider(
      config.model !== undefined
        ? { dimensions: config.dimensions, model: config.model }
        : { dimensions: config.dimensions },
    );
  }
  return new StubEmbeddingProvider(config.dimensions);
}

function buildRerank(config: ModelRouterConfig['rerank']): RerankProvider {
  if (config.provider === 'transformers') {
    return new TransformersRerankProvider(
      config.model !== undefined ? { model: config.model } : {},
    );
  }
  return new StubRerankProvider();
}

export function createModelRouter(config: ModelRouterConfig): ModelRouter {
  const generation = buildGeneration(config.generation);
  const embedding = buildEmbedding(config.embedding);
  const rerank = buildRerank(config.rerank);
  return {
    providers: { generation, embedding, rerank },
    generate: (request) => generation.generate(request),
    embed: (request) => embedding.embed(request),
    rerank: (request) => rerank.rerank(request),
  };
}
