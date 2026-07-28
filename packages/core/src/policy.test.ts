import { describe, expect, it } from 'vitest';
import { can } from './policy.js';
import type { Action, MembershipRole, Principal, PrincipalKind, Resource } from './types.js';

const WS_A = 'workspace-a';
const WS_B = 'workspace-b';

function human(role: MembershipRole, workspaceId: string = WS_A): Principal {
  return { kind: 'human', subjectId: 'user-1', workspaceId, role };
}

function agent(role: MembershipRole, workspaceId: string = WS_A): Principal {
  return { kind: 'agent_persona', subjectId: 'persona-1', workspaceId, role };
}

function resource(type: Resource['type'], workspaceId: string = WS_A): Resource {
  return { type, workspaceId };
}

describe('can — happy path', () => {
  it('owner can read evidence_document', () => {
    expect(can(human('owner'), 'evidence_document:read', resource('evidence_document'))).toBe(true);
  });

  it('owner can write evidence_document', () => {
    expect(can(human('owner'), 'evidence_document:write', resource('evidence_document'))).toBe(
      true,
    );
  });

  it('owner can trigger an agent_run', () => {
    expect(can(human('owner'), 'agent_run:trigger', resource('agent_run'))).toBe(true);
  });

  it('owner can read an agent_run', () => {
    expect(can(human('owner'), 'agent_run:read', resource('agent_run'))).toBe(true);
  });

  it('owner can manage_members', () => {
    expect(can(human('owner'), 'workspace:manage_members', resource('workspace'))).toBe(true);
  });

  it('editor can read and write evidence_document', () => {
    expect(can(human('editor'), 'evidence_document:read', resource('evidence_document'))).toBe(
      true,
    );
    expect(can(human('editor'), 'evidence_document:write', resource('evidence_document'))).toBe(
      true,
    );
  });

  it('editor can trigger and read agent_run', () => {
    expect(can(human('editor'), 'agent_run:trigger', resource('agent_run'))).toBe(true);
    expect(can(human('editor'), 'agent_run:read', resource('agent_run'))).toBe(true);
  });

  it('editor cannot manage_members', () => {
    expect(can(human('editor'), 'workspace:manage_members', resource('workspace'))).toBe(false);
  });

  it('commenter can read evidence_document but not write it', () => {
    expect(can(human('commenter'), 'evidence_document:read', resource('evidence_document'))).toBe(
      true,
    );
    expect(can(human('commenter'), 'evidence_document:write', resource('evidence_document'))).toBe(
      false,
    );
  });

  it('commenter can read agent_run but not trigger it', () => {
    expect(can(human('commenter'), 'agent_run:read', resource('agent_run'))).toBe(true);
    expect(can(human('commenter'), 'agent_run:trigger', resource('agent_run'))).toBe(false);
  });

  it('viewer can read evidence_document but not write it', () => {
    expect(can(human('viewer'), 'evidence_document:read', resource('evidence_document'))).toBe(
      true,
    );
    expect(can(human('viewer'), 'evidence_document:write', resource('evidence_document'))).toBe(
      false,
    );
  });

  it('viewer can read agent_run but not trigger it', () => {
    expect(can(human('viewer'), 'agent_run:read', resource('agent_run'))).toBe(true);
    expect(can(human('viewer'), 'agent_run:trigger', resource('agent_run'))).toBe(false);
  });
});

describe('can — negative / adversarial (values cast past the type system)', () => {
  it('unrecognized action string is denied, not matched by accident', () => {
    const action = 'evidence_document:delete' as Action;
    expect(can(human('owner'), action, resource('evidence_document'))).toBe(false);
  });

  it('action with a resource-type prefix that matches no ResourceType is denied', () => {
    const action = 'documents:read' as Action;
    expect(can(human('owner'), action, resource('evidence_document'))).toBe(false);
  });

  it('empty-string action is denied, not treated as a wildcard', () => {
    const action = '' as Action;
    expect(can(human('owner'), action, resource('evidence_document'))).toBe(false);
  });

  it('action with extra colon segments does not parse into a false match', () => {
    const action = 'evidence_document:read:extra' as Action;
    expect(can(human('owner'), action, resource('evidence_document'))).toBe(false);
  });

  it('unrecognized role is denied by the table lookup, not silently elevated', () => {
    const role = 'admin' as MembershipRole;
    expect(can(human(role), 'evidence_document:read', resource('evidence_document'))).toBe(false);
  });

  it('empty-string role is denied', () => {
    const role = '' as MembershipRole;
    expect(can(human(role), 'evidence_document:read', resource('evidence_document'))).toBe(false);
  });

  it('unrecognized principal kind does not bypass the human-only manage_members gate', () => {
    const principal: Principal = {
      kind: 'service_account' as PrincipalKind,
      subjectId: 'svc-1',
      workspaceId: WS_A,
      role: 'owner',
    };
    expect(can(principal, 'workspace:manage_members', resource('workspace'))).toBe(false);
  });
});

describe('can — edge / boundary: human vs. agent-persona symmetry', () => {
  it('agent_persona owner matches human owner on evidence_document and agent_run actions', () => {
    expect(can(agent('owner'), 'evidence_document:write', resource('evidence_document'))).toBe(
      true,
    );
    expect(can(agent('owner'), 'agent_run:trigger', resource('agent_run'))).toBe(true);
  });

  it('agent_persona owner is denied manage_members even though a human owner is allowed', () => {
    expect(can(human('owner'), 'workspace:manage_members', resource('workspace'))).toBe(true);
    expect(can(agent('owner'), 'workspace:manage_members', resource('workspace'))).toBe(false);
  });

  it('agent_persona editor/commenter/viewer match their human counterparts on every non-manage_members action', () => {
    const roles: MembershipRole[] = ['editor', 'commenter', 'viewer'];
    const actions: Array<[Action, Resource['type']]> = [
      ['evidence_document:read', 'evidence_document'],
      ['evidence_document:write', 'evidence_document'],
      ['agent_run:read', 'agent_run'],
      ['agent_run:trigger', 'agent_run'],
    ];
    for (const role of roles) {
      for (const [action, type] of actions) {
        expect(can(agent(role), action, resource(type))).toBe(
          can(human(role), action, resource(type)),
        );
      }
    }
  });
});

describe('can — multi-tenant isolation (hard gate)', () => {
  it('denies across workspaces even when the actor would otherwise be a fully-privileged owner', () => {
    expect(
      can(human('owner', WS_A), 'evidence_document:read', resource('evidence_document', WS_B)),
    ).toBe(false);
  });

  it('denies across workspaces even combined with the one asymmetric action', () => {
    expect(can(human('owner', WS_A), 'workspace:manage_members', resource('workspace', WS_B))).toBe(
      false,
    );
  });

  it('workspaceId comparison is case-sensitive — differing case is treated as a different tenant', () => {
    expect(
      can(
        human('owner', 'abc-123'),
        'evidence_document:read',
        resource('evidence_document', 'ABC-123'),
      ),
    ).toBe(false);
  });

  it('workspaceId comparison is whitespace-sensitive — trailing whitespace is a different tenant', () => {
    expect(
      can(
        human('owner', 'abc-123'),
        'evidence_document:read',
        resource('evidence_document', 'abc-123 '),
      ),
    ).toBe(false);
  });

  it('two empty-string workspaceIds do NOT pass the tenant gate — empty is never a valid tenant', () => {
    expect(
      can(human('owner', ''), 'evidence_document:read', resource('evidence_document', '')),
    ).toBe(false);
  });

  it('empty workspaceId on only one side is a mismatch, not a wildcard', () => {
    expect(
      can(human('owner', ''), 'evidence_document:read', resource('evidence_document', 'real-uuid')),
    ).toBe(false);
  });

  it('resource/action type mismatch combined with a tenant mismatch still denies', () => {
    expect(can(human('owner', WS_A), 'evidence_document:read', resource('agent_run', WS_B))).toBe(
      false,
    );
  });
});

describe('can — never throws', () => {
  const roles: MembershipRole[] = ['owner', 'editor', 'commenter', 'viewer'];
  const kinds: PrincipalKind[] = ['human', 'agent_persona'];
  const actionsByType: Array<[Action, Resource['type']]> = [
    ['evidence_document:read', 'evidence_document'],
    ['evidence_document:write', 'evidence_document'],
    ['agent_run:trigger', 'agent_run'],
    ['agent_run:read', 'agent_run'],
    ['workspace:manage_members', 'workspace'],
  ];

  it('never throws for any well-typed Principal/Resource/Action combination, same or cross workspace', () => {
    for (const kind of kinds) {
      for (const role of roles) {
        for (const [action, type] of actionsByType) {
          const principal: Principal = { kind, subjectId: 's', workspaceId: WS_A, role };
          expect(() => can(principal, action, resource(type, WS_A))).not.toThrow();
          expect(() => can(principal, action, resource(type, WS_B))).not.toThrow();
        }
      }
    }
  });

  it('never throws for adversarial cast-through values either', () => {
    const badPrincipal: Principal = {
      kind: 'nonsense' as PrincipalKind,
      subjectId: 's',
      workspaceId: WS_A,
      role: 'nonsense' as MembershipRole,
    };
    const badAction = 'nonsense:nonsense' as Action;
    const badResource = { type: 'nonsense' as Resource['type'], workspaceId: WS_A };
    expect(() => can(badPrincipal, badAction, badResource)).not.toThrow();
  });

  it('does not mutate its principal or resource arguments', () => {
    const principal = Object.freeze(human('owner'));
    const res = Object.freeze(resource('evidence_document'));
    const principalCopy = { ...principal };
    const resourceCopy = { ...res };
    expect(() => can(principal, 'evidence_document:read', res)).not.toThrow();
    expect(principal).toEqual(principalCopy);
    expect(res).toEqual(resourceCopy);
  });
});

describe('can — provenance: the role × action table', () => {
  const MATRIX: Array<{
    role: MembershipRole;
    read: boolean;
    write: boolean;
    trigger: boolean;
    runRead: boolean;
    manageMembers: boolean;
  }> = [
    { role: 'owner', read: true, write: true, trigger: true, runRead: true, manageMembers: true },
    { role: 'editor', read: true, write: true, trigger: true, runRead: true, manageMembers: false },
    {
      role: 'commenter',
      read: true,
      write: false,
      trigger: false,
      runRead: true,
      manageMembers: false,
    },
    {
      role: 'viewer',
      read: true,
      write: false,
      trigger: false,
      runRead: true,
      manageMembers: false,
    },
  ];

  it.each(MATRIX)(
    'role=$role matches the design table exactly across all 5 actions',
    ({ role, read, write, trigger, runRead, manageMembers }) => {
      expect(can(human(role), 'evidence_document:read', resource('evidence_document'))).toBe(read);
      expect(can(human(role), 'evidence_document:write', resource('evidence_document'))).toBe(
        write,
      );
      expect(can(human(role), 'agent_run:trigger', resource('agent_run'))).toBe(trigger);
      expect(can(human(role), 'agent_run:read', resource('agent_run'))).toBe(runRead);
      expect(can(human(role), 'workspace:manage_members', resource('workspace'))).toBe(
        manageMembers,
      );
    },
  );

  it('commenter and viewer have exactly identical allow-sets', () => {
    const actions: Array<[Action, Resource['type']]> = [
      ['evidence_document:read', 'evidence_document'],
      ['evidence_document:write', 'evidence_document'],
      ['agent_run:trigger', 'agent_run'],
      ['agent_run:read', 'agent_run'],
      ['workspace:manage_members', 'workspace'],
    ];
    for (const [action, type] of actions) {
      expect(can(human('commenter'), action, resource(type))).toBe(
        can(human('viewer'), action, resource(type)),
      );
    }
  });

  it('only owner (and only as human) can manage_members', () => {
    expect(can(human('owner'), 'workspace:manage_members', resource('workspace'))).toBe(true);
    expect(can(human('editor'), 'workspace:manage_members', resource('workspace'))).toBe(false);
    expect(can(human('commenter'), 'workspace:manage_members', resource('workspace'))).toBe(false);
    expect(can(human('viewer'), 'workspace:manage_members', resource('workspace'))).toBe(false);
    expect(can(agent('owner'), 'workspace:manage_members', resource('workspace'))).toBe(false);
  });
});
