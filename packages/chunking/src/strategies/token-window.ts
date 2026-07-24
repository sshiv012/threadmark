import { hashContent, heuristicTokenCounter } from '../tokens.js';
import type {
  ChunkCandidate,
  Chunker,
  ChunkingOptions,
  ExtractedDocument,
  TokenCounter,
} from '../types.js';

/**
 * Universal fallback: sliding window over words with configurable overlap.
 * Positional by nature, so `sourceKey` is window-index based; `contentHash`
 * still prevents re-embedding identical windows.
 *
 * NOTE: windows are sized by whitespace-separated WORDS, not by the injected
 * TokenCounter — the counter only reports `tokenCount` after the boundary is
 * chosen; it does not move the boundary. Safe while the default counter is
 * word-based. Bounding by a subword tokenizer (so chunks never exceed a model's
 * token limit) needs a tokenizer with encode/offsets — tracked as a follow-up.
 */
export class TokenWindowChunker implements Chunker {
  readonly name = 'token-window';
  readonly version = '1';

  constructor(private readonly tokenCounter: TokenCounter = heuristicTokenCounter) {}

  chunk(document: ExtractedDocument, options: ChunkingOptions): Promise<ChunkCandidate[]> {
    const words = document.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return Promise.resolve([]);

    const step = Math.max(1, options.maxTokens - options.overlapTokens);
    const candidates: ChunkCandidate[] = [];
    let ord = 0;
    for (let start = 0; start < words.length; start += step) {
      const text = words.slice(start, start + options.maxTokens).join(' ');
      candidates.push({
        text,
        tokenCount: this.tokenCounter.count(text),
        ord,
        sourceKey: `win:${ord}`,
        contentHash: hashContent(text),
      });
      ord++;
      if (start + options.maxTokens >= words.length) break;
    }
    return Promise.resolve(candidates);
  }
}
