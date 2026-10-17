/**
 * Workspace isolation in the ticket server actions: a member of one workspace
 * is refused before any ticket data is touched in another, and every ticket
 * query carries the workspace filter even though RLS would also apply.
 * The database-level guarantees are in src/lib/tickets/ticket-isolation.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ME = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const T2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

type Op = [string, ...unknown[]];
interface Query {
  table: string;
  ops: Op[];
}

const fake = vi.hoisted(() => ({
  queries: [] as { table: string; ops: [string, ...unknown[]][] }[],
  rpcs: [] as { fn: string; args: unknown }[],
  respond: (() => ({ data: null, error: null })) as (q: {
    table: string;
    ops: [string, ...unknown[]][];
  }) => { data: unknown; error: unknown; count?: number },
}));

function builder(table: string) {
  const q: Query = { table, ops: [] };
  fake.queries.push(q);
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve(fake.respond(q));
        }
        return (...args: unknown[]) => {
          q.ops.push([prop, ...args]);
          return proxy;
        };
      },
    }
  );
  return proxy;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: ME } } }) },
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: unknown) => {
      fake.rpcs.push({ fn, args });
      return { data: [], error: null };
    },
  }),
}));
vi.mock('@/lib/email/smtp', () => ({ isValidEmail: () => true, sendSmtpEmail: vi.fn() }));

import * as actions from '@/app/actions/tickets';

const has = (q: Query, ...op: unknown[]) => q.ops.some((o) => JSON.stringify(o) === JSON.stringify(op));

/** The caller is an agent of workspace A; workspace B belongs to someone else. */
function membershipOfA(q: Query) {
  if (q.table === 'agents' && has(q, 'eq', 'id', ME)) {
    return { data: { id: ME, name: 'Me', role: 'agent', workspace_id: WS_A, is_super_admin: false }, error: null };
  }
  if (q.table === 'workspaces' && has(q, 'eq', 'id', WS_A)) return { data: { id: WS_A, owner_id: 'someone' }, error: null };
  if (q.table === 'workspaces' && has(q, 'eq', 'id', WS_B)) return { data: { id: WS_B, owner_id: 'other' }, error: null };
  return null;
}

beforeEach(() => {
  fake.queries = [];
  fake.rpcs = [];
  fake.respond = (q) => membershipOfA(q) ?? { data: [], error: null, count: 0 };
});

const touchedTicketData = () =>
  fake.queries.some((q) => ['tickets', 'messages', 'ticket_events', 'ticket_views', 'ticket_groups', 'visitors', 'conversations'].includes(q.table)) ||
  fake.rpcs.length > 0;

describe('ticket actions refuse another workspace before touching its data', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['getTicketsBootstrapAction', () => actions.getTicketsBootstrapAction(WS_B)],
    ['getViewCountsAction', () => actions.getViewCountsAction(WS_B)],
    ['listTicketsAction', () => actions.listTicketsAction(WS_B, { viewId: 'system:all_open' })],
    ['getTicketAction', () => actions.getTicketAction(WS_B, T1)],
    ['updateTicketAction', () => actions.updateTicketAction(WS_B, T1, { status: 'solved' })],
    ['replyToTicketAction', () => actions.replyToTicketAction(WS_B, T1, { body: 'hi', internal: false })],
    ['sendTicketTemplateAction', () => actions.sendTicketTemplateAction(WS_B, T1, { name: 'order_update', language: 'en_US', body: 'Hi', params: [] })],
    ['retryTicketMessageAction', () => actions.retryTicketMessageAction(WS_B, T1)],
    ['bulkUpdateTicketsAction', () => actions.bulkUpdateTicketsAction(WS_B, [T1], { status: 'solved' })],
    ['mergeTicketsAction', () => actions.mergeTicketsAction(WS_B, T1, [T2])],
    ['searchTicketsAction', () => actions.searchTicketsAction(WS_B, 'refund')],
    ['saveTicketViewAction', () => actions.saveTicketViewAction(WS_B, { name: 'x', filters: {}, sort: {}, shared: false })],
    ['deleteTicketViewAction', () => actions.deleteTicketViewAction(WS_B, T1)],
    ['setTicketPresenceAction', () => actions.setTicketPresenceAction(WS_B, T1, 'viewing')],
    [
      'createTicketAction',
      () =>
        actions.createTicketAction(WS_B, {
          requesterName: 'x',
          requesterEmail: 'x@example.com',
          subject: 's',
          body: 'b',
          channel: 'email',
        }),
    ],
  ];

  it('covers every exported action', () => {
    const exported = Object.entries(actions)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(calls.map(([name]) => name).sort()).toEqual(exported);
  });

  it.each(calls)('%s', async (_name, call) => {
    await expect(call()).rejects.toThrow(/Forbidden/);
    expect(touchedTicketData()).toBe(false);
  });

  it('refuses a malformed workspace id outright', async () => {
    await expect(actions.listTicketsAction("x' OR 1=1", {})).rejects.toThrow(/Unknown workspace/);
    expect(fake.queries).toHaveLength(0);
  });
});

describe('ticket queries are scoped to the caller’s workspace', () => {
  it('lists and counts only within the workspace', async () => {
    await actions.getTicketsBootstrapAction(WS_A);
    const ticketQueries = fake.queries.filter((q) => q.table === 'tickets');
    expect(ticketQueries.length).toBeGreaterThanOrEqual(5);
    for (const q of ticketQueries) expect(has(q, 'eq', 'workspace_id', WS_A)).toBe(true);
  });

  it('bulk updates only the tickets the workspace-scoped lookup returned', async () => {
    const respond = fake.respond;
    fake.respond = (q) => {
      if (q.table === 'tickets' && q.ops.some((o) => o[0] === 'select')) {
        // Only T1 is in workspace A; T2 is not returned.
        return { data: [{ id: T1, number: 1001, status: 'open', tags: [] }], error: null };
      }
      return respond(q);
    };
    const result = await actions.bulkUpdateTicketsAction(WS_A, [T1, T2], { status: 'pending' });
    expect(result.updated).toBe(1);
    expect(result.skipped).toEqual([{ id: T2, reason: 'not found' }]);
    const updates = fake.queries.filter((q) => q.table === 'tickets' && q.ops.some((o) => o[0] === 'update'));
    expect(updates).toHaveLength(1);
    expect(has(updates[0], 'eq', 'id', T1)).toBe(true);
    expect(has(updates[0], 'eq', 'workspace_id', WS_A)).toBe(true);
  });

  it('refuses to assign a ticket to an agent from another workspace', async () => {
    const respond = fake.respond;
    fake.respond = (q) => (q.table === 'agents' && has(q, 'eq', 'id', T2) ? { data: null, error: null } : respond(q));
    await expect(actions.updateTicketAction(WS_A, T1, { assignee_id: T2 })).rejects.toThrow(/not in this workspace/);
    expect(fake.queries.some((q) => q.table === 'tickets' && q.ops.some((o) => o[0] === 'update'))).toBe(false);
  });

  it('searches through the workspace-checked database function', async () => {
    await actions.searchTicketsAction(WS_A, '#1001');
    expect(fake.rpcs).toEqual([{ fn: 'fn_search_tickets', args: { p_workspace_id: WS_A, p_query: '#1001', p_limit: 50 } }]);
  });
});
