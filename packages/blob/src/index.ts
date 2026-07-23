/**
 * @threadmark/blob — blob storage boundary for raw uploaded evidence.
 * `S3BlobStore` (MinIO/S3) for real use; `InMemoryBlobStore` for tests.
 */
export * from './types.js';
export * from './in-memory.js';
export * from './s3.js';

export const PACKAGE_NAME = '@threadmark/blob';
