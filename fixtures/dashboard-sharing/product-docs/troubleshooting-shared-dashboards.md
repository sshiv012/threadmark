# Troubleshooting Shared Dashboards

This guide covers the most common problems recipients and editors hit with external dashboard share links, and how to resolve them. If your issue is not listed, contact support with the link token (the part after `/d/` in the URL) and the approximate time of the problem.

## "This link has expired"

The link reached its expiry date, or an editor shortened the expiry below the current time.

- **As a recipient:** ask the person who shared it to extend or reissue the link.
- **As an editor:** open **Share → External link → Manage links**, select the link, and extend the expiry date. Extending re-enables the same URL. If the token was regenerated, the old URL stays dead and you must send the new one.

## "This link is no longer available"

The link was **revoked**, or its **token was regenerated**. Revocation is permanent and cannot be undone. Create a new link and redistribute it. Check the audit log to see who revoked it and when.

## Password Not Accepted

- Confirm you are using the current password — editors can change it at any time, which locks out the old one.
- Passwords are case-sensitive.
- Repeated failures are logged; after several wrong attempts the viewer may be briefly rate-limited. Wait a minute and retry, or ask the editor to reset the password.

## Blank or Empty Dashboard

A link loads but shows no data, or widgets spin indefinitely.

Likely causes:

- **Snapshot with no data at share time.** If the link uses a snapshot and the dashboard had no results when shared, the snapshot is genuinely empty. The editor should refresh the snapshot after data exists.
- **Live data + revoked source access.** For live-data links, if the underlying data source connection was removed or its credentials expired, widgets cannot load. The editor must fix the data source; recipients cannot.
- **Filtered view excludes everything.** A "Share a view" link only shows selected widgets; if a filter resolves to no rows, the view looks blank. Adjust or clear filters if the link allows it.
- **Browser extensions.** Aggressive ad/privacy blockers occasionally block dashboard assets. Try an incognito window with extensions disabled.

## SSO / Email Verification Fails

- The email you entered may not be on the link's allowlist. Ask the editor to add your address or domain.
- One-time codes expire quickly; request a fresh code rather than reusing an old email.
- Corporate mail filters sometimes delay the code email. Check spam and wait a minute.

## Slow Loading

- **Live-data links** re-run queries on each load; large or complex dashboards are slower than snapshots. If freshness is not required, ask the editor to switch the link to a snapshot.
- First load after a period of inactivity is slower due to cold caches; a reload is usually faster.
- Very wide date ranges or many widgets increase load time. Editors can split heavy dashboards or share a scoped view.

## Mobile Display Issues

Shared dashboards are responsive but dense dashboards are designed for larger screens.

- Widgets reflow into a single column on narrow screens; wide tables scroll horizontally within their own container.
- If a dashboard looks cramped, rotate to landscape or open on a tablet/desktop.
- Watermarks remain visible on mobile and cannot be dismissed.

> Known gap: exporting to PDF from a mobile browser is not fully supported; some layouts clip. Export from desktop for reliable output.

## Export Button Missing

Export is **off by default**. If a recipient cannot export, the editor did not enable **Allow export** on that link. The editor can turn it on in the link settings; the change applies on the next load.

## Escalating to Support

If none of the above resolves the issue, gather: the link token, the recipient's browser and OS, the time of the attempt, and any error text shown. Editors can cross-reference the audit log to confirm what the server recorded. See Link Settings for expiry/revoke behavior and Security & Compliance for SSO and audit details.
