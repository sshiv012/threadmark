# Sharing a Dashboard Externally

Threadmark lets you share analytics dashboards with people outside your organization using secure share links. This guide walks through creating a link, choosing what recipients can see, and sending it. External sharing is available on Team and Enterprise plans; on the Starter plan you can share within your org only.

## Before You Start

To create an external share link you need the **Editor** or **Owner** role on the dashboard. Viewers cannot generate share links. If the "Share externally" button is greyed out, your workspace admin has likely disabled external sharing for the workspace — see your admin or the Security & Compliance guide.

Every dashboard you share must belong to a Threadmark project. Draft dashboards that have never been saved cannot be shared; save the dashboard first.

## Creating a Share Link

1. Open the dashboard you want to share.
2. Click **Share** in the top-right toolbar.
3. In the dialog, switch to the **External link** tab. (The **Invite people** tab is for org members only.)
4. Click **Create link**. Threadmark generates a unique, unguessable URL of the form `https://share.threadmark.app/d/<token>`.
5. Adjust the link settings (see below), then click **Copy link** to put it on your clipboard.

The link is live the moment it is created. Anyone with the URL can open it subject to the access controls you set, so treat the URL like a password until you have added an expiry or password.

## Choosing What Recipients See

External share links are **viewer-only by default**. Recipients can read the dashboard, apply built-in filters, and export to PDF or PNG if you allow it, but they cannot edit widgets, change the underlying query, or see other dashboards in the project.

When you create the link you can toggle:

- **Allow export** — lets viewers download PDF/PNG/CSV snapshots. Off by default.
- **Show live data** — when on, the dashboard refreshes against live data on each load. When off, viewers see a snapshot frozen at share time. Snapshots are recommended when sharing with parties who should not see subsequent updates.
- **Include comments** — whether the dashboard's comment thread is visible externally. Off by default to avoid leaking internal discussion.

### Scoping to Specific Widgets

If a dashboard mixes internal and external-appropriate content, use **Share a view** instead of the whole dashboard. Select the widgets to include, and Threadmark creates a filtered view that hides everything else. This is the safest way to avoid exposing sensitive metrics.

## Sending the Link

You can distribute the copied URL through any channel — email, Slack, a customer portal. For higher-touch delivery, use **Send via email** in the share dialog: enter recipient addresses and Threadmark emails them the link. Note that all recipients currently share a **single link**, so revoking or expiring it affects everyone at once, and the audit log attributes activity to the link rather than to an individual. Per-recipient links — revoking or auditing one recipient without affecting the others — are a frequently requested capability that isn't available yet.

## What Recipients Experience

External viewers open the link in any modern browser without a Threadmark account (unless you require SSO or a password). They see a branded, read-only view with your workspace logo, the dashboard title, and a watermark if watermarking is enabled. There is no sign-up prompt and no access to the rest of your workspace.

## Managing Links You Have Created

All links for a dashboard appear under **Share → External link → Manage links**, showing creation date, creator, expiry, and last-accessed time. From here you can revoke a link, change its settings, or regenerate its token. See the Link Settings guide for expiry, passwords, and revocation, and the Managing Permissions guide for the difference between viewer and editor access.
