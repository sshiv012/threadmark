/**
 * @threadmark/model-router — configurable provider registry for text
 * generation, embeddings, and reranking, each behind an interface.
 *
 * Default dev profile (later PRs): Gemini 2.5 Flash for generation; local
 * Transformers.js ONNX models (bge-small-en-v1.5 embeddings, bge-reranker-base
 * rerank) that run offline with no API keys. Every model side effect flows
 * through this package — no direct SDK calls elsewhere.
 *
 * Placeholder export for the scaffold. Interfaces + adapters land in PR4.
 */
export const PACKAGE_NAME = '@threadmark/model-router';
