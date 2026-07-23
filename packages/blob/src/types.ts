/**
 * Blob storage boundary — the raw uploaded evidence bytes live here (MinIO
 * locally, S3 in the cloud). Derived text/chunks/vectors live in Postgres and
 * are rebuildable from these blobs.
 */
export interface PutResult {
  /** Stable URI recorded on evidence_document.blob_uri (e.g. s3://bucket/key). */
  uri: string;
}

export interface GetResult {
  bytes: Uint8Array;
  contentType?: string;
}

export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<PutResult>;
  get(key: string): Promise<GetResult>;
}
