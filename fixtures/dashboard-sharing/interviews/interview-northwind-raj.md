Sam Rivera: Raj, you lead support at Northwind. When it comes to external dashboard sharing, what lands on your desk?
Raj Patel: The cleanup. Right now people share dashboards in ad hoc ways — a screenshot here, a PDF there, occasionally someone gives out their own login, which makes me lose sleep. When something goes wrong, the ticket comes to me.
Sam Rivera: What does "goes wrong" usually look like?
Raj Patel: Three flavors. One: "I shared the wrong thing, can you un-share it?" Two: "The link stopped working and my customer is annoyed." Three, the scary one: "Someone forwarded a link and now a person we didn't intend has our data."
Sam Rivera: Let's take those in order. The "un-share it" case — what do you need?
Raj Patel: Instant revoke, and I need to be able to do it on behalf of a user. The PM who created the link might be on a plane. If a customer calls in a panic, I want to open the dashboard, see every active share, and kill one or all of them immediately. A list of live links with who they went to and when they expire.
Sam Rivera: So support needs visibility into all shares, not just the creator.
Raj Patel: Exactly. Otherwise every revoke becomes a scavenger hunt. And I want an audit log I can actually read — created by whom, opened when, revoked by whom. When a customer disputes what happened, that log is my only source of truth.
Sam Rivera: The "link stopped working" case?
Raj Patel: Usually expiry. Which is good that it expires — but I need to explain it clearly and re-issue fast. If a link expired, the external viewer should see a friendly "this link has expired, contact your Northwind rep" page, not a broken 404 or a scary error. Half my tickets are just confused people hitting a dead link with no context.
Sam Rivera: Good detail. And the forwarding case — the scary one.
Raj Patel: That's where access controls earn their keep. If a link is forwarded, I want options: require a password, or require the recipient to verify their email, or lock it to SSO for the bigger accounts. And watermarking — if someone screenshots a shared view and it leaks, a watermark with their email and a timestamp tells me where it came from. It's both a deterrent and forensics.
Sam Rivera: Would password-per-link be enough, or do you need the heavier auth?
Raj Patel: Depends on the customer tier. For a small client, a password I can regenerate is fine. For enterprise, they'll want it tied to their identity provider, but that's more Wei and the security team's world. For support, the password and email-verify options cover eighty percent of my pain.
Sam Rivera: How much volume are we talking?
Raj Patel: Sharing tickets are maybe fifteen percent of my queue and rising, because more customers ask for live data. Every one of them is slow to resolve because I'm piecing together what happened from Slack messages. A proper audit log alone would cut my handle time in half.
Sam Rivera: If you could wave a wand, what's the one feature?
Raj Patel: A single "manage shares" screen per dashboard: every active link, recipient, expiry, open count, and a revoke button on each row. Give me that and the audit log behind it, and I stop being the human undo function.
Sam Rivera: What about false alarms — customers reporting a leak that wasn't?
Raj Patel: That happens weekly. Someone assumes the worst. If I can pull the audit log and show "only these two verified emails ever opened it," I calm them down in minutes instead of escalating to engineering. The log is as much about proving nothing bad happened as catching when it did.
Sam Rivera: This is gold, Raj. Revoke-on-behalf, all-shares visibility, readable audit log, graceful expiry pages, watermarking for leaks.
Raj Patel: You got it. Build for the moment someone's panicking, because that's when they'll remember whether the tool helped.
