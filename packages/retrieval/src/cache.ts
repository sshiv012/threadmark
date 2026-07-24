import type { Redis } from 'ioredis';
import type { RetrievalCache, RetrievedChunk } from './types.js';

/** No-op cache (default): every query recomputes. */
export class NoopCache implements RetrievalCache {
  get(): Promise<RetrievedChunk[] | null> {
    return Promise.resolve(null);
  }
  set(): Promise<void> {
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

/** Redis-backed cache with a TTL — used to demonstrate the latency win. */
export class RedisCache implements RetrievalCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 300,
    private readonly prefix = 'retrieval:',
  ) {}

  async get(key: string): Promise<RetrievedChunk[] | null> {
    const raw = await this.redis.get(this.prefix + key);
    return raw ? (JSON.parse(raw) as RetrievedChunk[]) : null;
  }

  async set(key: string, value: RetrievedChunk[]): Promise<void> {
    await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', this.ttlSeconds);
  }
}
