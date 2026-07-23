import { hashContent, heuristicTokenCounter, slug } from '../tokens.js';
import type {
  ChunkCandidate,
  Chunker,
  ChunkingOptions,
  ExtractedDocument,
  TokenCounter,
} from '../types.js';
import { TokenWindowChunker } from './token-window.js';

interface Section {
  hierarchy: string[];
  lines: string[];
}

/** Split markdown into sections by ATX headings, tracking the heading path. */
function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: Section = { hierarchy: [], lines: [] };

  const flush = (): void => {
    if (current.lines.length > 0 || current.hierarchy.length > 0) sections.push(current);
  };

  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title });
      current = { hierarchy: stack.map((h) => h.title), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Structure-aware chunker: one chunk per heading section, with a stable
 * `sourceKey` derived from the heading path (not a global ordinal), so editing
 * or inserting one section leaves other sections' identity untouched.
 * Oversized sections fall back to token-windowing under the same heading path.
 */
export class MarkdownChunker implements Chunker {
  readonly name = 'markdown';
  readonly version = '1';
  private readonly fallback: TokenWindowChunker;

  constructor(private readonly tokenCounter: TokenCounter = heuristicTokenCounter) {
    this.fallback = new TokenWindowChunker(tokenCounter);
  }

  async chunk(document: ExtractedDocument, options: ChunkingOptions): Promise<ChunkCandidate[]> {
    const candidates: ChunkCandidate[] = [];
    const seen = new Map<string, number>();
    let ord = 0;

    for (const section of splitSections(document.text)) {
      const text = section.lines.join('\n').trim();
      if (text === '') continue;

      const base = section.hierarchy.length ? section.hierarchy.map(slug).join('>') : 'preamble';
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      const sourceKey = occurrence === 0 ? base : `${base}#${occurrence}`;

      const tokenCount = this.tokenCounter.count(text);
      if (tokenCount <= options.maxTokens) {
        candidates.push({
          text,
          tokenCount,
          ord: ord++,
          sourceKey,
          contentHash: hashContent(text),
          hierarchy: section.hierarchy,
        });
        continue;
      }

      // Section too large — window it, nesting sub-keys under the heading path.
      const subs = await this.fallback.chunk({ sourceType: document.sourceType, text }, options);
      for (const sub of subs) {
        candidates.push({
          ...sub,
          ord: ord++,
          sourceKey: `${sourceKey}/${sub.sourceKey}`,
          hierarchy: section.hierarchy,
        });
      }
    }
    return candidates;
  }
}
