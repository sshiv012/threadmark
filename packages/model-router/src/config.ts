/**
 * Config for the model router. Providers are selected here and validated with
 * Zod so misconfiguration fails fast at startup.
 *
 * PR4 ships stub (all three capabilities) + Gemini generation. The
 * 'transformers' and 'gemini' embedding/rerank providers arrive in PR4b and
 * will extend these enums.
 */
import { z } from 'zod';

const generationSchema = z.object({
  provider: z.enum(['gemini', 'stub']),
  model: z.string().optional(),
  apiKey: z.string().optional(),
});

const embeddingSchema = z.object({
  provider: z.enum(['transformers', 'stub']),
  model: z.string().optional(),
  dimensions: z.number().int().positive().default(384),
});

const rerankSchema = z.object({
  provider: z.enum(['transformers', 'stub']),
  model: z.string().optional(),
});

export const modelRouterConfigSchema = z.object({
  generation: generationSchema,
  embedding: embeddingSchema,
  rerank: rerankSchema,
});

export type ModelRouterConfig = z.infer<typeof modelRouterConfigSchema>;

/**
 * Build a validated config from an environment map. Generation falls back to
 * `stub` unless GEMINI_API_KEY is set. Embedding and rerank default to the local
 * `transformers` models (keyless; weights download once on first use); set
 * MODEL_EMBEDDING_PROVIDER / MODEL_RERANK_PROVIDER to `stub` for fast offline dev.
 *
 * Model names are overridable without touching code:
 *   generation → GEMINI_MODEL
 *   embedding  → MODEL_EMBEDDING_MODEL
 *   rerank     → MODEL_RERANK_MODEL
 */
export function loadModelRouterConfig(env: Record<string, string | undefined>): ModelRouterConfig {
  const hasGeminiKey = Boolean(env.GEMINI_API_KEY);
  const generationProvider = env.MODEL_GENERATION_PROVIDER ?? (hasGeminiKey ? 'gemini' : 'stub');

  return modelRouterConfigSchema.parse({
    generation: {
      provider: generationProvider,
      ...(env.GEMINI_MODEL !== undefined ? { model: env.GEMINI_MODEL } : {}),
      ...(env.GEMINI_API_KEY !== undefined ? { apiKey: env.GEMINI_API_KEY } : {}),
    },
    embedding: {
      provider: env.MODEL_EMBEDDING_PROVIDER ?? 'transformers',
      ...(env.MODEL_EMBEDDING_MODEL !== undefined ? { model: env.MODEL_EMBEDDING_MODEL } : {}),
      ...(env.MODEL_EMBEDDING_DIMENSIONS !== undefined
        ? { dimensions: Number(env.MODEL_EMBEDDING_DIMENSIONS) }
        : {}),
    },
    rerank: {
      provider: env.MODEL_RERANK_PROVIDER ?? 'transformers',
      ...(env.MODEL_RERANK_MODEL !== undefined ? { model: env.MODEL_RERANK_MODEL } : {}),
    },
  });
}
