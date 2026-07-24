# External Dashboard Sharing — Auth & Data Isolation Constraints

Author: Priya Nair (Eng Lead) · Reviewed by: Wei Chen (Engineer)
Status: Draft for PRD input · Context: Threadmark external dashboard sharing

This note captures the authentication, authorization, and tenant-isolation constraints that the "External dashboard sharing" feature must respect. The goal is to let people outside the Threadmark org view a specific dashboard through a secure link without ever exposing another tenant's data or turning a leaked URL into a full account compromise.

## Two Access Modes

We must support two distinct external-viewer flows, and the PRD should treat them as separate authorization paths.

### Signed Expiring Link Tokens (unauthenticated viewers)

The default mode is a signed link that grants read-only access to exactly one dashboard version. The token is a JWT-style bearer credential signed with a per-tenant key (keys live in our KMS, never in Postgres). Constraints:

- Tokens must carry `tenant_id`, `dashboard_id`, `dashboard_version`, `scope=read`, `exp`, and a random `jti`. No PII in the token body.
- Maximum lifetime is 30 days; default 7 days. Expiry is enforced server-side, not just by the client.
- Every token maps to a row in Postgres (`share_grants`) so it can be revoked instantly. Revocation must not wait for expiry. We check the `jti` against a Redis revocation set on every request (fail-closed if Redis is unavailable).
- Tokens are single-scope: one token cannot be widened to a second dashboard or to edit access.

### SSO-Backed Access (named external viewers)

For customers who require identified access, a share can require the viewer to authenticate via their own IdP (SAML/OIDC). In this mode the link resolves to an SSO challenge, and access is gated on a verified email domain allowlist configured by the sharing tenant. The token then binds to the authenticated subject, and audit logs capture the real identity rather than "anonymous link holder."

## Tenant & Data Isolation

External access is the highest-risk path for cross-tenant leakage, so isolation cannot rely on application-layer filtering alone.

- Every query that serves a shared dashboard must be scoped by `tenant_id` at the data layer. We will enforce Postgres row-level security (RLS) policies keyed on a session GUC set from the validated token, so a bug in the app cannot return another tenant's rows.
- OpenSearch queries for shared views must inject a mandatory `tenant_id` filter server-side; the external surface must never accept a raw query body from the client.
- Blob assets (chart exports, attachments) in the S3-compatible store are served only through short-lived, tenant-scoped presigned URLs generated per request — never a durable public object URL.
- The shared-view rendering path runs through a dedicated read-only service identity with no write grants and no access to admin tables.

## Authorization Checks

Authorization must be re-evaluated on every request, not cached at link creation time:

1. Validate token signature and `exp`.
2. Confirm `jti` is not revoked (Redis).
3. Confirm the `share_grant` row is still active and the parent dashboard has not been unshared or deleted.
4. Confirm the requested resource matches the token's `dashboard_id` and version.
5. For SSO mode, confirm the authenticated subject's domain is still on the allowlist.

Any failed check returns a generic 404, never a 403 — we do not confirm the existence of resources to unauthenticated callers.

## Threat Model

### Link Leakage

Links will end up in Slack, email forwards, and browser history. Mitigations: short default expiry, one-click revoke, optional SSO gating, optional passphrase on high-sensitivity shares, and watermarking (see compliance note). The token grants read-only single-dashboard scope, limiting blast radius.

### Enumeration & Guessing

- Token `jti` and any public share slug must be high-entropy (≥128 bits) and unguessable — no sequential IDs in URLs.
- The external endpoint must be rate-limited per IP and per slug prefix to defeat brute-force scanning (see performance note).
- Uniform 404 responses prevent an attacker from distinguishing "expired," "revoked," and "never existed."

### Token Replay

Short expiry plus revocation limits replay. For SSO shares we bind tokens to the authenticated session so a copied link still forces re-auth.

## Open Questions for PRD

- Do we allow re-sharing (a viewer forwarding to a colleague) or treat every recipient as a distinct grant?
- Is passphrase protection MVP or fast-follow?
- What is the maximum acceptable revocation propagation delay across regions?
