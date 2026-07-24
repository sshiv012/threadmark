# Managing Dashboard Permissions

Threadmark controls who can see and change a dashboard through roles. Roles work differently for people inside your organization and people you share with externally. This guide explains each role, how they combine, and how to change someone's access.

## Roles at a Glance

Threadmark defines three dashboard roles:

- **Viewer** — can open the dashboard, apply existing filters, and (if allowed) export snapshots. Cannot edit widgets, queries, layout, or settings, and cannot create share links.
- **Editor** — everything a Viewer can do, plus edit widgets and queries, change layout, and create or revoke external share links.
- **Owner** — everything an Editor can do, plus delete the dashboard, transfer ownership, and manage the dashboard's roles. Every dashboard has exactly one Owner; ownership can be transferred but not shared.

Project-level and workspace-level roles cascade down: a Project Admin is effectively an Editor on every dashboard in the project unless explicitly restricted.

## Org Members vs External Members

The two populations are governed separately.

### Org Members (Internal)

Org members are people in your Threadmark workspace. You grant them access from the **Invite people** tab of the Share dialog by entering their email or picking their name, then choosing Viewer, Editor, or Owner. Org members authenticate with their normal Threadmark account, so their identity is always known and attributed in audit logs.

Org members can also inherit access through **teams**. If a dashboard is shared with the "Growth" team, every current and future member of that team gets the assigned role automatically. Team-based grants are the recommended way to manage access at scale.

### External Members (Outside the Org)

External recipients never receive Editor or Owner roles. **All external access is viewer-only** — this is a hard platform limit, not a default you can override. External collaboration on the *content* of a PRD or dashboard must happen through an org member.

External viewers are identified in one of three ways depending on the link settings:

1. **Anonymous** — anyone with the URL. Audit logs record the link token and IP, not a person.
2. **Password** — anyone with the URL and password. Same attribution as anonymous.
3. **SSO / email verification** — the viewer proves an email address before entry, so logs attribute activity to that address. Recommended for regulated data.

## How Permissions Combine

When multiple grants apply, Threadmark uses the **most permissive** role that legitimately applies to an authenticated org member — direct grants, team grants, and project-admin inheritance are unioned. For external links, the link's own setting always caps access at viewer regardless of anything else, so an external link can never escalate to editor even if the recipient later joins your org (they would need a separate internal grant).

## Changing or Removing Access

- **Internal:** open **Share → Invite people → Manage access**, then change the dropdown next to a person or team, or click **Remove**. Changes take effect on their next page load.
- **External:** open **Share → External link → Manage links** and revoke or edit the link. Revoking is immediate; see the Link Settings guide.

## Common Pitfalls

- Granting Editor when Viewer is enough — most recipients only need to read.
- Sharing with an individual instead of a team, then forgetting to update it when staffing changes.
- Assuming an external link can be upgraded to editor. It cannot; invite the person as an org member instead.

For creating links see the Sharing a Dashboard guide; for identity and compliance see Security & Compliance.
