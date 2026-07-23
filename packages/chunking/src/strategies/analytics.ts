import { hashContent, heuristicTokenCounter } from '../tokens.js';
import type {
  ChunkCandidate,
  Chunker,
  ChunkingOptions,
  ExtractedDocument,
  TokenCounter,
} from '../types.js';
import { TokenWindowChunker } from './token-window.js';

/** Minimal CSV field parser that respects double-quoted fields (incl. commas). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

/**
 * Row-aware analytics chunker: one chunk per CSV row, rendered as `col: value`
 * lines with the header as context so each chunk is self-describing. Keyed by
 * the first column value for stability. Falls back to token-window when the
 * text is not CSV-like.
 */
export class AnalyticsChunker implements Chunker {
  readonly name = 'analytics';
  readonly version = '1';
  private readonly fallback: TokenWindowChunker;

  constructor(private readonly tokenCounter: TokenCounter = heuristicTokenCounter) {
    this.fallback = new TokenWindowChunker(tokenCounter);
  }

  chunk(document: ExtractedDocument, options: ChunkingOptions): Promise<ChunkCandidate[]> {
    const lines = document.text.split('\n').filter((line) => line.trim() !== '');
    // Not CSV-like (no header row with delimiters) → fall back.
    if (lines.length < 2 || !lines[0]!.includes(',')) {
      return this.fallback.chunk(document, options);
    }

    const header = parseCsvLine(lines[0]!);
    const candidates: ChunkCandidate[] = [];
    lines.slice(1).forEach((line, index) => {
      const values = parseCsvLine(line);
      const record: Record<string, string> = {};
      header.forEach((column, i) => {
        record[column] = values[i] ?? '';
      });
      const text = header.map((column) => `${column}: ${record[column]}`).join('\n');
      // Stable identity: the first column value (a natural row key), not the
      // ordinal — falling back to the index only when it is blank.
      const keyValue = (values[0] ?? '').trim() || String(index);
      candidates.push({
        text,
        tokenCount: this.tokenCounter.count(text),
        ord: index,
        sourceKey: `row:${keyValue}`,
        contentHash: hashContent(text),
        metadata: record,
      });
    });
    return Promise.resolve(candidates);
  }
}
