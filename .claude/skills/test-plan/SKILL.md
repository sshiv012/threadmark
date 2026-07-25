---
name: test-plan
description: MANDATORY test-first gate for Threadmark. Invoke BEFORE writing implementation code for any feature, PR, or bug fix. Produces a signed-off test plan (positive, negative, edge, UX, multi-tenant isolation, failure/degradation, boundary/validation, cache, re-ingest/version-drift) via a test-design advisor, then requires failing tests before code. Also triggers whenever the user says "TDD", "test plan", "test cases", or starts a new PR/feature.
---

# Test-first gate (do this before implementation)

Threadmark is a code-review training exercise and prior PRs shipped bugs that
review caught but tests didn't (cross-workspace leak, stale chunks, model-drift,
fail-closed cache). Cause: we only tested the behaviours we happened to imagine.
This gate makes the _test design_ a first-class, adversarial step so we stop
relying on the reviewer to find the gaps.

## Workflow (no implementation code until step 4 is approved)

1. **Frame** the change: one sentence on the behaviour, the packages/files it
   touches, and the trust boundaries it crosses (workspace/tenant, auth, network).

2. **Run the advisor.** Launch a subagent (Agent tool, `Explore` or
   `general-purpose`) whose ONLY job is to enumerate test cases — it must NOT
   propose implementation. Give it the frame + the relevant code. Require it to
   return cases grouped by the categories below, each as a concrete
   `file → describe/it → assertion → fixture` line. Prefer an adversarial second
   agent for anything crossing a trust boundary.

3. **Assemble the test plan** from the advisor output. Every case names the test
   file, the exact assertion, and the fixture/seed it needs. Mark which run
   offline (unit, fakes, pglite) vs. gated integration (real Docker services).

4. **Get explicit sign-off** on the plan (AskUserQuestion or ExitPlanMode). Do
   not write implementation before approval.

5. **Red → green.** Write the tests first, watch them fail for the right reason,
   then implement. Show the red→green progression.

6. **Review packet** notes which planned cases are covered and which were
   deliberately deferred (with reason).

## Mandatory categories (the advisor MUST cover every applicable one)

- **Happy path** — but assertions tight enough to catch ranking/behaviour
  regressions (not just "contains a word").
- **Negative / adversarial** — empty/whitespace/unicode/punctuation-only/very
  long/exact-id inputs; off-topic & distractor inputs; injection-ish content.
- **Edge / boundary / validation** — zero, negative, fractional, oversized,
  and mutually-inconsistent params (e.g. topK > candidateK); reject before they
  hit SQL/OpenSearch.
- **Multi-tenant isolation** — for ANY query/read: a two-workspace test with
  lexically/semantically similar content proving no cross-workspace leak, at
  every retriever/source independently (vector AND lexical AND the hydration
  read). This is a hard gate.
- **Failure / degradation** — each external dep (DB, OpenSearch, Redis, blob,
  model) down or erroring: define fail-open vs fail-closed and test it. Caches
  fail open; malformed cache entry = miss.
- **State filtering** — only `ready`/successfully-indexed data is user-visible;
  test queued/embedding/indexing/failed exclusion.
- **Re-ingest / edit / delete** — changed content updates results; removed
  sections/rows disappear from EVERY store; re-ingest is idempotent.
- **Version / config drift** — model/embedding/reranker/index revision changes
  invalidate caches and refresh stored artifacts; no mixed generations.
- **Provenance / correctness of derived data** — fused ranks, dedup (no double
  credit), reranker returning missing/duplicate/unknown ids handled safely.
- **UX states** — empty query, no results, loading, error, and CLI exit codes
  (a verification command MUST exit non-zero on partial failure).
- **Non-functional bounds** — batch sizes, timeouts, max candidates: call out as
  design-review items and bound them in code.

## Invariant & integration bias

Prefer **invariant/property tests** ("after any ingest, persisted chunks ==
current candidates for that doc") over example-by-example. Add at least one
**real-adapter integration test per seam** (fakes hide seams like blob
content-type and stub model ids). Provide a single gated command
(`RUN_*_INTEGRATION=1`) that stands up services, seeds, and **asserts** quality
(recall@k, distractor suppression, isolation, cache invalidation) — not just
"looks plausible".
