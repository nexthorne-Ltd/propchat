/**
 * What each role may call in the server actions. The caller's role is decided
 * from their agent row and the workspace's owner; refused calls must stop
 * before any ticket, message or settings data is read or written.
 * The database enforces the same matrix (src/lib/team/roles.db.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ME = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const T1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const T2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type Query = { table: string; ops: [string, ...unknown[]][] };
const fake = vi.hoisted(() => ({
  me: { role: 'agent', workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', is_active: true, is_super_admin: false } as {
    role: string;
    workspace_id: string | null;
    is_active: boolean;
    is_super_admin: boolean;
  },
  isOwner: false,
  queries: [] as { table: string; ops: [string, ...unknown[]][] }[],
  rpcs: [] as { fn: string; args: unknown }[],
}));

const has = (q: Query, ...op: unknown[]) => q.ops.some((o) => JSON.stringify(o) === JSON.stringify(op));

function respond(q: Query) {
  if (q.table === 'agents' && has(q, 'eq', 'id', ME)) {
    return { data: { id: ME, name: 'Me', ...fake.me }, error: null };
  }
  if (q.table === 'workspaces') {
    const id = q.ops.find((o) => o[0] === 'eq' && o[1] === 'id')?.[2];
    return { data: { id, owner_id: fake.isOwner && id === WS ? ME : OWNER }, error: null };
  }
  return { data: [], error: null, count: 0 };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: ME } } }) },
    from: (table: string) => {
      const q: Query = { table, ops: [] };
      fake.queries.push(q);
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(respond(q));
            return (...args: unknown[]) => {
              q.ops.push([prop, ...args]);
              return proxy;
            };
          },
        }
      );
      return proxy;
    },
    rpc: async (fn: string, args: unknown) => {
      fake.rpcs.push({ fn, args });
      return { data: 0, error: null };
    },
  }),
}));
vi.mock('@/lib/supabase/service', () => ({ hasServiceRole: () => false, serviceClient: () => ({}) }));
vi.mock('@/lib/email/smtp', () => ({ isValidEmail: () => true, sendSmtpEmail: vi.fn() }));
vi.mock('next/server', () => ({ after: vi.fn(), NextResponse: { json: vi.fn() } }));

import * as tickets from '@/app/actions/tickets';
import * as team from '@/app/actions/team';
import * as knowledge from '@/app/actions/knowledge';
import { assignableRoles, canManageMember, roleCan, ROLES, CAPABILITIES } from '@/lib/team/permissions';
import { resolveWorkspaceRole } from '@/lib/team/access';

type Who = 'owner' | 'admin' | 'agent' | 'light_agent' | 'deactivated' | 'outsider';
const WHO: Who[] = ['owner', 'admin', 'agent', 'light_agent', 'deactivated', 'outsider'];

function become(who: Who) {
  fake.isOwner = who === 'owner';
  fake.me = {
    role: who === 'owner' ? 'owner' : who === 'deactivated' ? 'agent' : who === 'outsider' ? 'agent' : who,
    workspace_id: who === 'outsider' ? OTHER_WS : WS,
    is_active: who !== 'deactivated',
    is_super_admin: false,
  };
}

beforeEach(() => {
  fake.queries = [];
  fake.rpcs = [];
  become('agent');
});

/** Everyone in `allowed` gets past the guard; everyone else is refused with Forbidden before any data access. */
async function check(call: () => Promise<unknown>, allowed: Who[]) {
  for (const who of WHO) {
    become(who);
    fake.queries = [];
    fake.rpcs = [];
    const result = await call().then(
      () => 'ok',
      (e: Error) => e.message
    );
    if (allowed.includes(who)) {
      expect(result, `${who} should be allowed`).not.toMatch(/Forbidden|Unauthorized/);
    } else {
      expect(result, `${who} should be refused`).toMatch(/Forbidden/);
      const touched = fake.queries.filter((q) => !['agents', 'workspaces'].includes(q.table));
      expect(touched, `${who} touched data`).toEqual([]);
      expect(fake.rpcs, `${who} called the database`).toEqual([]);
    }
  }
}

const ALL: Who[] = ['owner', 'admin', 'agent', 'light_agent'];
const WORKERS: Who[] = ['owner', 'admin', 'agent'];
const ADMINS: Who[] = ['owner', 'admin'];

describe('ticket actions by role', () => {
  it('viewing: every active member', async () => {
    await check(() => tickets.getTicketsBootstrapAction(WS), ALL);
    await check(() => tickets.listTicketsAction(WS, {}), ALL);
    await check(() => tickets.getTicketAction(WS, T1), ALL);
    await check(() => tickets.searchTicketsAction(WS, 'refund'), ALL);
    await check(() => tickets.setTicketPresenceAction(WS, T1, 'viewing'), ALL);
  });

  it('internal notes: every active member; public replies: not light agents', async () => {
    await check(() => tickets.replyToTicketAction(WS, T1, { body: 'FYI', internal: true }), ALL);
    await check(() => tickets.replyToTicketAction(WS, T1, { body: 'Hello', internal: false }), WORKERS);
  });

  it('a note cannot be used to change status by those who may not edit tickets', async () => {
    await check(() => tickets.replyToTicketAction(WS, T1, { body: 'FYI', internal: true, submitAs: 'pending' }), WORKERS);
  });

  it('changing, creating, bulk-editing and merging tickets: not light agents', async () => {
    await check(() => tickets.updateTicketAction(WS, T1, { status: 'pending' }), WORKERS);
    await check(() => tickets.bulkUpdateTicketsAction(WS, [T1], { status: 'solved' }), WORKERS);
    await check(() => tickets.mergeTicketsAction(WS, T1, [T2]), WORKERS);
    await check(
      () => tickets.createTicketAction(WS, { requesterName: 'x', requesterEmail: 'x@example.com', subject: 's', body: 'b', channel: 'email' }),
      WORKERS
    );
  });
});

describe('team and group actions by role', () => {
  it('seeing the team page data: owners and admins', async () => {
    await check(() => team.getTeamAction(WS), ADMINS);
  });

  it('managing members: owners and admins', async () => {
    await check(() => team.setMemberRoleAction(WS, T1, 'agent'), ADMINS);
    await check(() => team.setMemberCapacityAction(WS, T1, 5), ADMINS);
    await check(() => team.deactivateMemberAction(WS, T1, { mode: 'unassign' }), ADMINS);
    await check(() => team.reactivateMemberAction(WS, T1), ADMINS);
    await check(() => team.inviteMemberAction(WS, { name: 'N', email: 'n@example.com', role: 'agent' }), ADMINS);
  });

  it('managing groups: owners and admins', async () => {
    await check(() => team.createGroupAction(WS, { name: 'Billing' }), ADMINS);
    await check(() => team.updateGroupAction(WS, T1, { roundRobin: true }), ADMINS);
    await check(() => team.deleteGroupAction(WS, T1), ADMINS);
    await check(() => team.setGroupMembersAction(WS, T1, [T2]), ADMINS);
  });

  it('AI plan usage and knowledge reading is for everyone', async () => {
    await check(() => knowledge.getWorkspaceAiPlanAndUsageAction(WS), ALL);
    await check(() => knowledge.listKnowledgeNotesAction(WS), ALL);
    await check(() => knowledge.saveKnowledgeNoteAction(WS, { title: 't', content: 'c' } as never), WORKERS);
  });
});

describe('one workspace never grants rights in another', () => {
  it.each(ROLES)('%s of one workspace is refused in another', async (role) => {
    fake.isOwner = false;
    fake.me = { role, workspace_id: OTHER_WS, is_active: true, is_super_admin: false };
    await expect(tickets.listTicketsAction(WS, {})).rejects.toThrow(/Forbidden/);
    await expect(team.getTeamAction(WS)).rejects.toThrow(/Forbidden/);
  });

  it('a deactivated agent is told so', async () => {
    become('deactivated');
    await expect(tickets.listTicketsAction(WS, {})).rejects.toThrow(/deactivated/);
  });
});

describe('who may do what to whom (mirrors fn_assert_can_manage_member)', () => {
  const m = (id: string, role: (typeof ROLES)[number]) => ({ id, role });
  it('owners manage admins; admins only agents and light agents; nobody manages themselves or the owner', () => {
    expect(canManageMember(m('o', 'owner'), m('a', 'admin'))).toBe(true);
    expect(canManageMember(m('a', 'admin'), m('b', 'admin'))).toBe(false);
    expect(canManageMember(m('a', 'admin'), m('x', 'agent'))).toBe(true);
    expect(canManageMember(m('a', 'admin'), m('x', 'light_agent'))).toBe(true);
    expect(canManageMember(m('a', 'admin'), m('o', 'owner'))).toBe(false);
    expect(canManageMember(m('a', 'admin'), m('a', 'admin'))).toBe(false);
    expect(canManageMember(m('x', 'agent'), m('y', 'light_agent'))).toBe(false);
    expect(canManageMember(m('l', 'light_agent'), m('x', 'agent'))).toBe(false);
  });
  it('only the owner can hand out the admin role', () => {
    expect(assignableRoles('owner')).toEqual(['admin', 'agent', 'light_agent']);
    expect(assignableRoles('admin')).toEqual(['agent', 'light_agent']);
    expect(assignableRoles('agent')).toEqual([]);
    expect(assignableRoles('light_agent')).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
  });
});

describe('the capability matrix', () => {
  it('light agents can only view and add notes', () => {
    expect(CAPABILITIES.filter((c) => roleCan('light_agent', c))).toEqual(['view', 'add_note']);
  });
  it('agents work tickets and content but manage nothing', () => {
    expect(CAPABILITIES.filter((c) => roleCan('agent', c))).toEqual(['view', 'add_note', 'reply', 'edit_ticket', 'edit_content']);
  });
  it('owners and admins can do everything', () => {
    for (const role of ['owner', 'admin'] as const) expect(CAPABILITIES.every((c) => roleCan(role, c))).toBe(true);
  });
  it('no role means no capability', () => {
    expect(CAPABILITIES.some((c) => roleCan(null, c))).toBe(false);
  });
});

describe('resolveWorkspaceRole', () => {
  const ws = { id: WS, owner_id: OWNER };
  const agent = (over: object = {}) => ({ id: ME, role: 'agent', workspace_id: WS, is_active: true, ...over });
  it('the workspace owner is the owner whatever their row says', () => {
    expect(resolveWorkspaceRole(OWNER, agent({ id: OWNER, role: 'agent' }), ws, WS)).toBe('owner');
  });
  it('members get their role; deactivated and outsiders get none', () => {
    expect(resolveWorkspaceRole(ME, agent({ role: 'light_agent' }), ws, WS)).toBe('light_agent');
    expect(resolveWorkspaceRole(ME, agent({ is_active: false }), ws, WS)).toBeNull();
    expect(resolveWorkspaceRole(ME, agent({ workspace_id: OTHER_WS }), ws, WS)).toBeNull();
    expect(resolveWorkspaceRole(ME, null, ws, WS)).toBeNull();
    expect(resolveWorkspaceRole(ME, agent(), null, WS)).toBeNull();
  });
  it('an unrecognised role string grants nothing', () => {
    expect(resolveWorkspaceRole(ME, agent({ role: 'superuser' }), ws, WS)).toBeNull();
  });
});
