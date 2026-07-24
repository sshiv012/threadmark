# Ticket #1042 — Shared dashboard link expired too soon

From: dana.okafor@northwind.example
We shared an analytics dashboard with a client at Helio Logistics using an external link on Tuesday, and by Wednesday morning the link was already dead. The client got an "access expired" page. We didn't set any expiry manually — is 24h the default? That's way too short for a client review cycle that runs over a week.

From: Jordan Lee
Hi Dana — thanks for flagging. You're right: external sharing links currently default to a 24-hour expiry as a safety measure so links don't leak indefinitely. You can extend this under Share settings → Link expiry, where the options are 24h, 7 days, 30 days, or a custom date. For an ongoing client review, 7 or 30 days is usually the right call.

From: dana.okafor@northwind.example
Got it. Two problems though: (1) the default being 24h is a trap — nobody on my team expected it, and (2) when the link expired, the client saw a generic error with no way to request renewal. They just emailed us confused. Can the expired page at least say "ask the owner to renew"?

From: Raj Patel
+1 from Support. We've had three similar tickets this month. Suggestion: let org admins set a default expiry policy (e.g. Northwind defaults to 7 days), and add a "request access" button on the expired-link page that pings the dashboard owner.

From: Priya Nair
This is good feedback. Here's where we land: the 24h default is intentional for security, but we agree it should be configurable per-org. I've opened THREAD-2231 to add an admin-level default expiry policy and THREAD-2232 for a friendlier expired-link page with a "request renewal" action that notifies the owner and writes to the audit log. Near term, Dana, please set expiry to 7d on that client link and re-share — the new link will carry the new window.

From: dana.okafor@northwind.example
Perfect, re-shared at 7 days and the client confirmed access. Thanks all — looking forward to the org default so I stop getting bitten by this.
