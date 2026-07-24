# External Dashboard Sharing — Compliance, Audit Logging & PII

Author: Priya Nair (Eng Lead) · Reviewed by: Wei Chen (Engineer)
Status: Draft for PRD input · Context: Threadmark external dashboard sharing

Sharing dashboards outside the org means Threadmark data crosses a trust boundary, which pulls in audit, privacy, residency, and retention obligations. This note captures the compliance constraints the PRD must satisfy so that external sharing is defensible in a customer security review and under GDPR.

## Audit Logging

Every meaningful action on the external-sharing surface must produce an immutable audit record. Auditing is a first-class requirement, not a nice-to-have — customers will ask for it during procurement.

### Events We Must Log

- Share created (who, which dashboard/version, access mode, expiry, allowlist).
- Share configuration changed (expiry extended, allowlist edited, passphrase set).
- Share revoked or expired.
- Share viewed — with token `jti`, resolved identity (SSO subject or "anonymous link"), source IP, coarse geo, user agent, and timestamp.
- Failed access attempts (expired, revoked, wrong passphrase) for enumeration detection.

### Pipeline Constraints

- Audit events are emitted onto a durable, append-only pipeline. They must never be dropped silently; if the audit sink is unavailable we buffer and back-pressure rather than serve unlogged views for sensitive shares.
- Long-running or fan-out audit processing (e.g. exporting logs to a customer's SIEM) runs through a Temporal workflow for reliability and retry.
- Audit records are tamper-evident (append-only store, no in-place updates or deletes outside the retention job).
- Audit logs are themselves tenant-scoped and access-controlled; a tenant sees only its own share activity.

## PII & GDPR

External sharing touches two categories of personal data: the content of dashboards (which may embed PII) and the metadata we collect about viewers (IP, email, geo).

- Viewer metadata (IP, email from SSO, user agent) is personal data under GDPR and must be handled on a lawful basis, documented, and minimized. We collect only what audit and security require.
- Right-to-erasure requests must be able to reach viewer metadata in audit logs; design retention so records can be pseudonymized or purged for a given data subject without destroying the security value of the log.
- Dashboard content may contain PII belonging to the sharing tenant's own users. We do not inspect or repurpose it, but we must ensure it is only ever served through the isolation controls in the auth note.
- A Data Processing Agreement posture: Threadmark is a processor for shared content; the sharing tenant is the controller. The PRD copy and defaults must not encourage over-sharing.

## Data Residency

- Some tenants are contractually bound to a region (EU-only, US-only). Shared-view serving, caching (Redis), blob access (S3-compatible), and audit storage must all respect the tenant's residency zone.
- A CDN or edge cache for external recipients must not replicate residency-restricted payloads outside the permitted region. If we cannot guarantee this at the edge, residency-restricted shares fall back to region-pinned origin serving.
- Cross-region revocation propagation must still be fast even when data does not leave a region.

## Watermarking

Watermarking is a deterrent and an attribution tool for leaked screenshots.

- Shared views for sensitive dashboards render a visible watermark: viewer identity (or "shared link"), tenant name, and timestamp.
- For SSO-identified viewers, the watermark carries the authenticated email so a leaked screenshot is traceable to a recipient.
- Watermarks must be rendered server-side or in a way that is not trivially removable via DOM edits; a client-only overlay is insufficient for the sensitive tier.
- Watermarking is configurable per share, defaulting on for shares marked sensitive.

## Retention

- Audit records: retained for a configurable period (default 400 days) to satisfy security-investigation needs, then purged or pseudonymized by a scheduled job.
- Cached shared-view payloads: ephemeral, governed by the TTLs in the performance note; never a long-term store of tenant data.
- Expired/revoked share grants: metadata retained for audit, but the grant is inert and un-servable.
- Snapshot blobs tied to a share: lifecycle-expired from the blob store when the share is deleted, subject to any legal-hold override.

## Open Questions for PRD

- What is the default audit retention, and is it customer-configurable per plan tier?
- Which shares require mandatory (non-disableable) watermarking?
- How do we surface a "who has viewed this" report to the sharing user without exposing raw viewer IPs?
- Do we need per-region audit stores, or one global store with residency-tagged partitions?
