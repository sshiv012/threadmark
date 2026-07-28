/**
 * RBAC keystone types. `Principal` unifies humans and agent-personas so both
 * are gated by the exact same `can()` policy (see policy.ts) — a future API
 * auth middleware and a future agent tool-call gate both consume this
 * unchanged. `role` mirrors `packages/db/src/schema.ts`'s `membership_role`
 * pgEnum verbatim; a caller maps a real `memberships.role` column straight in
 * with no translation layer.
 */
export type MembershipRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export type PrincipalKind = 'human' | 'agent_persona';

interface PrincipalBase {
  readonly kind: PrincipalKind;
  /** Opaque identity — a `users.id`/`memberships.id` for humans, or however
   *  a future agent runtime identifies its personas. `packages/core` never
   *  imports `@threadmark/db` types, so this is deliberately not typed as one. */
  readonly subjectId: string;
  readonly workspaceId: string;
  readonly role: MembershipRole;
}

export interface HumanPrincipal extends PrincipalBase {
  readonly kind: 'human';
}

export interface AgentPersonaPrincipal extends PrincipalBase {
  readonly kind: 'agent_persona';
}

export type Principal = HumanPrincipal | AgentPersonaPrincipal;

export type ResourceType = 'evidence_document' | 'agent_run' | 'workspace';

/**
 * Namespaced `resourceType:verb`. Adding a future action (e.g.
 * `'prd_block:write'`) needs no change to `can()`'s gates — only a new
 * string here and a role-table entry in policy.ts.
 */
export type Action =
  | 'evidence_document:read'
  | 'evidence_document:write'
  | 'agent_run:trigger'
  | 'agent_run:read'
  | 'workspace:manage_members';

/**
 * `{type, workspaceId}` only — no row-level id. `can()` is a policy-shape
 * decision (can this role, in this workspace, do this category of thing),
 * not a row-ownership check; that stays the repository layer's job.
 */
export interface Resource {
  readonly type: ResourceType;
  readonly workspaceId: string;
}
