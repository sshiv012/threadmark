import type { BlobStore, GetResult, PutResult } from './types.js';

/** In-memory BlobStore for tests and offline unit tests of downstream code. */
export class InMemoryBlobStore implements BlobStore {
  private readonly store = new Map<string, { bytes: Uint8Array; contentType: string }>();

  constructor(private readonly bucket = 'memory') {}

  put(key: string, bytes: Uint8Array, contentType: string): Promise<PutResult> {
    this.store.set(key, { bytes, contentType });
    return Promise.resolve({ uri: `s3://${this.bucket}/${key}` });
  }

  get(key: string): Promise<GetResult> {
    const entry = this.store.get(key);
    if (!entry) return Promise.reject(new Error(`blob not found: ${key}`));
    return Promise.resolve({ bytes: entry.bytes, contentType: entry.contentType });
  }
}
