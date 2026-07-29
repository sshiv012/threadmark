/**
 * API process environment. Unlike apps/worker's env.ts, JWT_SECRET has no
 * dev-default fallback — signing tokens with a fallback secret would be a
 * silent security hole, so a missing secret must fail fast at module-load
 * time (process startup), never lazily at first request. Load via
 * `node --env-file=.env`.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} must be set (no default — see .env.example)`);
  }
  return value;
}

export const env = {
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://threadmark:threadmark_local_dev@localhost:5432/threadmark',
  opensearchNode: process.env.OPENSEARCH_NODE ?? 'http://localhost:9200',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: requireEnv('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
} as const;
