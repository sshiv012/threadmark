import type { Action, MembershipRole, Principal, Resource, ResourceType } from './types.js';

/**
 * Actions restricted to human principals, independent of the role table.
 * Membership management is a structural exception, not a role-table entry:
 * its blast radius extends beyond the resource it targets (it changes WHO
 * exists in a workspace at all), so a compromised agent persona must never
 * be able to exercise it regardless of its granted role — a prompt-injected
 * persona that could add/promote a member would defeat every other
 * role-based restriction below it.
 */
const HUMAN_ONLY_ACTIONS: ReadonlySet<Action> = new Set(['workspace:manage_members']);

const ROLE_ACTIONS: Readonly<Record<MembershipRole, ReadonlySet<Action>>> = {
  owner: new Set([
    'evidence_document:read',
    'evidence_document:write',
    'agent_run:trigger',
    'agent_run:read',
    'workspace:manage_members',
  ]),
  editor: new Set([
    'evidence_document:read',
    'evidence_document:write',
    'agent_run:trigger',
    'agent_run:read',
  ]),
  commenter: new Set(['evidence_document:read', 'agent_run:read']),
  viewer: new Set(['evidence_document:read', 'agent_run:read']),
};

function resourceTypeOf(action: Action): ResourceType {
  return action.split(':')[0] as ResourceType;
}

/**
 * Pure RBAC decision, checked in this exact order — the canonical order,
 * pinned now so nothing downstream (e.g. future audit logging of which gate
 * fired) can observe an unspecified sequence:
 *
 * 1. Cross-tenant gate (always first, non-negotiable). A workspaceId is
 *    never treated as a valid tenant match unless BOTH sides are non-empty
 *    and equal — two empty-string workspaceIds do not "match", since empty
 *    is never a real tenant.
 * 2. Resource/action consistency — the action's `resourceType:verb` prefix
 *    must match `resource.type`, else deny (catches caller bugs, fails closed).
 * 3. Human-only structural gate, as an ALLOWLIST (`kind === 'human'`), not a
 *    denylist on `'agent_persona'` — an unrecognized/future PrincipalKind
 *    must never fall through to the role table for a human-only action.
 * 4. Role → allowed-actions table lookup (terminal). `?? new Set()` guards a
 *    role value that reached this function unvalidated (e.g. DB/JWT drift)
 *    — never throws, always fails closed.
 *
 * Never throws for any input, well-typed or not.
 */
export function can(principal: Principal, action: Action, resource: Resource): boolean {
  const sameTenant =
    principal.workspaceId !== '' &&
    resource.workspaceId !== '' &&
    principal.workspaceId === resource.workspaceId;
  if (!sameTenant) return false;

  if (resourceTypeOf(action) !== resource.type) return false;

  if (HUMAN_ONLY_ACTIONS.has(action) && principal.kind !== 'human') return false;

  const allowed = ROLE_ACTIONS[principal.role] ?? new Set<Action>();
  return allowed.has(action);
}
