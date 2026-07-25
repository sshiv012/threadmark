/**
 * Local, keyless providers backed by ONNX models via @huggingface/transformers.
 * Models run in-process; weights download once on first use, then are cached.
 *
 * Both providers take an injectable `load` so the transformation logic is unit
 * tested offline with a fake model; the real models are exercised only by the
 * opt-in integration tests (RUN_MODEL_INTEGRATION=1).
 */
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
  RerankProvider,
  RerankRequest,
  RerankResult,
  RerankScore,
} from '../types.js';

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
export const DEFAULT_RERANK_MODEL = 'Xenova/bge-reranker-base';

/** Map a raw cross-encoder logit to (0,1). Monotonic — ordering is preserved. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Minimal feature-extraction pipeline shape we depend on. */
export interface FeatureExtractor {
  (
    texts: string[],
    options: { pooling: 'mean'; normalize: boolean },
  ): Promise<{ tolist(): number[][] }>;
}

/** Minimal cross-encoder: relevance score per (query, document) pair. */
export interface CrossEncoder {
  score(query: string, documents: string[]): Promise<number[]>;
}

export interface TransformersEmbeddingOptions {
  model?: string;
  dimensions: number;
  /** Injectable loader; defaults to a real transformers.js pipeline. */
  load?: () => Promise<FeatureExtractor>;
}

export interface TransformersRerankOptions {
  model?: string;
  /** Injectable loader; defaults to a real transformers.js cross-encoder. */
  load?: () => Promise<CrossEncoder>;
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'transformers';
  readonly dimensions: number;
  readonly model: string;
  private readonly load: () => Promise<FeatureExtractor>;
  private extractorPromise?: Promise<FeatureExtractor>;

  constructor(options: TransformersEmbeddingOptions) {
    this.dimensions = options.dimensions;
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.load = options.load ?? (() => loadFeatureExtractor(this.model));
  }

  private extractor(): Promise<FeatureExtractor> {
    return (this.extractorPromise ??= this.load());
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.input.length === 0) {
      return { vectors: [], dimensions: this.dimensions, model: this.model };
    }
    const extractor = await this.extractor();
    const output = await extractor(request.input, { pooling: 'mean', normalize: true });
    const vectors = output.tolist();

    const produced = vectors[0]?.length ?? this.dimensions;
    if (produced !== this.dimensions) {
      throw new Error(
        `Embedding model ${this.model} produced dimension ${produced}, expected ${this.dimensions}`,
      );
    }
    return { vectors, dimensions: this.dimensions, model: this.model };
  }
}

export class TransformersRerankProvider implements RerankProvider {
  readonly name = 'transformers';
  readonly model: string;
  private readonly load: () => Promise<CrossEncoder>;
  private encoderPromise?: Promise<CrossEncoder>;

  constructor(options: TransformersRerankOptions = {}) {
    this.model = options.model ?? DEFAULT_RERANK_MODEL;
    this.load = options.load ?? (() => loadCrossEncoder(this.model));
  }

  private encoder(): Promise<CrossEncoder> {
    return (this.encoderPromise ??= this.load());
  }

  async rerank(request: RerankRequest): Promise<RerankResult> {
    if (request.documents.length === 0) {
      return { results: [], model: this.model };
    }
    const encoder = await this.encoder();
    const scores = await encoder.score(
      request.query,
      request.documents.map((doc) => doc.text),
    );
    // bge-reranker (and cross-encoders generally) emit a raw logit, not a
    // bounded relevance score. Normalize here, at the boundary that knows the
    // output is a logit, so this provider satisfies the RerankProvider
    // contract (score in (0,1)) regardless of the underlying model's scale.
    const scored: RerankScore[] = request.documents.map((doc, index) => ({
      id: doc.id,
      index,
      score: sigmoid(scores[index] ?? 0),
    }));
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const topK = request.topK ?? scored.length;
    return { results: scored.slice(0, topK), model: this.model };
  }
}

// ── Real loaders (only reached when no `load` is injected) ───────────────────
async function loadFeatureExtractor(model: string): Promise<FeatureExtractor> {
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', model);
  return (texts, options) => extractor(texts, options) as Promise<{ tolist(): number[][] }>;
}

async function loadCrossEncoder(model: string): Promise<CrossEncoder> {
  const { AutoModelForSequenceClassification, AutoTokenizer } =
    await import('@huggingface/transformers');
  const tokenizer = await AutoTokenizer.from_pretrained(model);
  const sequenceModel = await AutoModelForSequenceClassification.from_pretrained(model);
  return {
    async score(query, documents) {
      const inputs = tokenizer(
        documents.map(() => query),
        { text_pair: documents, padding: true, truncation: true },
      );
      const output = await sequenceModel(inputs);
      // bge-reranker emits one logit per pair; higher = more relevant.
      const logits = (output.logits as { tolist(): number[][] }).tolist();
      return logits.map((row) => row[0] ?? 0);
    },
  };
}
