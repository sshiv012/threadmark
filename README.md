# Threadmark

A collaborative, evidence-backed PRD workspace. Teams upload product evidence (customer interviews,
support tickets, technical docs, prior PRDs, GitHub issues, analytics exports); a durable AI
workflow retrieves and reranks relevant evidence, generates a structured PRD with **claim-level
citations**, and supports collaborative editing, comments, alternative branches, and full agent-run
observability.

This project is also a deliberate **code-review training exercise**: the architecture optimizes for
understandable boundaries and small, reviewable changes over raw development speed.

## Status

Early scaffolding. This repository is being built as a sequence of small, single-behavior pull
requests. See `docs/` for the plan (added in later PRs).

## Repository layout

```
apps/
  web/      Next.js UI (thin — no business logic)
  api/      Fastify HTTP/JSON API
  collab/   Hocuspocus/Yjs collaboration server
  worker/   Temporal workflows + activities
packages/
  core/          domain types, Zod schemas, service interfaces
  db/            Drizzle schema, migrations, repositories (Postgres + pgvector)
  model-router/  configurable generate/embed/rerank providers
  retrieval/     hybrid search (BM25 + vector), RRF fusion, reranking
  evals/         labeled retrieval eval set, metrics, runner
  telemetry/     OpenTelemetry setup + run-observability helpers
  config/        shared configuration loading
```

## Toolchain

- **Node** >= 22 (`.nvmrc`)
- **pnpm** workspaces (`pnpm@9.15.4`, pinned via `packageManager`)
- **Turborepo** task orchestration
- **TypeScript** strict mode

## Common commands

```sh
pnpm install       # install all workspace dependencies
pnpm typecheck     # type-check every package
pnpm lint          # lint every package
pnpm test          # run unit tests
pnpm format        # format with Prettier
```
