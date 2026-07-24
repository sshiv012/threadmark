Sam Rivera: Marta, you're Ops Director at Helio Logistics. You're the enterprise voice here. How do you think about sharing analytics dashboards outside Helio?
Marta Silva: With caution, and with process. We move freight for a lot of partners, and they constantly want visibility — shipment status, on-time rates, exception dashboards. Today we export to spreadsheets and email them, which is slow and, frankly, insecure. I'd love live sharing, but at our scale "share a link" raises a dozen questions before it's allowed.
Sam Rivera: Walk me through those questions.
Marta Silva: First: who exactly can see it, and how do I prove that later? Second: does it respect the data boundaries we already have? Partner A must never see Partner B's shipments. Third: can I turn it off instantly across the whole org, not link by link?
Sam Rivera: Let's take the data boundary point. That's about scoping.
Marta Silva: It's the whole ballgame. Our dashboards are multi-tenant in spirit — one dashboard, many partners' data. If external sharing doesn't enforce row-level scope, so a shared link only shows that partner's slice, it's a non-starter. I can't rely on a human to filter before sharing. The link itself has to carry the scope.
Sam Rivera: Understood. On the "who can see it" and proving it later — that's audit.
Marta Silva: Yes. For every externally shared dashboard I need an audit trail my compliance team can export: who created the share, which partner it went to, every access with timestamp and ideally source, and any changes to permissions. When we do our annual review, "we think only the right people saw it" is not an acceptable answer. I need records.
Sam Rivera: How long do those records need to live?
Marta Silva: Years, not months. Logistics contracts have long tails and disputes surface late. Retention and export both matter — don't trap the log inside your UI.
Sam Rivera: You mentioned turning it off org-wide. Say more.
Marta Silva: If we lose a partner, or Tom's security team flags something, I need one action that revokes all external access to a given dashboard or from a given partner — not asking each manager to find their own links. Central control. And role separation: the person who can create a share shouldn't necessarily be the person who approves external sharing being enabled at all.
Sam Rivera: So there's an approval layer above the individual share.
Marta Silva: For enterprise, yes. I'd want external sharing to be a capability that's governed — maybe off by default, enabled per dashboard or per team by an admin, with viewer-only as the only external role. We would almost never give an external party editor rights. They view, full stop.
Sam Rivera: What about the recipient experience? These partners aren't technical.
Marta Silva: It has to be simple for them but authenticated. Most of our partners have their own identity systems, so SSO federation is ideal — they log in with their own corporate credentials and we know it's really them. Where SSO isn't available, at minimum email verification. A bare password on a link is weak for the data we're talking about.
Sam Rivera: And performance? Some of these dashboards are large.
Marta Silva: They're big, and partners in other regions open them. The shared view must load quickly regardless of location, and it can't fall over during peak season when everyone's checking shipments. Slow external views make us look worse than the spreadsheet did.
Sam Rivera: Watermarking — relevant to you?
Marta Silva: Useful, yes. If a partner screenshots a shared exceptions dashboard and it ends up somewhere it shouldn't, a visible watermark tying it to that partner and time helps us have the right conversation. It won't stop a determined leaker, but it changes behavior and helps attribution.
Sam Rivera: If I gave you one thing first, what should it be?
Marta Silva: Governed, scoped, viewer-only sharing with a real audit log and SSO. That combination gets it past my security review. The niceties come after the guardrails.
Sam Rivera: Clear. Governance, row-level scope, org-wide revoke, exportable long-lived audit, SSO federation, fast global views.
Marta Silva: You've got it. Make it something I can defend in an audit and I'll be your champion internally.
