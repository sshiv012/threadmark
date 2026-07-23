/**
 * @threadmark/chunking — the chunking boundary. Pluggable strategies turn an
 * extracted document into content/source-stable chunk candidates. Ingestion
 * (PR5b) and evals consume this package.
 */
export * from './types.js';
export * from './tokens.js';
export * from './strategies/token-window.js';
export * from './strategies/markdown.js';
export * from './registry.js';

export const PACKAGE_NAME = '@threadmark/chunking';
