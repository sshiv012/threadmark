import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryCache, NoopCache, RedisCache } from './cache.js';
import type { RetrievedChunk } from './types.js';

const SAMPLE: RetrievedChunk[] = [
  {
    chunkId: 'c1',
    documentId: 'd1',
    documentTitle: 'doc',
    sourceType: 'product_doc',
    text: 'hello',
    rerankScore: 0.9,
  },
];

describe('RedisCache', () => {
  it('round-trips a value through get/set', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
    } as unknown as Redis;
    const cache = new RedisCache(redis);

    await cache.set('k', SAMPLE);
    expect(await cache.get('k')).toEqual(SAMPLE);
  });

  it('fails open on a read error (returns null, does not throw)', async () => {
    const redis = {
      get: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      set: vi.fn(),
    } as unknown as Redis;
    const cache = new RedisCache(redis);

    await expect(cache.get('k')).resolves.toBeNull();
  });

  it('fails open on a write error (does not throw)', async () => {
    const redis = {
      get: vi.fn(),
      set: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    } as unknown as Redis;
    const cache = new RedisCache(redis);

    await expect(cache.set('k', SAMPLE)).resolves.toBeUndefined();
  });

  it('treats malformed cached JSON as a miss, not a crash', async () => {
    const redis = {
      get: vi.fn(async () => 'not valid json{{{'),
      set: vi.fn(),
    } as unknown as Redis;
    const cache = new RedisCache(redis);

    await expect(cache.get('k')).resolves.toBeNull();
  });
});

describe('InMemoryCache', () => {
  it('round-trips a value and misses on unknown keys', async () => {
    const cache = new InMemoryCache();
    expect(await cache.get('missing')).toBeNull();
    await cache.set('k', SAMPLE);
    expect(await cache.get('k')).toEqual(SAMPLE);
  });
});

describe('NoopCache', () => {
  it('always misses', async () => {
    const cache = new NoopCache();
    await cache.set('k', SAMPLE);
    expect(await cache.get('k')).toBeNull();
  });
});
