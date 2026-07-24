# PRD & Retro: Public Embed Links (Deprecated)

## Overview

This document is a combined PRD and retrospective for Threadmark's "Public Embed Links" feature — a capability that was shipped, ran in production for roughly two quarters, and was then deprecated after two data-leak incidents. It exists to preserve the history and, more importantly, the lessons, so that any future external-sharing effort inherits them rather than rediscovering them the hard way.

Public Embed Links let an Editor generate a URL that rendered a single dashboard as a standalone public web page, embeddable via iframe into wikis, marketing pages, and investor updates. The link required no authentication. That was the whole point, and — in hindsight — the whole problem.

Authors: Sam Rivera (PM), Priya Nair (Eng Lead), Leo Martins (Designer).

## Background

After Internal Dashboards v1 shipped, the most common request was "let me show this outside the company." Internal Dashboards v1 had explicitly ruled external sharing out of scope, citing an unsolved access-control problem for multi-PRD aggregates. Under commercial pressure, we shipped Public Embed Links as a fast answer without closing that gap.

The design was simple: an Editor clicked "Create public link," we minted an unguessable token, and anyone with the URL saw a snapshot-rendered dashboard. There was no login, no expiry by default, no per-viewer identity, and no watermark. Revocation existed but was manual and buried in settings. Audit logging recorded link creation but not link access, because unauthenticated viewers had no identity to log.

## Goals (as originally stated)

- Let users share a dashboard externally with zero friction for the recipient.
- Support iframe embedding into external pages.
- Provide an unguessable token so links were not enumerable.

## Non-Goals (as originally stated)

- Per-viewer authentication was explicitly a non-goal — considered "too heavy" for the use case.
- Expiry and access auditing for the external audience were deferred to "a later iteration" that never shipped before deprecation.

In retrospect, the non-goals were the actual requirements. The features we deferred were precisely the controls that would have prevented the incidents.

## Requirements (retrospective analysis of what went wrong)

Two incidents drove deprecation:

1. **Incident A — stale snapshot leak.** A dashboard was made public for a board update. The underlying PRDs later had restricted content added, but the public link kept rendering fresh data (it re-queried, not a frozen snapshot as assumed), so newly-restricted PRD titles and evidence counts appeared on an unauthenticated URL. Because there was no expiry, the link was still live months later. Lesson: external artifacts must have enforced expiry and an unambiguous, documented snapshot-versus-live-data model.

2. **Incident B — link propagation.** A public embed URL was pasted into a shared external doc, indexed by a search engine, and surfaced revenue-related PRD metadata to people the org never intended. Because there was no per-viewer identity, we could not tell who saw it, and manual revocation happened only after a customer reported it. Lesson: external sharing needs access controls (ideally SSO or at least email-verified access), per-viewer audit, one-click revocation, and watermarking so leaked artifacts are traceable.

Consolidated requirements any future external-sharing feature must satisfy:

- Secure links with enforced, default-on expiry and easy revocation.
- Access controls: prefer SSO / verified-identity access over anonymous URLs; anonymous-by-default is disallowed.
- Per-viewer audit logging, including reads, for the external audience.
- Watermarking of externally-rendered content to deter and trace propagation.
- A clear, enforced data-freshness contract (snapshot at share time, never silently live).
- Aggregate-safety: an external artifact must never expose the union of PRDs the sharer themselves could not re-share.

## Open Questions

- Should external sharing ever permit truly anonymous access, or must every external viewer be identity-verified? Current lean: no anonymous access.
- How do we render a frozen snapshot that cannot silently pick up newly-restricted data, while still letting the sharer intentionally refresh?
- What is the right default expiry window — 7 days, 30 days? And should expiry be non-optional?
- Can watermarking survive screenshotting well enough to be useful for tracing?

## Risks

- Repeating history: any new link-based sharing that reintroduces anonymous access or optional expiry will reproduce Incidents A and B. These are the two failure modes to design against first.
- Data-freshness confusion: the gap between "snapshot" and "live" caused a real leak. If the model is ambiguous, it will leak again.
- Untraceable propagation: without per-viewer identity and watermarking, leaked links cannot be attributed or contained.
- Revocation latency: manual, buried revocation meant leaks stayed live for months. Revocation must be immediate and prominent.

## Closing Note

Public Embed Links was deprecated and its endpoints sunset. The feature is off, but the demand it answered is real. This retro is the required reading for the current "External Dashboard Sharing" investigation: reintroduce external sharing only with SSO/verified access, enforced expiry, revoke, per-viewer audit, watermarking, and a strict aggregate-safety and data-freshness contract — the exact controls whose absence caused the original failures.
