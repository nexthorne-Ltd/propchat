/**
 * Workspace isolation for tickets, enforced by row level security and the
 * functions' own checks. Every case is a member of workspace A reaching for
 * workspace B's data, or an anonymous caller reaching for anyone's.
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { createWorkspace, hasDatabase, startChat, useTestDatabase, type WorkspaceFixture } from '@/test/db';

describe.skipIf(!hasDatabase)('ticket workspace isolation (database)', () => {
  const { db } = useTestDatabase();

  async function twoWorkspaces() {
    const a = await createWorkspace(db(), 'Alpha');
    const b = await createWorkspace(db(), 'Bravo');
    const aChat = await startChat(db(), a, 'Alpha customer: secret invoice 4471');
    const bChat = await startChat(db(), b, 'Bravo customer: secret invoice 4471');
    await db().q(`INSERT INTO ticket_groups (workspace_id, name) VALUES ($1, 'Billing'), ($2, 'Billing')`, [a.id, b.id]);
    await db().q(`INSERT INTO ticket_views (workspace_id, name, owner_id) VALUES ($1, 'Shared B', NULL), ($1, 'Mine B', $2)`, [
      b.id,
      b.agentId,
    ]);
    return { a, b, aTicket: aChat.ticket, bTicket: bChat.ticket, aChat, bChat };
  }

  const as = (ws: WorkspaceFixture, who: 'ownerId' | 'adminId' | 'agentId' = 'agentId') => ({ kind: 'user' as const, id: ws[who] });

  it('an agent sees only their own workspace’s tickets, events, groups and views', async () => {
    const { a, b } = await twoWorkspaces();
    for (const table of ['tickets', 'ticket_events', 'ticket_groups', 'ticket_views']) {
      const rows = await db().as(as(a), `SELECT workspace_id FROM ${table}`);
      expect(rows.every((r) => r.workspace_id === a.id), table).toBe(true);
      expect((await db().as(as(b), `SELECT workspace_id FROM ${table} WHERE workspace_id = $1`, [a.id])).length, table).toBe(0);
    }
  });

  it('an agent cannot fetch another workspace’s ticket even by id', async () => {
    const { a, bTicket } = await twoWorkspaces();
    expect(await db().as(as(a, 'ownerId'), 'SELECT * FROM tickets WHERE id = $1', [bTicket.id])).toEqual([]);
    expect(await db().as(as(a, 'ownerId'), 'SELECT * FROM ticket_events WHERE ticket_id = $1', [bTicket.id])).toEqual([]);
  });

  it('an agent cannot change another workspace’s ticket', async () => {
    const { a, bTicket } = await twoWorkspaces();
    const updated = await db().as(as(a, 'ownerId'), `UPDATE tickets SET status = 'solved' WHERE id = $1 RETURNING id`, [bTicket.id]);
    expect(updated).toEqual([]);
    const [row] = await db().q('SELECT status FROM tickets WHERE id = $1', [bTicket.id]);
    expect(row.status).toBe('new');
  });

  it('an agent cannot move a ticket into another workspace', async () => {
    const { a, b, aTicket } = await twoWorkspaces();
    const err = await db().rejects(as(a, 'ownerId'), 'UPDATE tickets SET workspace_id = $1 WHERE id = $2', [b.id, aTicket.id]);
    expect(err).toMatch(/row-level security|cannot change/);
  });

  it('nobody can create, delete or forge tickets and audit events directly', async () => {
    const { a, aTicket } = await twoWorkspaces();
    expect(await db().rejects(as(a, 'ownerId'), `INSERT INTO tickets (workspace_id, subject) VALUES ($1, 'x')`, [a.id])).toMatch(
      /row-level security/
    );
    expect(
      await db().rejects(
        as(a, 'ownerId'),
        `INSERT INTO ticket_events (ticket_id, workspace_id, actor_type, action) VALUES ($1, $2, 'system', 'updated')`,
        [aTicket.id, a.id]
      )
    ).toMatch(/row-level security/);
    expect(await db().as(as(a, 'ownerId'), 'DELETE FROM tickets WHERE id = $1 RETURNING id', [aTicket.id])).toEqual([]);
    expect(
      await db().rejects(
        as(a, 'ownerId'),
        `SELECT fn_ticket_log(t, 'updated', 'status', 'open', 'solved') FROM tickets t WHERE id = $1`,
        [aTicket.id]
      )
    ).toMatch(/permission denied/);
    expect(await db().as(as(a, 'ownerId'), 'SELECT * FROM ticket_counters')).toEqual([]);
  });

  it('the anonymous role (the widget) sees no tickets at all', async () => {
    await twoWorkspaces();
    for (const table of ['tickets', 'ticket_events', 'ticket_groups', 'ticket_views', 'ticket_counters']) {
      expect(await db().as({ kind: 'anon' }, `SELECT * FROM ${table}`), table).toEqual([]);
    }
    expect(await db().rejects({ kind: 'anon' }, `SELECT * FROM fn_search_tickets(gen_random_uuid(), 'invoice')`)).toMatch(
      /permission denied/
    );
  });

  it('search never returns another workspace’s tickets, even on identical text', async () => {
    const { a, b, aTicket, bTicket } = await twoWorkspaces();
    const hits = await db().as<{ ticket_id: string }>(as(a), `SELECT * FROM fn_search_tickets($1, 'secret invoice')`, [a.id]);
    expect(hits.map((h) => h.ticket_id)).toEqual([aTicket.id]);
    expect(await db().rejects(as(a), `SELECT * FROM fn_search_tickets($1, 'secret invoice')`, [b.id])).toMatch(/Not a member/);
    // By number: both are #1001, only A's comes back.
    const byNumber = await db().as<{ ticket_id: string }>(as(a), `SELECT * FROM fn_search_tickets($1, '#1001')`, [a.id]);
    expect(byNumber.map((h) => h.ticket_id)).toEqual([aTicket.id]);
    expect(byNumber.map((h) => h.ticket_id)).not.toContain(bTicket.id);
  });

  it('merge refuses tickets from another workspace in either position', async () => {
    const { a, aTicket, bTicket } = await twoWorkspaces();
    expect(await db().rejects(as(a), 'SELECT fn_merge_tickets($1, ARRAY[$2]::uuid[])', [aTicket.id, bTicket.id])).toMatch(
      /different workspaces/
    );
    expect(await db().rejects(as(a), 'SELECT fn_merge_tickets($1, ARRAY[$2]::uuid[])', [bTicket.id, aTicket.id])).toMatch(
      /not found/
    );
    const [b1] = await db().q('SELECT status, merged_into_id FROM tickets WHERE id = $1', [bTicket.id]);
    expect(b1).toEqual({ status: 'new', merged_into_id: null });
  });

  it('a message cannot be filed on another workspace’s ticket', async () => {
    const { a, aChat, bTicket } = await twoWorkspaces();
    await db().as(
      { kind: 'user', id: a.agentId },
      `INSERT INTO messages (conversation_id, ticket_id, sender_type, sender_id, content) VALUES ($1, $2, 'agent', $3, 'sneaky')`,
      [aChat.conversationId, bTicket.id, a.agentId]
    );
    const [msg] = await db().q(`SELECT ticket_id FROM messages WHERE content = 'sneaky'`);
    expect(msg.ticket_id).toBe(aChat.ticket.id);
  });

  it('personal views stay personal; only admins create shared views', async () => {
    const { b } = await twoWorkspaces();
    const visibleToAdmin = await db().as<{ name: string }>(as(b, 'adminId'), 'SELECT name FROM ticket_views ORDER BY name');
    expect(visibleToAdmin.map((v) => v.name)).toEqual(['Shared B']);
    expect(
      await db().rejects(as(b), `INSERT INTO ticket_views (workspace_id, name, owner_id) VALUES ($1, 'Team view', NULL)`, [b.id])
    ).toMatch(/row-level security/);
    await db().as(as(b, 'adminId'), `INSERT INTO ticket_views (workspace_id, name, owner_id) VALUES ($1, 'Team view', NULL)`, [b.id]);
    expect(
      await db().rejects(as(b), `INSERT INTO ticket_views (workspace_id, name, owner_id) VALUES ($1, 'Fake mine', $2)`, [
        b.id,
        b.adminId,
      ])
    ).toMatch(/row-level security/);
  });

  it('a platform super admin can see every workspace’s tickets', async () => {
    const { a, b } = await twoWorkspaces();
    await db().q('UPDATE agents SET is_super_admin = true WHERE id = $1', [a.ownerId]);
    const rows = await db().as<{ workspace_id: string }>(as(a, 'ownerId'), 'SELECT workspace_id FROM tickets');
    expect(new Set(rows.map((r) => r.workspace_id))).toEqual(new Set([a.id, b.id]));
  });

  describe('membership cannot be self-granted (docs/AUDIT.md H-4)', () => {
    it('an agent cannot move themselves into another workspace', async () => {
      const { a, b } = await twoWorkspaces();
      expect(await db().rejects(as(a), 'UPDATE agents SET workspace_id = $1 WHERE id = $2', [b.id, a.agentId])).toMatch(
        /granted by a workspace admin/
      );
      // And so still cannot see B's tickets.
      expect(await db().as(as(a), 'SELECT * FROM tickets WHERE workspace_id = $1', [b.id])).toEqual([]);
    });

    it('a brand-new user cannot create an agent row inside someone else’s workspace', async () => {
      const { b } = await twoWorkspaces();
      const stranger = crypto.randomUUID();
      await db().q('INSERT INTO auth.users (id) VALUES ($1)', [stranger]);
      expect(
        await db().rejects(
          { kind: 'user', id: stranger },
          `INSERT INTO agents (id, name, email, role, workspace_id) VALUES ($1, 'x', 'x@x.test', 'admin', $2)`,
          [stranger, b.id]
        )
      ).toMatch(/granted by a workspace admin/);
    });

    it('an agent cannot promote themselves to admin', async () => {
      const { a } = await twoWorkspaces();
      expect(await db().rejects(as(a), `UPDATE agents SET role = 'admin' WHERE id = $1`, [a.agentId])).toMatch(
        /granted by a workspace admin/
      );
    });

    it('still allows what onboarding and profile edits do', async () => {
      const { a } = await twoWorkspaces();
      await db().as(as(a), `UPDATE agents SET name = 'New name', status = 'away' WHERE id = $1`, [a.agentId]);
      // A user creating their own workspace links themselves as owner.
      const founder = crypto.randomUUID();
      await db().q('INSERT INTO auth.users (id) VALUES ($1)', [founder]);
      await db().as(
        { kind: 'user', id: founder },
        `INSERT INTO agents (id, name, email, role, status) VALUES ($1, 'Founder', 'f@x.test', 'owner', 'online')`,
        [founder]
      );
      const [ws] = await db().as<{ id: string }>(
        { kind: 'user', id: founder },
        `INSERT INTO workspaces (name, owner_id) VALUES ('Founder Co', $1) RETURNING id`,
        [founder]
      );
      await db().as({ kind: 'user', id: founder }, 'UPDATE agents SET workspace_id = $1 WHERE id = $2', [ws.id, founder]);
      const [row] = await db().q('SELECT workspace_id, role FROM agents WHERE id = $1', [founder]);
      expect(row).toEqual({ workspace_id: ws.id, role: 'owner' });
    });
  });

  describe('the threads around tickets (docs/AUDIT.md H-2)', () => {
    it('an agent cannot read another workspace’s messages, conversations or visitors', async () => {
      const { a, b } = await twoWorkspaces();
      for (const [table, where] of [
        ['messages', `conversation_id IN (SELECT id FROM conversations WHERE workspace_id = '${b.id}')`],
        ['conversations', `workspace_id = '${b.id}'`],
        ['visitors', `workspace_id = '${b.id}'`],
      ]) {
        expect(await db().as(as(a, 'ownerId'), `SELECT * FROM ${table} WHERE ${where}`), table).toEqual([]);
      }
    });

    it('an agent cannot open a conversation (and so a ticket) in another workspace', async () => {
      const { a, b } = await twoWorkspaces();
      expect(
        await db().rejects(as(a), `INSERT INTO conversations (visitor_id, workspace_id) VALUES ($1, $2)`, [b.visitorId, b.id])
      ).toMatch(/row-level security/);
    });

    it('is_current_user_super_admin() is false for ordinary users and anon', async () => {
      const { a } = await twoWorkspaces();
      const [{ is_current_user_super_admin: forAgent }] = await db().as<{ is_current_user_super_admin: boolean }>(
        as(a, 'ownerId'),
        'SELECT is_current_user_super_admin()'
      );
      const [{ is_current_user_super_admin: forAnon }] = await db().as<{ is_current_user_super_admin: boolean }>(
        { kind: 'anon' },
        'SELECT is_current_user_super_admin()'
      );
      expect([forAgent, forAnon]).toEqual([false, false]);
    });
  });
});
