import { hashContent, heuristicTokenCounter } from '../tokens.js';
import type {
  ChunkCandidate,
  Chunker,
  ChunkingOptions,
  ExtractedDocument,
  TokenCounter,
} from '../types.js';
import { TokenWindowChunker } from './token-window.js';

// A speaker label at the start of a line: "Alice:", "Support Agent:".
const SPEAKER_LINE = /^([A-Z][\w .'-]{0,39}):\s?(.*)$/;

interface Turn {
  speaker: string;
  lines: string[];
}

/**
 * Interview/transcript chunker: one chunk per speaker turn. Continuation lines
 * join the current turn. Falls back to token-window when no speaker labels are
 * present. Oversized turns are windowed under the turn's source key.
 */
export class InterviewTurnChunker implements Chunker {
  readonly name = 'interview-turn';
  readonly version = '1';
  private readonly fallback: TokenWindowChunker;

  constructor(private readonly tokenCounter: TokenCounter = heuristicTokenCounter) {
    this.fallback = new TokenWindowChunker(tokenCounter);
  }

  async chunk(document: ExtractedDocument, options: ChunkingOptions): Promise<ChunkCandidate[]> {
    const turns: Turn[] = [];
    let current: Turn | undefined;
    for (const line of document.text.split('\n')) {
      const match = SPEAKER_LINE.exec(line);
      if (match) {
        current = { speaker: match[1]!.trim(), lines: [match[2]!] };
        turns.push(current);
      } else if (current) {
        current.lines.push(line);
      }
    }

    if (turns.length === 0) {
      return this.fallback.chunk(document, options);
    }

    const candidates: ChunkCandidate[] = [];
    let ord = 0;
    for (const [index, turn] of turns.entries()) {
      const text = turn.lines.join('\n').trim();
      if (text === '') continue;
      const sourceKey = `turn:${index}`;
      const tokenCount = this.tokenCounter.count(text);
      if (tokenCount <= options.maxTokens) {
        candidates.push({
          text,
          tokenCount,
          ord: ord++,
          sourceKey,
          contentHash: hashContent(text),
          hierarchy: [turn.speaker],
          metadata: { speaker: turn.speaker },
        });
        continue;
      }
      const subs = await this.fallback.chunk({ sourceType: document.sourceType, text }, options);
      for (const sub of subs) {
        candidates.push({
          ...sub,
          ord: ord++,
          sourceKey: `${sourceKey}/${sub.sourceKey}`,
          hierarchy: [turn.speaker],
          metadata: { speaker: turn.speaker },
        });
      }
    }
    return candidates;
  }
}
