import type { Redis } from 'ioredis';
import type { RetrievalCache, RetrievedChunk } from './types.js';

/** No-op cache (default): every query recomputes. */
export class NoopCache implements RetrievalCache {
  get(_key: string): Promise<RetrievedChunk[] | null> {
    return Promise.resolve(null);
  }
  set(_key: string, _value: RetrievedChunk[]): Promise<void> {
    return Promise.resolve();
  }
}

/** In-memory cache for tests. */
export class InMemoryCache implements RetrievalCache {
  private readonly store = new Map<string, RetrievedChunk[]>();
  get(key: string): Promise<RetrievedChunk[] | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  set(key: string, value: RetrievedChunk[]): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

/**
 * Redis-backed cache with a TTL — used to demonstrate the latency win.
 *
 * Caching is an optimization, never a correctness dependency: any Redis
 * failure (connection down, timeout, malformed stored value) fails OPEN —
 * `get` returns a miss (null) and `set` is swallowed — so retrieval always
 * still returns a correct, freshly-computed result. Errors are logged, not
 * thrown, pending a real telemetry sink (@threadmark/telemetry).
 */
export class RedisCache implements RetrievalCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 300,
    private readonly prefix = 'retrieval:',
  ) {}

  async get(key: string): Promise<RetrievedChunk[] | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(this.prefix + key);
    } catch (error) {
      console.error('[RedisCache] read failed, falling back to a cache miss:', error);
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RetrievedChunk[];
    } catch (error) {
      console.error('[RedisCache] stored value was not valid JSON, treating as a miss:', error);
      return null;
    }
  }

  async set(key: string, value: RetrievedChunk[]): Promise<void> {
    try {
      await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', this.ttlSeconds);
    } catch (error) {
      console.error('[RedisCache] write failed, continuing without caching this result:', error);
    }
  }
}
