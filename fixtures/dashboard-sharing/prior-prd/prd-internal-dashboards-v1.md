# PRD: Internal Dashboards v1

## Overview

This document defines the first version of Threadmark's internal dashboards feature. Threadmark is a collaborative, evidence-backed PRD workspace where product teams draft requirements, attach supporting evidence, and track decisions over time. As teams accumulated hundreds of PRDs, they asked for a way to see aggregate signal: which PRDs are stalled, which decisions lack evidence, and how review cycles trend across a quarter. Internal Dashboards v1 answers that need with a set of read-only, org-scoped views built on top of existing PRD and activity data.

The scope here is deliberately narrow. These dashboards are for members of a single Threadmark organization, rendered inside the authenticated app, governed entirely by the existing membership and role model. External sharing of any kind is explicitly out of scope for v1 (see Non-Goals), and this document records why that boundary exists so future efforts can reason about it.

Authors: Sam Rivera (PM), Priya Nair (Eng Lead), Leo Martins (Designer).

## Background

Threadmark's data model already distinguishes three primary roles at the workspace level: Owner, Editor, and Viewer. Owners manage billing, membership, and workspace settings. Editors can create and modify PRDs and attach evidence. Viewers have read-only access to PRDs they have been granted. Access is granted per-PRD or per-folder, and every access grant is recorded in an audit log that captures actor, target, and timestamp.

Before this project, the only way to understand portfolio-level health was to open PRDs one at a time. Several larger customers built brittle exports through our API and maintained spreadsheets by hand. This was error-prone, always stale, and — importantly — it duplicated sensitive PRD content into unmanaged locations outside Threadmark's permission boundary. One of the motivations for building first-class dashboards was to reduce that leakage of content into ad hoc spreadsheets by giving people the aggregate view they actually wanted, inside the product, under the existing controls.

A dashboard in v1 is a saved arrangement of widgets. Each widget queries PRD metadata (status, owner, last activity, evidence count, review state) and renders a chart or table. Crucially, widgets only ever read data the viewing user is already permitted to see. A dashboard does not create a new access path; it is a lens over data the user could already open directly.

## Goals

- Provide org-scoped, read-only dashboards composed of configurable widgets over PRD metadata.
- Enforce that every widget respects the existing per-PRD and per-folder permission model, with no widening of access.
- Support the three standard roles (Owner, Editor, Viewer) with dashboard capabilities that mirror their PRD capabilities.
- Record dashboard creation, edits, and views in the existing audit log.
- Reduce the practice of exporting PRD content into unmanaged spreadsheets by making the in-product aggregate view sufficient.

## Non-Goals

- External sharing of dashboards is out of scope. We will not produce shareable links, public URLs, or any mechanism that exposes a dashboard to someone who is not an authenticated member of the org with existing access to the underlying PRDs. This is the single most important boundary of v1.
- No embedding of dashboards into third-party tools or external web pages.
- No cross-organization dashboards or aggregation across workspaces.
- No write-back: dashboards cannot mutate PRDs or trigger workflows.

The reason external sharing is excluded is a matter of correctness and safety, not just prioritization. A dashboard is an aggregate over many PRDs. The moment a dashboard leaves the authenticated boundary, the per-PRD permission checks that make it safe no longer apply, and a single share could expose the union of many restricted documents to someone who was never granted any of them. We do not yet have an access-control design that can safely collapse a multi-PRD aggregate into a single external artifact. Until that design exists — with expiry, revocation, watermarking, and audit for the external audience — external sharing must remain closed. This constraint is a deliberate input to any future external-sharing effort.

## Requirements

1. Dashboards are owned by the org and stored with an owner reference and a role-based ACL that inherits from workspace membership.
2. Each widget resolves data through the same authorization layer used for direct PRD reads. If a viewer lacks access to a PRD, that PRD contributes nothing to the widget — not even aggregate counts.
3. Viewers may open dashboards shared with them but may not edit widget definitions. Editors may create and edit dashboards. Owners may additionally delete dashboards and manage the dashboard ACL.
4. All dashboard reads and writes emit audit-log events with actor, dashboard ID, and timestamp.
5. Empty or fully-filtered widgets render an explicit "no accessible data" state rather than silently omitting rows, so absence is never mistaken for zero.
6. Dashboard queries must be evaluated server-side; the client never receives PRD data the user cannot access.

## Open Questions

- Should aggregate counts be shown when a viewer can see some but not all PRDs in a widget's scope, or should partial visibility be flagged? Leaning toward flagging.
- Do we need a "dashboard-only" role for stakeholders who should see portfolio health but not individual PRDs? Deferred; risky because it decouples the aggregate from its permission basis.
- How should we handle deleted PRDs in historical trend widgets without leaking their former titles?

## Risks

- Aggregation leakage: a poorly scoped widget could imply the existence or state of PRDs a viewer cannot access. Mitigated by server-side authorization and the "no accessible data" state.
- Performance: portfolio-wide queries over large orgs may be slow; requires caching that must itself respect per-user permissions.
- Scope creep toward external sharing: stakeholders will ask to send dashboards outside the org. This PRD intentionally closes that door and documents the access-control gap that must be solved first.
