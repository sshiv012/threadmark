export type AgentProvider = 'anthropic' | 'google';

export interface AgentModelConfig {
  readonly provider: AgentProvider;
  readonly modelId: string;
}

const DEFAULT_MODEL_ID: Record<AgentProvider, string> = {
  anthropic: 'claude-sonnet-5',
  google: 'gemini-2.5-flash',
};

/**
 * Env-driven provider selection, mirroring
 * packages/model-router/src/config.ts's pattern. Anthropic wins if both keys
 * are set (arbitrary but stated tie-break, not a quality judgment).
 * `GOOGLE_GENERATIVE_AI_API_KEY` is the Vercel AI SDK's real default env var
 * name for @ai-sdk/google — distinct from model-router's own `GEMINI_API_KEY`,
 * which is a hand-rolled REST client, not this SDK.
 */
export function loadAgentModelConfig(env: NodeJS.ProcessEnv = process.env): AgentModelConfig {
  if (env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      modelId: env.AGENT_ANTHROPIC_MODEL_ID ?? DEFAULT_MODEL_ID.anthropic,
    };
  }
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return { provider: 'google', modelId: env.AGENT_GOOGLE_MODEL_ID ?? DEFAULT_MODEL_ID.google };
  }
  throw new Error(
    'no agent model provider configured — set ANTHROPIC_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY (see .env.example)',
  );
}
