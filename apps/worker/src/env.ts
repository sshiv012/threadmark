/**
 * Worker/CLI environment. Read from process.env with local-dev defaults that
 * match .env.example. Load via `node --env-file=.env`.
 */
export const env = {
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://threadmark:threadmark_local_dev@localhost:5432/threadmark',
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  opensearchNode: process.env.OPENSEARCH_NODE ?? 'http://localhost:9200',
  minio: {
    endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.MINIO_ROOT_USER ?? 'threadmark',
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? 'threadmark_local_dev',
    bucket: process.env.EVIDENCE_BUCKET ?? 'threadmark-evidence',
  },
} as const;
