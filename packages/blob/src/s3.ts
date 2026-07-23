import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { BlobStore, GetResult, PutResult } from './types.js';

export interface S3BlobStoreOptions {
  bucket: string;
  /** Custom endpoint for MinIO; omit for real AWS S3. */
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO needs path-style addressing; defaults to true. */
  forcePathStyle?: boolean;
}

/**
 * S3-compatible BlobStore. The same adapter talks to MinIO locally and real S3
 * in the cloud — only the endpoint/credentials change.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region ?? 'us-east-1',
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: options.forcePathStyle ?? true,
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    });
  }

  /** Create the bucket if it does not already exist. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<PutResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
    return { uri: `s3://${this.bucket}/${key}` };
  }

  async get(key: string): Promise<GetResult> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`blob has no body: ${key}`);
    const bytes = await response.Body.transformToByteArray();
    return response.ContentType !== undefined
      ? { bytes, contentType: response.ContentType }
      : { bytes };
  }
}
