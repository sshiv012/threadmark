/**
 * Deterministic, dependency-free providers. Same input → same output, so the
 * system boots and the eval harness runs with no API keys and no network.
 * These are the default when no real provider is configured.
 */
import { createHash } from 'node:crypto';
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
  RerankProvider,
  RerankRequest,
  RerankResult,
  RerankScore,
} from '../types.js';

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export class StubGenerationProvider implements GenerationProvider {
  readonly name = 'stub';

  generate(request: GenerationRequest): Promise<GenerationResult> {
    const digest = createHash('sha256')
      .update(`${request.system ?? ''}\n${request.prompt}`)
      .digest('hex')
      .slice(0, 16);
    return Promise.resolve({ text: `stub-generation:${digest}`, model: this.name });
  }
}

export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'stub';

  constructor(readonly dimensions: number) {}

  embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return Promise.resolve({
      vectors: request.input.map((text) => this.vectorFor(text)),
      dimensions: this.dimensions,
      model: this.name,
    });
  }

  /** Fill a fixed-dimension vector from repeated hashing, then L2-normalize. */
  private vectorFor(text: string): number[] {
    const raw = new Array<number>(this.dimensions).fill(0);
    let i = 0;
    for (let counter = 0; i < this.dimensions; counter++) {
      const bytes = createHash('sha256').update(`${text}#${counter}`).digest();
      for (let b = 0; b + 1 < bytes.length && i < this.dimensions; b += 2, i++) {
        raw[i] = (bytes.readUInt16BE(b) / 65535) * 2 - 1;
      }
    }
    const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0)) || 1;
    return raw.map((x) => x / norm);
  }
}

export class StubRerankProvider implements RerankProvider {
  readonly name = 'stub';

  rerank(request: RerankRequest): Promise<RerankResult> {
    const queryTokens = new Set(tokenize(request.query));
    const scored: RerankScore[] = request.documents.map((doc, index) => {
      const docTokens = new Set(tokenize(doc.text));
      let matched = 0;
      for (const token of queryTokens) if (docTokens.has(token)) matched++;
      const score = queryTokens.size === 0 ? 0 : matched / queryTokens.size;
      return { id: doc.id, index, score };
    });
    // Descending score; stable tie-break by original index for determinism.
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const topK = request.topK ?? scored.length;
    return Promise.resolve({ results: scored.slice(0, topK), model: this.name });
  }
}
