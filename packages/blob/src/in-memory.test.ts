import { describe, expect, it } from 'vitest';
import { InMemoryBlobStore } from './in-memory.js';

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('InMemoryBlobStore', () => {
  it('round-trips bytes + content type and returns an s3-style uri', async () => {
    const store = new InMemoryBlobStore('bucket');
    const { uri } = await store.put('docs/k1', encode('hello'), 'text/plain');
    expect(uri).toBe('s3://bucket/docs/k1');
    const got = await store.get('docs/k1');
    expect(decode(got.bytes)).toBe('hello');
    expect(got.contentType).toBe('text/plain');
  });

  it('rejects when the key is missing', async () => {
    await expect(new InMemoryBlobStore().get('nope')).rejects.toThrow(/not found/);
  });
});
