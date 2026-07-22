import { describe, expect, it, vi } from 'vitest';
import { GeminiGenerationProvider } from './gemini.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GeminiGenerationProvider', () => {
  it('maps a generateContent response to text', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        candidates: [
          { content: { parts: [{ text: 'Hello ' }, { text: 'world' }] }, finishReason: 'STOP' },
        ],
      }),
    );
    const p = new GeminiGenerationProvider({
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      fetch: fetchMock,
    });
    const res = await p.generate({ prompt: 'hi', system: 'be brief', temperature: 0.2 });
    expect(res.text).toBe('Hello world');
    expect(res.finishReason).toBe('STOP');
    expect(res.model).toBe('gemini-2.5-flash');
  });

  it('calls the correct endpoint with prompt + system + generationConfig', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );
    const p = new GeminiGenerationProvider({ apiKey: 'secret', fetch: fetchMock });
    await p.generate({ prompt: 'question', system: 'sys', temperature: 0.5, maxOutputTokens: 128 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('models/gemini-2.5-flash:generateContent');
    expect(url).toContain('key=secret');
    const body = JSON.parse(init!.body as string);
    expect(body.contents[0].parts[0].text).toBe('question');
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.generationConfig.temperature).toBe(0.5);
    expect(body.generationConfig.maxOutputTokens).toBe(128);
  });

  it('throws on a non-OK response, surfacing the API message', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, 400));
    const p = new GeminiGenerationProvider({ apiKey: 'k', fetch: fetchMock });
    await expect(p.generate({ prompt: 'x' })).rejects.toThrow(/bad key/);
  });

  it('throws when no candidate text is returned (e.g. safety block)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ candidates: [] }));
    const p = new GeminiGenerationProvider({ apiKey: 'k', fetch: fetchMock });
    await expect(p.generate({ prompt: 'x' })).rejects.toThrow();
  });
});
