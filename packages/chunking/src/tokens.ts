import { createHash } from 'node:crypto';
import type { TokenCounter } from './types.js';

/** Collapse insignificant whitespace so hashing/counting ignore formatting. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Cheap, deterministic token estimate (whitespace-separated words). Good enough
 * for chunk sizing offline; a model-accurate tokenizer can be injected later.
 */
export const heuristicTokenCounter: TokenCounter = {
  count(text) {
    const normalized = normalize(text);
    return normalized === '' ? 0 : normalized.split(' ').length;
  },
};

/** Stable content fingerprint; a change here means a chunk must re-embed. */
export function hashContent(text: string): string {
  return createHash('sha256').update(normalize(text)).digest('hex').slice(0, 16);
}

/** URL/key-safe slug for deriving stable heading-path source keys. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
