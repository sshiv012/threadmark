/**
 * Gemini generation over the REST generateContent endpoint.
 *
 * Uses an injectable `fetch` so it can be unit-tested with a canned response —
 * no network, no key. The real Gemini SDK is intentionally not a dependency.
 */
import type { GenerationProvider, GenerationRequest, GenerationResult } from '../types.js';

/** Minimal fetch shape we depend on (keeps injection ergonomic in tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
}

async function extractApiError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: { message?: string } };
    return data.error?.message ?? JSON.stringify(data);
  } catch {
    return response.statusText;
  }
}

export class GeminiGenerationProvider implements GenerationProvider {
  readonly name = 'gemini';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(options: GeminiOptions) {
    if (!options.apiKey) {
      throw new Error('Gemini requires an API key');
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const generationConfig: Record<string, number> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxOutputTokens;
    }

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
    };
    if (request.system !== undefined) {
      body.systemInstruction = { parts: [{ text: request.system }] };
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Gemini generateContent failed (${response.status}): ${await extractApiError(response)}`,
      );
    }

    const data = (await response.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');
    if (!text) {
      throw new Error('Gemini returned no text (empty candidates or safety block)');
    }

    const finishReason = candidate?.finishReason;
    return finishReason !== undefined
      ? { text, model: this.model, finishReason }
      : { text, model: this.model };
  }
}
