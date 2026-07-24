import { describe, expect, it } from 'vitest';
import { S3BlobStore } from './s3.js';

// Opt-in: exercises real MinIO. Skipped unless RUN_INTEGRATION=1 (keeps CI
// offline). Run `pnpm infra:up` first.
const run = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!run)('S3BlobStore (MinIO integration)', () => {
  const store = new S3BlobStore({
    bucket: 'threadmark-test',
    endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.MINIO_ROOT_USER ?? 'threadmark',
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? 'threadmark_local_dev',
    forcePathStyle: true,
  });

  it('ensures a bucket and round-trips an object', async () => {
    await store.ensureBucket();
    await store.put('it/hello.txt', new TextEncoder().encode('world'), 'text/plain');
    const got = await store.get('it/hello.txt');
    expect(new TextDecoder().decode(got.bytes)).toBe('world');
    expect(got.contentType).toContain('text/plain');
  }, 30_000);
});
