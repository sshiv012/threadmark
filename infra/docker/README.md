# Local infrastructure

Docker Compose stack for Threadmark local development. All services are for
**local development only** — OpenSearch runs with its security plugin disabled
and every credential is a well-known local default.

## Services

| Service           | Purpose                                   | Host port(s)    | UI / endpoint                         |
| ----------------- | ----------------------------------------- | --------------- | ------------------------------------- |
| postgres          | System of record + **pgvector**           | `5432`          | —                                     |
| temporal-postgres | Temporal's dedicated database (isolated)  | (internal)      | —                                     |
| temporal          | Durable workflow orchestrator (gRPC)      | `7233`          | —                                     |
| temporal-ui       | Temporal Web UI                           | `8233`          | http://localhost:8233                 |
| opensearch        | Lexical / BM25 index                      | `9200`          | http://localhost:9200/_cluster/health |
| redis             | Cache                                     | `6379`          | —                                     |
| minio             | S3-compatible blob store (evidence files) | `9000` / `9001` | http://localhost:9001 (console)       |

Ports and credentials are configurable in `.env` (see `.env.example`).

## Usage

From the repo root:

```sh
cp .env.example .env      # first time only
pnpm infra:up             # start everything detached
pnpm infra:smoke          # verify connectivity (Postgres pgvector, Redis, OpenSearch, MinIO, Temporal UI)
pnpm infra:logs           # tail logs
pnpm infra:down           # stop (keeps data volumes)
pnpm infra:down -- -v     # stop AND delete data volumes (clean reset)
```

Requires Docker Desktop (or a Docker daemon) running.

## Notes

- **Temporal** has its own Postgres (`temporal-postgres`) so its schemas never
  mix with the application database. The `auto-setup` image provisions
  Temporal's `temporal` / `temporal_visibility` databases on first boot.
- **pgvector** is enabled on the app database by
  `postgres/init/01-extensions.sql` (runs once on volume init). Table DDL lives
  in Drizzle migrations, not here.
- **OpenSearch** on Linux may need `sysctl -w vm.max_map_count=262144`. Docker
  Desktop (macOS/Windows) handles this automatically.
- First `pnpm infra:up` pulls images and can take a few minutes; `infra:smoke`
  retries while services finish starting.
