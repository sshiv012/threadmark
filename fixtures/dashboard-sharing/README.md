# Dogfood corpus — "External dashboard sharing"

A **fictional** evidence corpus for Threadmark's primary demo scenario:

> "Create a PRD for external dashboard sharing using customer interviews, support
> tickets, prior product documentation, usage analytics, and technical constraints."

It exists to exercise ingestion, hybrid retrieval, reranking, and (later)
evidence-backed PRD generation against realistic, cross-referencing content. All
names, companies, and data are invented — no real people or organizations.

## Structure (22 documents)

| Folder | Count | Format | Chunker exercised |
| --- | --- | --- | --- |
| `interviews/` | 5 | `Speaker:` turn transcripts | interview-turn |
| `support-tickets/` | 4 | `From:` message threads | message |
| `prior-prd/` | 2 | Markdown w/ heading hierarchy | markdown |
| `product-docs/` | 5 | Markdown w/ heading hierarchy | markdown |
| `analytics/` | 3 | CSV (header + rows) | analytics |
| `tech-constraints/` | 3 | Markdown w/ heading hierarchy | markdown |

## Cast (reused across documents)

- **Northwind Analytics** (mid-market SaaS): Dana Okafor (PM), Raj Patel (Support Lead), Wei Chen (Eng)
- **Helio Logistics** (enterprise): Marta Silva (Ops Director), Tom Becker (Security Officer)
- **Brightseed** (nonprofit): Aisha Rahman (Program Lead)
- **Threadmark** (internal): Sam Rivera (PM), Priya Nair (Eng Lead), Leo Martins (Designer)

## Recurring themes (retrieval signal)

External share links · access controls & roles (viewer vs editor) · link expiry &
revoke · SSO for external viewers · audit logging · watermarking · GDPR/PII & data
residency · shared-view performance & mobile · embed vs link. The set deliberately
seeds a few capability **gaps** (e.g. no per-recipient links, no auto PII
redaction) so retrieval surfaces tension between what customers ask for and what
exists.

## Manifest & timeline

`manifest.csv` lists every document with a stable `doc_id`, its `source_type`,
and an `effective_date`. The dates encode a deliberate **capability timeline** so
retrieval and evals can distinguish *historical tension* from an *unresolvable
contradiction*: e.g. the `feature_requests` export (2025-11) lists SSO for
external viewers and view auditing as requested/planned, whereas the product
docs (2026-06) describe them as available — the later effective date resolves
the apparent conflict rather than contradicting it. Capability **gaps** that are
still open at the latest date (per-recipient links, automatic PII redaction) are
consistently described as unavailable across docs.

Ingested via `pnpm seed` (added with the retrieval work).
