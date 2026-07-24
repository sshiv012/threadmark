/**
 * The model boundary. Every text generation, embedding, and reranking call in
 * Threadmark goes through these interfaces — no provider SDK is called
 * directly anywhere else. Providers are selected by config and are
 * interchangeable behind these contracts.
 */

// ── Generation ───────────────────────────────────────────────────────────────
export interface GenerationRequest {
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface GenerationResult {
  text: string;
  model: string;
  finishReason?: string;
}

export interface GenerationProvider {
  readonly name: string;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

// ── Embedding ────────────────────────────────────────────────────────────────
export interface EmbeddingRequest {
  input: string[];
}

export interface EmbeddingResult {
  vectors: number[][];
  dimensions: number;
  model: string;
}

export interface EmbeddingProvider {
  readonly name: string;
  /** Concrete model identifier (for embedding provenance / detecting upgrades). */
  readonly model: string;
  readonly dimensions: number;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

// ── Reranking ────────────────────────────────────────────────────────────────
export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankRequest {
  query: string;
  documents: RerankDocument[];
  topK?: number;
}

export interface RerankScore {
  id: string;
  /** Index of this document in the original request.documents array. */
  index: number;
  score: number;
}

export interface RerankResult {
  /** Sorted by score descending; length is min(topK ?? all, documents). */
  results: RerankScore[];
  model: string;
}

export interface RerankProvider {
  readonly name: string;
  rerank(request: RerankRequest): Promise<RerankResult>;
}

// ── Router ───────────────────────────────────────────────────────────────────
export interface ModelRouter {
  /** The concrete providers backing each capability (for names/dimensions). */
  readonly providers: {
    readonly generation: GenerationProvider;
    readonly embedding: EmbeddingProvider;
    readonly rerank: RerankProvider;
  };
  generate(request: GenerationRequest): Promise<GenerationResult>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
  rerank(request: RerankRequest): Promise<RerankResult>;
}
