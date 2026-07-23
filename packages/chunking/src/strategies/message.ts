import { hashContent, heuristicTokenCounter } from '../tokens.js';
import type {
  ChunkCandidate,
  Chunker,
  ChunkingOptions,
  ExtractedDocument,
  TokenCounter,
} from '../types.js';
import { TokenWindowChunker } from './token-window.js';

const AUTHOR_HEADER = /^(?:From|Author):\s*(.+)$/i;

/** Split into messages on `---` separators, else on blank-line paragraphs. */
function splitMessages(text: string): string[] {
  const trimmed = text.trim();
  if (/^-{3,}$/m.test(trimmed)) {
    return trimmed
      .split(/^-{3,}$/m)
      .map((m) => m.trim())
      .filter((m) => m !== '');
  }
  return trimmed
    .split(/\n\s*\n/)
    .map((m) => m.trim())
    .filter((m) => m !== '');
}

/**
 * Ticket / issue / thread chunker: one chunk per message, extracting an author
 * from a leading `From:`/`Author:` header when present. Oversized messages are
 * windowed under the message's source key.
 */
export class MessageChunker implements Chunker {
  readonly name = 'message';
  readonly version = '1';
  private readonly fallback: TokenWindowChunker;

  constructor(private readonly tokenCounter: TokenCounter = heuristicTokenCounter) {
    this.fallback = new TokenWindowChunker(tokenCounter);
  }

  async chunk(document: ExtractedDocument, options: ChunkingOptions): Promise<ChunkCandidate[]> {
    const messages = splitMessages(document.text);
    const candidates: ChunkCandidate[] = [];
    let ord = 0;

    for (const [index, message] of messages.entries()) {
      const lines = message.split('\n');
      const headerMatch = AUTHOR_HEADER.exec(lines[0]!);
      const author = headerMatch ? headerMatch[1]!.trim() : undefined;
      const text = headerMatch ? lines.slice(1).join('\n').trim() : message;
      if (text === '') continue;

      const sourceKey = `msg:${index}`;
      const metadata = author !== undefined ? { author } : undefined;
      const tokenCount = this.tokenCounter.count(text);

      if (tokenCount <= options.maxTokens) {
        candidates.push({
          text,
          tokenCount,
          ord: ord++,
          sourceKey,
          contentHash: hashContent(text),
          ...(metadata ? { metadata } : {}),
        });
        continue;
      }
      const subs = await this.fallback.chunk({ sourceType: document.sourceType, text }, options);
      for (const sub of subs) {
        candidates.push({
          ...sub,
          ord: ord++,
          sourceKey: `${sourceKey}/${sub.sourceKey}`,
          ...(metadata ? { metadata } : {}),
        });
      }
    }
    return candidates;
  }
}
