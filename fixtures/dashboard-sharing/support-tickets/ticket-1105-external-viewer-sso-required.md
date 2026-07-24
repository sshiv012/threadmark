# Ticket #1105 — Can we require SSO for external dashboard viewers?

From: aisha.rahman@brightseed.example
Feature question: we want to share a program dashboard with a partner org, but our compliance team won't allow anonymous link access to anything with PII. Can external sharing require the viewer to authenticate — ideally via their own SSO — instead of just anyone-with-the-link? We need named, verifiable access for GDPR reasons.

From: Jordan Lee
Hi Aisha — yes, external links support access controls beyond anonymous. Under Share settings you can set the audience to: (a) anyone with the link, (b) password-protected link, or (c) verified email — the viewer receives a one-time code at an allowlisted address before viewing. For partner SSO specifically (the partner authenticates with their own IdP), that's our SAML-federated guest access.

From: aisha.rahman@brightseed.example
Verified-email is closer to what compliance wants, but they'd really prefer the partner's own SSO so we're not managing a viewer list. Is the SAML guest access generally available, and does it log which named individual viewed what?

From: Priya Nair
SAML-federated guest access is available on Business and Enterprise plans. Setup: you add the partner's IdP metadata as a trusted external identity provider scoped to that dashboard (or a shared workspace), and their users authenticate against their own SSO — no local accounts on your side. Every view is logged against the asserted identity (email + IdP), so the audit log shows the named person, timestamp, and IP. Watermarking with the viewer's email can be enabled too, which compliance teams usually like for PII.

From: tom.becker@helio.example
Chiming in since Helio is the partner here — from our side, do we need to expose our full directory, or can Brightseed scope it so only our program team can authenticate? We don't want the whole company able to reach the link.

From: Priya Nair
You control that on your IdP side with a group/attribute release rule — only release the assertion for the program group, and Brightseed can additionally restrict by email domain and group claim. So it's scoped both ways. I'll send a setup doc covering IdP metadata exchange, the group-claim filter, and enabling per-viewer watermarking. Aisha, once your compliance team signs off on SAML guest access, reply here and I'll get your workspace flagged.

From: aisha.rahman@brightseed.example
This ticks the boxes — named access, partner SSO, per-viewer watermark, full audit trail. Sending to compliance now. Thanks both.
