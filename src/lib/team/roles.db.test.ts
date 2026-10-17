/**
 * What each role may do, enforced by the database itself (row level security,
 * guard triggers and the team functions), so the old inbox writing straight
 * from the browser is held to the same rules as the ticket screens.
 *
 *   owner, admin   everything, including the team, groups and settings
 *   agent          tickets, replies, notes and workspace content
 *   light agent    read, and add internal notes. Nothing else.
 *   deactivated    nothing at all
 *
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, ROLES, roleCan } from '@/lib/team/permissions';
import {
  addMember,
  agentSays,
  createWorkspace,
  hasDatabase,
  startChat,
  ticket,
  useTestDatabase,
  type Actor,
  type WorkspaceFixture,
} from '@/test/db';

type Who = 'owner' | 'admin' | 'agent' | 'light' | 'deactivated' | 'outsider';
const EVERYONE: Who[] = ['owner', 'admin', 'agent', 'light', 'deactivated', 'outsider'];

describe.skipIf(!hasDatabase)('roles and permissions (database)', () => {
  const { db } = useTestDatabase();

  interface Team extends WorkspaceFixture {
    lightId: string;
    deactivatedId: string;
    outsiderId: string;
    other: WorkspaceFixture;
    conversationId: string;
    ticketId: string;
  }

  async function team(): Promise<Team> {
    const ws = await createWorkspace(db(), 'Acme');
    const other = await createWorkspace(db(), 'Elsewhere');
    const lightId = await addMember(db(), ws.id, 'light_agent', { name: 'Lee Light' });
    const deactivatedId = await addMember(db(), ws.id, 'agent', { name: 'Dee Gone', active: false });
    const chat = await startChat(db(), ws, 'My order never arrived');
    return {
      ...ws,
      lightId,
      deactivatedId,
      outsiderId: other.agentId,
      other,
      conversationId: chat.conversationId,
      ticketId: chat.ticket.id,
    };
  }

  const id = (t: Team, who: Who) =>
    ({
      owner: t.ownerId,
      admin: t.adminId,
      agent: t.agentId,
      light: t.lightId,
      deactivated: t.deactivatedId,
      outsider: t.outsiderId,
    })[who];
  const as = (t: Team, who: Who): Actor => ({ kind: 'user', id: id(t, who) });

  /** Runs `sql` as `who`; true when it changed or returned at least one row. */
  async function allowed(t: Team, who: Who, sql: string, params: unknown[] = []): Promise<boolean> {
    await db().client.query('SAVEPOINT attempt');
    try {
      const rows = await db().as(as(t, who), sql, params);
      await db().client.query('RELEASE SAVEPOINT attempt');
      return rows.length > 0;
    } catch {
      await db().client.query('ROLLBACK TO SAVEPOINT attempt');
      await db().client.query('RESET ROLE');
      return false;
    }
  }

  async function matrix(t: Team, sql: (who: Who) => [string, unknown[]]) {
    const out: Partial<Record<Who, boolean>> = {};
    for (const who of EVERYONE) {
      const [text, params] = sql(who);
      out[who] = await allowed(t, who, text, params);
    }
    return out;
  }

  /** Like `matrix`, but each role acts on its own fresh conversation, so one role's change cannot hide another's. */
  async function matrixOnFreshChats(t: Team, sql: (chat: { conversationId: string; ticketId: string }) => [string, unknown[]]) {
    const out: Partial<Record<Who, boolean>> = {};
    for (const who of EVERYONE) {
      const chat = await startChat(db(), t, `Question from the ${who} round`);
      const [text, params] = sql({ conversationId: chat.conversationId, ticketId: chat.ticket.id });
      out[who] = await allowed(t, who, text, params);
    }
    return out;
  }

  const only = (...yes: Who[]) => Object.fromEntries(EVERYONE.map((w) => [w, yes.includes(w)]));

  describe('the capability matrix', () => {
    it('the database and the app agree on every role and capability', async () => {
      for (const role of ROLES) {
        for (const capability of CAPABILITIES) {
          const { has } = await db().one<{ has: boolean }>('SELECT public.fn_role_has($1, $2) AS has', [role, capability]);
          expect(has, `${role} ${capability}`).toBe(roleCan(role, capability));
        }
      }
    });

    it('fn_workspace_role names the caller’s role, and nothing for the deactivated or outsiders', async () => {
      const t = await team();
      const roles: Record<string, string | null> = {};
      for (const who of EVERYONE) {
        const [row] = await db().as<{ role: string | null }>(as(t, who), 'SELECT public.fn_workspace_role($1) AS role', [t.id]);
        roles[who] = row.role;
      }
      expect(roles).toEqual({
        owner: 'owner',
        admin: 'admin',
        agent: 'agent',
        light: 'light_agent',
        deactivated: null,
        outsider: null,
      });
    });
  });

  describe('reading', () => {
    it('every active member reads tickets, conversations and messages; deactivated agents and outsiders read nothing', async () => {
      const t = await team();
      for (const sql of [
        'SELECT id FROM tickets WHERE workspace_id = $1',
        'SELECT id FROM conversations WHERE workspace_id = $1',
        'SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.workspace_id = $1',
        'SELECT id FROM visitors WHERE workspace_id = $1',
        'SELECT id FROM ticket_events WHERE workspace_id = $1',
      ]) {
        expect(await matrix(t, () => [sql, [t.id]]), sql).toEqual(only('owner', 'admin', 'agent', 'light'));
      }
    });

    it('a deactivated agent can still read their own profile (to be told they are deactivated)', async () => {
      const t = await team();
      const rows = await db().as(as(t, 'deactivated'), 'SELECT is_active FROM agents WHERE id = $1', [t.deactivatedId]);
      expect(rows).toEqual([{ is_active: false }]);
    });
  });

  describe('conversation messages', () => {
    const insert = (t: Team, who: Who, internal: boolean): [string, unknown[]] => [
      `INSERT INTO messages (conversation_id, sender_type, sender_id, content, is_internal)
       VALUES ($1, 'agent', $2, 'hello', $3) RETURNING id`,
      [t.conversationId, id(t, who), internal],
    ];

    it('internal notes: every active member, including light agents', async () => {
      const t = await team();
      expect(await matrix(t, (who) => insert(t, who, true))).toEqual(only('owner', 'admin', 'agent', 'light'));
    });

    it('public replies: owners, admins and agents, never light agents', async () => {
      const t = await team();
      expect(await matrix(t, (who) => insert(t, who, false))).toEqual(only('owner', 'admin', 'agent'));
      const msg = await db().rejects(as(t, 'light'), insert(t, 'light', false)[0], insert(t, 'light', false)[1]);
      expect(msg).toMatch(/light agents can only add internal notes/);
    });

    it('nobody posts as somebody else', async () => {
      const t = await team();
      const msg = await db().rejects(
        as(t, 'light'),
        `INSERT INTO messages (conversation_id, sender_type, sender_id, content, is_internal) VALUES ($1, 'agent', $2, 'x', false)`,
        [t.conversationId, t.agentId]
      );
      expect(msg).toMatch(/sent as yourself/);
    });

    it('light agents cannot edit or delete messages, but can mark them read', async () => {
      const t = await team();
      const [m] = await db().q<{ id: string }>(
        `SELECT id FROM messages WHERE conversation_id = $1 AND sender_type = 'visitor'`,
        [t.conversationId]
      );
      expect(await db().rejects(as(t, 'light'), `UPDATE messages SET content = 'edited' WHERE id = $1`, [m.id])).toMatch(
        /cannot edit messages/
      );
      expect(await db().rejects(as(t, 'light'), `DELETE FROM messages WHERE id = $1`, [m.id])).toMatch(/cannot delete/);
      expect(await allowed(t, 'light', `UPDATE messages SET read_at = now() WHERE id = $1 RETURNING id`, [m.id])).toBe(true);
      expect(await allowed(t, 'agent', `UPDATE messages SET content = 'edited' WHERE id = $1 RETURNING id`, [m.id])).toBe(true);
    });
  });

  describe('tickets', () => {
    it('status, priority, tags and assignment: owners, admins and agents only', async () => {
      const t = await team();
      for (const set of [`status = 'pending'`, `priority = 'high'`, `tags = '{vip}'`, `assignee_id = '${t.agentId}'`]) {
        const result = await matrixOnFreshChats(t, (c) => [`UPDATE tickets SET ${set} WHERE id = $1 RETURNING id`, [c.ticketId]]);
        expect(result, set).toEqual(only('owner', 'admin', 'agent'));
      }
    });

    it('a light agent’s note still updates the ticket’s activity, through the triggers', async () => {
      const t = await team();
      const before = await ticket(db(), t.ticketId);
      await agentSays(db(), t.conversationId, t.lightId, 'Customer is on the enterprise plan', true);
      const after = await ticket(db(), t.ticketId);
      expect(after.status).toBe(before.status);
      const [{ n }] = await db().q<{ n: string }>(
        `SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND is_internal AND sender_id = $2`,
        [t.conversationId, t.lightId]
      );
      expect(Number(n)).toBe(1);
    });

    it('merging tickets needs edit rights', async () => {
      const t = await team();
      const second = await startChat(db(), t, 'Also: where is my refund?');
      expect(
        await db().rejects(as(t, 'light'), 'SELECT public.fn_merge_tickets($1, $2)', [t.ticketId, [second.ticket.id]])
      ).toMatch(/Forbidden/);
      expect((await ticket(db(), second.ticket.id)).merged_into_id).toBeNull();
      await db().as(as(t, 'agent'), 'SELECT public.fn_merge_tickets($1, $2)', [t.ticketId, [second.ticket.id]]);
      expect((await ticket(db(), second.ticket.id)).merged_into_id).toBe(t.ticketId);
    });

    it('search works for every active member, refuses the deactivated', async () => {
      const t = await team();
      expect(await matrix(t, () => [`SELECT * FROM public.fn_search_tickets($1, 'order')`, [t.id]])).toEqual(
        only('owner', 'admin', 'agent', 'light')
      );
    });
  });

  describe('conversations (the old inbox writes these directly)', () => {
    it('status, assignment and priority: not light agents', async () => {
      const t = await team();
      for (const set of [`status = 'closed'`, `assigned_agent_id = '${t.agentId}'`, `priority = 'high'`, `tags = '{x}'`]) {
        const result = await matrixOnFreshChats(t, (c) => [
          `UPDATE conversations SET ${set} WHERE id = $1 RETURNING id`,
          [c.conversationId],
        ]);
        expect(result, set).toEqual(only('owner', 'admin', 'agent'));
      }
    });

    it('a light agent may bump updated_at (what writing a note does) but not open a conversation', async () => {
      const t = await team();
      expect(
        await allowed(t, 'light', `UPDATE conversations SET updated_at = now() WHERE id = $1 RETURNING id`, [t.conversationId])
      ).toBe(true);
      expect(
        await matrix(t, () => [
          `INSERT INTO conversations (visitor_id, workspace_id, status, channel) VALUES ($1, $2, 'open', 'web') RETURNING id`,
          [t.visitorId, t.id],
        ])
      ).toEqual(only('owner', 'admin', 'agent'));
    });
  });

  describe('workspace content', () => {
    it('visitors and canned responses: not light agents', async () => {
      const t = await team();
      expect(
        await matrix(t, () => [`UPDATE visitors SET name = 'Renamed' WHERE id = $1 RETURNING id`, [t.visitorId]])
      ).toEqual(only('owner', 'admin', 'agent'));
      expect(
        await matrix(t, (who) => [
          `INSERT INTO canned_responses (workspace_id, shortcut, content) VALUES ($1, $2, 'Hi!') RETURNING id`,
          [t.id, `/hi-${who}`],
        ])
      ).toEqual(only('owner', 'admin', 'agent'));
    });
  });

  describe('groups and views', () => {
    it('creating, renaming and deleting groups: owners and admins', async () => {
      const t = await team();
      expect(
        await matrix(t, (who) => [`INSERT INTO ticket_groups (workspace_id, name) VALUES ($1, $2) RETURNING id`, [t.id, `G ${who}`]])
      ).toEqual(only('owner', 'admin'));
    });

    it('setting a group’s members: owners and admins', async () => {
      const t = await team();
      const [g] = await db().q<{ id: string }>(`INSERT INTO ticket_groups (workspace_id, name) VALUES ($1, 'Billing') RETURNING id`, [t.id]);
      const result = await matrix(t, () => [`SELECT public.fn_set_group_members($1, $2) IS NULL AS ok`, [g.id, [t.agentId]]]);
      expect(result).toEqual(only('owner', 'admin'));
      expect(
        await matrix(t, () => [
          `INSERT INTO ticket_group_members (group_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING agent_id`,
          [g.id, t.adminId],
        ])
      ).toEqual(only('owner'));
    });

    it('a group cannot take a member from another workspace', async () => {
      const t = await team();
      const [g] = await db().q<{ id: string }>(`INSERT INTO ticket_groups (workspace_id, name) VALUES ($1, 'Billing') RETURNING id`, [t.id]);
      expect(await db().rejects(as(t, 'owner'), 'SELECT public.fn_set_group_members($1, $2)', [g.id, [t.outsiderId]])).toMatch(
        /must be in this workspace/
      );
      expect(
        await db().rejects(as(t, 'owner'), 'INSERT INTO ticket_group_members (group_id, agent_id) VALUES ($1, $2)', [g.id, t.outsiderId])
      ).toMatch(/not in this workspace/);
    });

    it('personal views for every active member; shared views for owners and admins', async () => {
      const t = await team();
      expect(
        await matrix(t, (who) => [
          `INSERT INTO ticket_views (workspace_id, name, owner_id) VALUES ($1, 'Mine', $2) RETURNING id`,
          [t.id, id(t, who)],
        ])
      ).toEqual(only('owner', 'admin', 'agent', 'light'));
      expect(
        await matrix(t, () => [`INSERT INTO ticket_views (workspace_id, name, owner_id) VALUES ($1, 'Shared', NULL) RETURNING id`, [t.id]])
      ).toEqual(only('owner', 'admin'));
    });
  });

  describe('managing the team', () => {
    const roleOf = async (agentId: string) => (await db().one<{ role: string }>('SELECT role FROM agents WHERE id = $1', [agentId])).role;

    it('changing an agent’s role: owners and admins', async () => {
      const t = await team();
      const target = await addMember(db(), t.id, 'agent');
      const result = await matrix(t, () => [`SELECT public.fn_set_member_role($1, $2, 'light_agent') IS NULL AS ok`, [t.id, target]]);
      expect(result).toEqual(only('owner', 'admin'));
      expect(await roleOf(target)).toBe('light_agent');
    });

    it('only the owner makes admins or manages them', async () => {
      const t = await team();
      const target = await addMember(db(), t.id, 'agent');
      expect(await db().rejects(as(t, 'admin'), `SELECT public.fn_set_member_role($1, $2, 'admin')`, [t.id, target])).toMatch(
        /Only the owner/
      );
      const otherAdmin = await addMember(db(), t.id, 'admin');
      expect(await db().rejects(as(t, 'admin'), `SELECT public.fn_set_member_role($1, $2, 'agent')`, [t.id, otherAdmin])).toMatch(
        /Only the owner can manage admins/
      );
      expect(await db().rejects(as(t, 'admin'), `SELECT public.fn_deactivate_member($1, $2, 'unassign')`, [t.id, otherAdmin])).toMatch(
        /Only the owner can manage admins/
      );
      await db().as(as(t, 'owner'), `SELECT public.fn_set_member_role($1, $2, 'admin')`, [t.id, target]);
      expect(await roleOf(target)).toBe('admin');
    });

    it('nobody changes their own role, deactivates themselves, or touches the owner', async () => {
      const t = await team();
      expect(await db().rejects(as(t, 'admin'), `SELECT public.fn_set_member_role($1, $2, 'agent')`, [t.id, t.adminId])).toMatch(
        /your own role/
      );
      expect(await db().rejects(as(t, 'admin'), `SELECT public.fn_deactivate_member($1, $2, 'unassign')`, [t.id, t.adminId])).toMatch(
        /deactivate yourself/
      );
      expect(await db().rejects(as(t, 'admin'), `SELECT public.fn_set_member_role($1, $2, 'agent')`, [t.id, t.ownerId])).toMatch(
        /owner/
      );
      expect(await db().rejects(as(t, 'owner'), `SELECT public.fn_set_member_role($1, $2, 'owner')`, [t.id, t.agentId])).toMatch(
        /Choose admin, agent or light agent/
      );
    });

    it('nobody grants themselves a role, capacity or reactivation by writing their own row', async () => {
      const t = await team();
      for (const [who, set] of [
        ['agent', `role = 'admin'`],
        ['light', `role = 'agent'`],
        ['agent', `max_open_tickets = 999`],
        ['deactivated', `is_active = true`],
        ['deactivated', `deactivated_at = NULL`],
        ['admin', `role = 'owner'`],
      ] as [Who, string][]) {
        expect(await db().rejects(as(t, who), `UPDATE agents SET ${set} WHERE id = $1`, [id(t, who)]), `${who} ${set}`).toMatch(
          /Forbidden/
        );
      }
      // Profile and availability stay theirs to change.
      expect(await allowed(t, 'light', `UPDATE agents SET status = 'away', name = 'Lee' WHERE id = $1 RETURNING id`, [t.lightId])).toBe(
        true
      );
    });

    it('an admin cannot change another agent’s row directly, only through the team functions', async () => {
      const t = await team();
      expect(await allowed(t, 'admin', `UPDATE agents SET role = 'light_agent' WHERE id = $1 RETURNING id`, [t.agentId])).toBe(false);
      expect(await allowed(t, 'admin', `UPDATE agents SET is_active = false WHERE id = $1 RETURNING id`, [t.agentId])).toBe(false);
      expect(await roleOf(t.agentId)).toBe('agent');
    });

    it('the owner role cannot be handed to anyone but the owner', async () => {
      const t = await team();
      const newcomer = crypto.randomUUID();
      await db().q('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [newcomer, `${newcomer}@example.test`]);
      expect(
        await db().rejects(
          { kind: 'user', id: newcomer },
          `INSERT INTO agents (id, name, email, role, workspace_id) VALUES ($1, 'x', 'x@example.test', 'owner', $2)`,
          [newcomer, t.id]
        )
      ).toMatch(/Forbidden/);
    });

    it('capacity: owners and admins set it for anyone', async () => {
      const t = await team();
      expect(
        await matrix(t, () => [`SELECT public.fn_set_member_capacity($1, $2, 5) IS NULL AS ok`, [t.id, t.agentId]])
      ).toEqual(only('owner', 'admin'));
      const { max_open_tickets } = await db().one<{ max_open_tickets: number }>('SELECT max_open_tickets FROM agents WHERE id = $1', [
        t.agentId,
      ]);
      expect(max_open_tickets).toBe(5);
    });

    it('deactivating: owners and admins; the agent loses all access at once', async () => {
      const t = await team();
      const targets: Partial<Record<Who, string>> = {};
      for (const who of EVERYONE) targets[who] = await addMember(db(), t.id, 'light_agent');
      const result = await matrix(t, (who) => [`SELECT public.fn_deactivate_member($1, $2, 'unassign') AS moved`, [t.id, targets[who]]]);
      expect(result).toEqual(only('owner', 'admin'));
      const { rows } = await db().client.query('SELECT id, is_active, deactivated_at FROM agents WHERE id = ANY($1)', [
        Object.values(targets),
      ]);
      const inactive = rows.filter((r) => !r.is_active && r.deactivated_at).map((r) => r.id).sort();
      expect(inactive).toEqual([targets.owner, targets.admin].sort());

      await db().as(as(t, 'admin'), `SELECT public.fn_deactivate_member($1, $2, 'unassign')`, [t.id, t.lightId]);
      expect(await allowed(t, 'light', 'SELECT id FROM tickets WHERE workspace_id = $1', [t.id])).toBe(false);
      expect(await allowed(t, 'light', 'SELECT id FROM conversations WHERE workspace_id = $1', [t.id])).toBe(false);
    });

    it('reactivating restores access', async () => {
      const t = await team();
      await db().as(as(t, 'admin'), 'SELECT public.fn_reactivate_member($1, $2)', [t.id, t.deactivatedId]);
      expect(await allowed(t, 'deactivated', 'SELECT id FROM tickets WHERE workspace_id = $1', [t.id])).toBe(true);
    });

    it('team functions refuse another workspace’s members', async () => {
      const t = await team();
      expect(
        await db().rejects(as(t, 'owner'), `SELECT public.fn_set_member_role($1, $2, 'agent')`, [t.id, t.other.agentId])
      ).toMatch(/not in this workspace/);
      expect(
        await db().rejects(as(t, 'owner'), `SELECT public.fn_set_member_role($1, $2, 'agent')`, [t.other.id, t.other.agentId])
      ).toMatch(/Forbidden/);
    });
  });

  describe('presence (collision detection)', () => {
    const upsert = (t: Team, who: Who, state: string): [string, unknown[]] => [
      `INSERT INTO ticket_presence (ticket_id, agent_id, state) VALUES ($1, $2, $3)
       ON CONFLICT (ticket_id, agent_id) DO UPDATE SET state = EXCLUDED.state RETURNING agent_id`,
      [t.ticketId, id(t, who), state],
    ];

    it('every active member can say they are viewing or writing a note', async () => {
      const t = await team();
      expect(await matrix(t, (who) => upsert(t, who, 'viewing'))).toEqual(only('owner', 'admin', 'agent', 'light'));
      expect(await matrix(t, (who) => upsert(t, who, 'noting'))).toEqual(only('owner', 'admin', 'agent', 'light'));
    });

    it('only those who may reply can say they are replying', async () => {
      const t = await team();
      expect(await matrix(t, (who) => upsert(t, who, 'replying'))).toEqual(only('owner', 'admin', 'agent'));
    });

    it('nobody can appear as someone else, and outsiders see nobody', async () => {
      const t = await team();
      expect(
        await allowed(t, 'agent', `INSERT INTO ticket_presence (ticket_id, agent_id) VALUES ($1, $2) RETURNING agent_id`, [
          t.ticketId,
          t.adminId,
        ])
      ).toBe(false);
      await db().as(as(t, 'admin'), upsert(t, 'admin', 'replying')[0], upsert(t, 'admin', 'replying')[1]);
      expect(await db().as(as(t, 'agent'), 'SELECT agent_id, state FROM ticket_presence WHERE ticket_id = $1', [t.ticketId])).toEqual([
        { agent_id: t.adminId, state: 'replying' },
      ]);
      expect(await allowed(t, 'outsider', 'SELECT 1 FROM ticket_presence WHERE ticket_id = $1', [t.ticketId])).toBe(false);
    });
  });
});
