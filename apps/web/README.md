# @threadmark/web — dev dashboard

A **read-only** dashboard for manual testing of ingestion + retrieval. No auth.

- **Documents** (`/`) — evidence documents with ingestion status, plus recent
  `agent_run`s and their `agent_step`s (retries/failures visible).
- **Search** (`/search?q=…`) — hybrid retrieval (pgvector + BM25 → RRF →
  cross-encoder rerank) with per-result provenance (`vec#`, `bm25#`) and the
  cold-vs-cached latency.

It reads directly from Postgres / OpenSearch / Redis using the same packages as
the pipeline; env falls back to the local-dev defaults (no `.env` needed).

## Run it (full manual-testing loop)

```sh
pnpm infra:up                         # Postgres, OpenSearch, Redis, Temporal, MinIO
pnpm --filter @threadmark/db db:migrate
pnpm worker                           # terminal 1 — Temporal worker (leave running)
pnpm seed                             # terminal 2 — ingest all 22 dogfood docs
pnpm --filter @threadmark/web dev     # terminal 3 — dashboard at http://localhost:3000
```

Then browse http://localhost:3000 and try queries like _"external dashboard
sharing access controls"_ or _"SSO for external viewers"_. The Temporal UI
(http://localhost:8233) shows the durable ingestion runs.

`pnpm search "<query>"` is a CLI equivalent of the search page (prints cold vs
cached latency + ranked results).
