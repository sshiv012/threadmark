# Security and Compliance for Shared Dashboards

External dashboard sharing in Threadmark is built to prevent public data leaks while keeping analytics accessible to the partners and customers who need them. This guide covers identity (SSO), audit logging, watermarking, handling of personal data, and data residency.

## SSO for External Viewers

Beyond anonymous and password-protected links, Threadmark supports **SSO-verified external access**. Instead of a shared secret, viewers prove control of an email address before the dashboard loads.

Two modes are available on Enterprise plans:

- **Email one-time code** — the viewer enters an email, receives a six-digit code, and is admitted if the address matches an allowlist you define (specific addresses or whole domains, e.g. `@partner.com`).
- **SAML/OIDC federation** — for partners who have their own identity provider, you can federate so their employees sign in with their corporate credentials. Requires setup by both workspaces' admins.

SSO-verified access is the only mode that reliably attributes activity to a real person in the audit log, so it is required by policy for dashboards containing regulated or personal data.

## Audit Logging

Every meaningful action on a shared dashboard is logged. Log entries include the event type, timestamp (UTC), the link token, the resolved viewer identity (email if SSO/verified, otherwise anonymous), source IP, and coarse geolocation.

Logged events include: link created, link setting changed, link viewed, export performed, password entered incorrectly, link expired, link revoked, and token regenerated.

Admins access logs under **Workspace Settings → Audit log**, filterable by dashboard, link, actor, or date range. Logs are retained for **13 months** and can be streamed to an external SIEM via the Audit Streaming API on Enterprise. Logs are read-only and cannot be edited or deleted from the UI.

## Watermarking

When **watermarking** is enabled for a link, Threadmark overlays a diagonal, semi-transparent watermark across the dashboard and any exported PDF/PNG. The watermark shows the viewer's identity (email or "shared link"), the workspace name, and the access timestamp. This deters casual screenshotting and re-sharing and helps trace a leaked export back to a viewing session. Watermarking can be enforced workspace-wide by an admin so individual editors cannot turn it off.

## Personal Data and GDPR / PII

Threadmark treats dashboard contents as data you control. To reduce exposure of personal data:

- Use **Share a view** to exclude widgets containing PII rather than sharing the whole dashboard.
- Prefer **snapshots** so recipients cannot see later records added to a live dataset.
- Use **SSO-verified access** so you have a lawful record of who accessed personal data.

Threadmark acts as a processor for the data you load. Data Processing Addendums are available for Enterprise. Viewer email addresses collected during SSO verification are processed only to authenticate and log access, and are subject to the same retention as audit logs.

> Known gap: Threadmark does not yet automatically detect or redact PII inside dashboard widgets. Screening content before sharing is the editor's responsibility.

## Data Residency

New workspaces can be provisioned in a **US**, **EU**, or **APAC (Sydney)** region. All dashboard data, snapshots, and audit logs for that workspace are stored and processed in-region. Share links are served from the workspace's home region; external viewers connect to that region regardless of where they are located, so an EU-resident workspace keeps its data in the EU even when shared with a US recipient.

Region is chosen at workspace creation and **cannot be changed afterward** without a migration handled by support. Cross-region workspace moves are an Enterprise-only, manual process.

## Admin Controls Summary

Workspace admins can: disable external sharing entirely, require SSO or password on all external links, enforce watermarking, cap maximum link expiry, and restrict which domains may receive links. See Managing Permissions for roles and Link Settings for per-link controls.
