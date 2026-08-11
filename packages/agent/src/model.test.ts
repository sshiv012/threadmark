import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('loadAgentModelConfig', () => {
  it('selects anthropic when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { loadAgentModelConfig } = await import('./config.js');
    expect(loadAgentModelConfig(process.env).provider).toBe('anthropic');
  });

  it('selects google when only GOOGLE_GENERATIVE_AI_API_KEY is set', async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';
    const { loadAgentModelConfig } = await import('./config.js');
    expect(loadAgentModelConfig(process.env).provider).toBe('google');
  });

  it('prefers anthropic when both keys are set', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';
    const { loadAgentModelConfig } = await import('./config.js');
    expect(loadAgentModelConfig(process.env).provider).toBe('anthropic');
  });

  it('throws a clear configuration error when neither key is set', async () => {
    const { loadAgentModelConfig } = await import('./config.js');
    expect(() => loadAgentModelConfig(process.env)).toThrow(
      /ANTHROPIC_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY/,
    );
  });
});

describe('buildAgentModel', () => {
  it('builds an Anthropic-backed LanguageModel for provider "anthropic"', async () => {
    const { buildAgentModel } = await import('./model.js');
    const model = buildAgentModel({ provider: 'anthropic', modelId: 'claude-sonnet-5' });
    expect(model).toBeDefined();
    if (typeof model === 'string')
      throw new Error('expected a LanguageModelV4 object, not a gateway model id string');
    expect(model.modelId).toBe('claude-sonnet-5');
  });

  it('builds a Google-backed LanguageModel for provider "google"', async () => {
    const { buildAgentModel } = await import('./model.js');
    const model = buildAgentModel({ provider: 'google', modelId: 'gemini-2.5-flash' });
    expect(model).toBeDefined();
    if (typeof model === 'string')
      throw new Error('expected a LanguageModelV4 object, not a gateway model id string');
    expect(model.modelId).toBe('gemini-2.5-flash');
  });

  it('throws a clear error for an unrecognized provider string reaching runtime unchecked', async () => {
    const { buildAgentModel } = await import('./model.js');
    expect(() => buildAgentModel({ provider: 'unsupported' as 'anthropic', modelId: 'x' })).toThrow(
      /unsupported/i,
    );
  });
});
