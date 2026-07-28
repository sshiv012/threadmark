import type {
  Action,
  MembershipRole,
  Principal,
  PrincipalKind,
  Resource,
  ResourceType,
} from './types.js';

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

// The only kinds `can()` recognizes. An unrecognized kind (cast-through JWT
// claim, future DB drift, a typo'd literal) is denied for EVERY action, not
// just the human-only one — an unsupported principal kind must never fall
// through to the role table and inherit whatever permissions its `role`
// value happens to carry.
const KNOWN_PRINCIPAL_KINDS: ReadonlySet<PrincipalKind> = new Set(['human', 'agent_persona']);

// A Map, not a plain object: `ROLE_ACTIONS[principal.role]` on a plain
// object would resolve a role of '__proto__' to `Object.prototype` (not
// `undefined`), and `.has(...)` on that throws — silently breaking the
// never-throws contract for a single adversarial string. Map.get() has no
// such prototype-chain lookup, so an unrecognized role key just misses.
const ROLE_ACTIONS: ReadonlyMap<MembershipRole, ReadonlySet<Action>> = new Map([
  [
    'owner',
    new Set<Action>([
      'evidence_document:read',
      'evidence_document:write',
      'agent_run:trigger',
      'agent_run:read',
      'workspace:manage_members',
    ]),
  ],
  [
    'editor',
    new Set<Action>([
      'evidence_document:read',
      'evidence_document:write',
      'agent_run:trigger',
      'agent_run:read',
    ]),
  ],
  ['commenter', new Set<Action>(['evidence_document:read', 'agent_run:read'])],
  ['viewer', new Set<Action>(['evidence_document:read', 'agent_run:read'])],
]);

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
 * 3. Known-kind gate — an unrecognized `PrincipalKind` (cast-through JWT
 *    claim, future DB drift) is denied for EVERY action here, not just the
 *    human-only one below — it must never inherit its `role`'s permissions.
 * 4. Human-only structural gate, as an ALLOWLIST (`kind === 'human'`), not a
 *    denylist on `'agent_persona'` — redundant with gate 3 for unknown
 *    kinds, but still the deciding gate for the real `'agent_persona'` kind.
 * 5. Role → allowed-actions table lookup (terminal, `Map.get()` — never
 *    throws even for an unrecognized/prototype-colliding role string like
 *    `'__proto__'`, unlike a plain-object lookup).
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

  if (!KNOWN_PRINCIPAL_KINDS.has(principal.kind)) return false;

  if (HUMAN_ONLY_ACTIONS.has(action) && principal.kind !== 'human') return false;

  const allowed = ROLE_ACTIONS.get(principal.role) ?? new Set<Action>();
  return allowed.has(action);
}
