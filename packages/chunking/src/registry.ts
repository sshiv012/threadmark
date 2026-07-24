import { MarkdownChunker } from './strategies/markdown.js';
import { TokenWindowChunker } from './strategies/token-window.js';
import { heuristicTokenCounter } from './tokens.js';
import type { ChunkerRegistry, TokenCounter } from './types.js';

/**
 * Evidence source types that are markdown/prose-shaped. Interview, ticket, and
 * analytics types fall back to token-window until PR5a-2 adds dedicated
 * turn/message/row strategies.
 */
const MARKDOWN_SOURCE_TYPES = new Set(['product_doc', 'prior_prd', 'tech_constraint']);

export function createChunkerRegistry(
  options: { tokenCounter?: TokenCounter } = {},
): ChunkerRegistry {
  const tokenCounter = options.tokenCounter ?? heuristicTokenCounter;
  const markdown = new MarkdownChunker(tokenCounter);
  const tokenWindow = new TokenWindowChunker(tokenCounter);
  return {
    get(sourceType) {
      return MARKDOWN_SOURCE_TYPES.has(sourceType) ? markdown : tokenWindow;
    },
  };
}
