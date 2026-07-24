# Link Settings: Expiry, Passwords, and Revoking Access

Every external share link in Threadmark has its own settings that control how long it lives, whether a password is required, and whether it is still active. This guide covers those controls and how to change them after a link is created.

## Where Link Settings Live

Open the dashboard, click **Share**, switch to the **External link** tab, and select a link under **Manage links**. Each link has its own settings panel. Changes save immediately and apply to every future load of that link — there is no need to reissue the URL.

## Expiry

By default a new link **does not expire**. We strongly recommend setting an expiry for any link shared outside the org.

You can set expiry as:

- **A fixed date/time** — the link stops working at that moment, in the workspace time zone.
- **A relative duration** — 24 hours, 7 days, or 30 days from creation.
- **Never** — the link stays live until manually revoked.

When a link expires, recipients see an "This link has expired" page rather than the dashboard. Expiry is evaluated on the server at load time, so changing the clock on a recipient's device has no effect.

### Extending or Shortening Expiry

You can move the expiry date forward or backward at any time. Shortening it below the current time immediately disables the link (equivalent to revoking). Extending it re-enables a link that expired, keeping the same URL and token.

## Passwords

A link can require a **password** before the dashboard loads. Turn on **Require password**, set a value (minimum 8 characters), and share it with recipients through a separate channel from the link itself.

Notes:

- Passwords are stored hashed; Threadmark cannot show you an existing password, only replace it.
- Changing the password takes effect immediately and locks out anyone who only has the old one.
- Password protection is independent of SSO. For identity-verified access rather than a shared secret, use SSO (see Security & Compliance).

## Revoking Access

Revoking permanently disables a link. Click **Revoke** next to the link in **Manage links** and confirm. Revocation:

- Takes effect within seconds, globally, for every recipient of that link.
- Cannot be undone — the token is burned. If you need access again, create a new link (which will have a new URL).
- Is recorded in the audit log with who revoked it and when.

### Revoking One Recipient vs Everyone

A single link is shared by everyone who has that URL, so revoking it cuts off all of them. If you need to revoke access for one recipient while others keep working, you must have sent **individual links** via **Send via email** (see the Sharing a Dashboard guide). Each individual link can be revoked on its own.

> Known gap: Threadmark does not currently support converting an existing shared link into per-recipient links after the fact. Decide up front whether you need individual links.

## Regenerating a Token

If you suspect a URL leaked but do not want to change the link's settings, use **Regenerate token**. This issues a new URL for the same link configuration and invalidates the old URL immediately. Recipients must be sent the new URL.

## Recommended Defaults

For most external shares: set a 7- or 30-day expiry, require a password or SSO, turn off export unless needed, and prefer snapshots over live data. Review active links periodically under Manage links and revoke anything stale.

See also: Sharing a Dashboard (creating links), Managing Permissions (viewer vs editor), and Troubleshooting (expired-link and access errors).
