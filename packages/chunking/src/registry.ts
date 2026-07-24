import { AnalyticsChunker } from './strategies/analytics.js';
import { InterviewTurnChunker } from './strategies/interview-turn.js';
import { MarkdownChunker } from './strategies/markdown.js';
import { MessageChunker } from './strategies/message.js';
import { TokenWindowChunker } from './strategies/token-window.js';
import { heuristicTokenCounter } from './tokens.js';
import type { Chunker, ChunkerRegistry, TokenCounter } from './types.js';

export function createChunkerRegistry(
  options: { tokenCounter?: TokenCounter } = {},
): ChunkerRegistry {
  const tokenCounter = options.tokenCounter ?? heuristicTokenCounter;
  const tokenWindow = new TokenWindowChunker(tokenCounter);
  const markdown = new MarkdownChunker(tokenCounter);

  // PRDs and design docs are the core corpus → markdown is the priority strategy.
  const byType: Record<string, Chunker> = {
    product_doc: markdown,
    prior_prd: markdown,
    tech_constraint: markdown,
    interview: new InterviewTurnChunker(tokenCounter),
    support_ticket: new MessageChunker(tokenCounter),
    github_issue: new MessageChunker(tokenCounter),
    analytics: new AnalyticsChunker(tokenCounter),
  };

  return {
    get(sourceType) {
      return byType[sourceType] ?? tokenWindow;
    },
  };
}
