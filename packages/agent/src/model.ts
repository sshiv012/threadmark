import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import type { AgentModelConfig } from './config.js';

/**
 * The only place that branches on provider. Both `anthropic(modelId)` and
 * `google(modelId)` resolve to the same `LanguageModel` type, so
 * `generateText()`'s call site (runAgentQuery.ts) has zero per-provider
 * branching — that's the entire point of using the SDK's abstraction.
 */
export function buildAgentModel(config: AgentModelConfig): LanguageModel {
  if (config.provider === 'anthropic') return anthropic(config.modelId);
  if (config.provider === 'google') return google(config.modelId);
  throw new Error(`unsupported agent model provider: ${(config as { provider: string }).provider}`);
}
