/** Local-dev defaults mirror .env.example so the dashboard runs with no setup. */
export const env = {
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://threadmark:threadmark_local_dev@localhost:5432/threadmark',
  opensearchNode: process.env.OPENSEARCH_NODE ?? 'http://localhost:9200',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  workspaceName: process.env.DASHBOARD_WORKSPACE ?? 'Dev Workspace',
};
