# External Dashboard Sharing — Performance, Rate Limiting & Caching

Author: Wei Chen (Engineer) · Reviewed by: Priya Nair (Eng Lead)
Status: Draft for PRD input · Context: Threadmark external dashboard sharing

This note defines the performance budgets, caching strategy, and rate-limiting constraints for externally shared dashboards. Shared views are served to an unauthenticated, uncontrolled audience on unknown networks and devices, so they cannot reuse the assumptions we make for logged-in, in-org users.

## Why Shared Views Are Different

Internal dashboards render for authenticated users on corporate networks, often warm-cached. External shares can be opened by hundreds of recipients simultaneously (a link dropped in a customer Slack), from mobile devices on cellular connections, with no prior cache. A single popular share must not become a load amplifier against Postgres or OpenSearch.

## Performance Budgets

The PRD should treat these as hard targets, measured at p95 from a cold client:

- Time to first meaningful paint of a shared dashboard: ≤ 2.5s on a mid-tier mobile device over a 4G-equivalent connection.
- Shared-view API response (cached): ≤ 150ms p95.
- Shared-view API response (cache miss, full render): ≤ 1.2s p95.
- Total transferred payload for initial view: ≤ 1.5 MB including chart data, excluding lazy-loaded images.
- Chart image/blob assets served via presigned URLs with a CDN in front; origin fetch only on cold cache.

If a dashboard cannot meet the payload budget, we degrade rather than fail: render summary tiles first, lazy-load heavy panels below the fold.

## Caching Strategy (Redis)

Shared views are read-only against a pinned dashboard version, which makes them highly cacheable. This is the core lever for protecting the datastores.

### What We Cache

- Rendered shared-view payloads, keyed by `tenant_id : dashboard_id : version : viewport_class`. Because the version is pinned in the token, the cache key is naturally immutable — a given version never changes underneath us.
- Aggregated query results from OpenSearch/Postgres feeding each panel, cached separately so multiple shares of related dashboards can reuse them.

### TTL & Invalidation

- Default payload TTL: 5 minutes for "live" shares, up to 1 hour for shares explicitly pinned to a frozen snapshot.
- Revocation or unshare must purge the relevant cache keys immediately — a revoked link must never be served a stale cached payload. Cache purge is triggered off the same event that writes the revocation to the Redis revocation set.
- Cache must be tenant-partitioned; no shared key namespace across tenants, to avoid any possibility of cross-tenant cache poisoning or bleed.

### Stampede Protection

For popular shares we must prevent a cache-miss stampede from hammering the origin. Use a single-flight / request-coalescing lock in Redis per cache key, plus stale-while-revalidate so viewers get the last-good payload while one worker recomputes.

## Rate Limiting

Rate limiting serves both abuse prevention (enumeration, scraping) and load protection:

- Per-IP limit on the external share endpoint (e.g. token-bucket, ~60 req/min sustained, short burst allowance).
- Per-share-slug limit to cap the cost any single link can impose, independent of source IP.
- Global circuit breaker: if origin datastore latency crosses a threshold, shed load by serving cached/stale payloads only and returning a friendly "temporarily unavailable" for cache misses rather than degrading the datastore for internal users.
- Rate-limit counters live in Redis with sliding-window semantics; limits are configurable per tenant plan tier.

Heavy or expensive re-renders (large snapshot exports) should be pushed to a Temporal workflow rather than served synchronously on the request path, so a burst of exports cannot exhaust request workers.

## Mobile & Network Constraints

- Layout must be responsive; shared views are opened on phones far more than internal dashboards.
- No dependency on features requiring a logged-in session (no service-worker background sync tied to org auth).
- Assets must be compressed (Brotli/gzip) and images right-sized per `viewport_class` cache dimension.
- Graceful behavior on flaky connections: partial render with retry, never a blank page.

## Open Questions for PRD

- Do "live" shares reflect underlying data changes, or is every share effectively a snapshot? This decision drives TTL and invalidation complexity significantly.
- What per-tier rate limits do we expose to customers vs. keep internal?
- Do we need a global CDN edge for international recipients, and how does that interact with data-residency constraints in the compliance note?
