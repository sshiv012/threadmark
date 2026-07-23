/**
 * @threadmark/model-router — the model boundary. Configurable providers for
 * text generation, embeddings, and reranking, each behind an interface.
 *
 * Default dev profile: Gemini 2.5 Flash for generation (when GEMINI_API_KEY is
 * set) and deterministic stubs otherwise. Local Transformers.js embedding +
 * rerank adapters arrive in PR4b. Every model call flows through here — no
 * provider SDK is called directly elsewhere.
 */
export * from './types.js';
export * from './config.js';
export * from './router.js';
export * from './providers/stub.js';
export * from './providers/gemini.js';

export const PACKAGE_NAME = '@threadmark/model-router';
