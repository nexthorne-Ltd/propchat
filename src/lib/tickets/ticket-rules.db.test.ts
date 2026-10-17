/**
 * Ticket status rules, numbering, follow-ups, merging and the audit log,
 * enforced by the database itself (supabase/migrations/20261009110000_ticketing.sql).
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import {
  agentSays,
  createWorkspace,
  hasDatabase,
  startChat,
  ticket,
  ticketOf,
  useTestDatabase,
  visitorSays,
  widgetToken,
} from '@/test/db';

describe.skipIf(!hasDatabase)('ticket rules (database)', () => {
  const { db } = useTestDatabase();

  describe('creating tickets', () => {
    it('turns a new widget chat into ticket #1001: new, channel chat, requester = visitor, subject = first line', async () => {
      const ws = await createWorkspace(db());
      const { conversationId, ticket: t } = await startChat(db(), ws, 'My parcel is late\nOrdered last week');
      expect(t).toMatchObject({
        number: 1001,
        status: 'new',
        channel: 'chat',
        requester_id: ws.visitorId,
        conversation_id: conversationId,
        subject: 'My parcel is late',
        assignee_id: null,
      });
      const msgs = await db().q('SELECT ticket_id FROM messages WHERE conversation_id = $1', [conversationId]);
      expect(msgs.every((m) => m.ticket_id === t.id)).toBe(true);
    });

    it('numbers tickets sequentially per workspace', async () => {
      const a = await createWorkspace(db());
      const b = await createWorkspace(db());
      const a1 = await startChat(db(), a, 'one');
      const a2 = await startChat(db(), a, 'two');
      const b1 = await startChat(db(), b, 'three');
      const a3 = await startChat(db(), a, 'four');
      expect([a1.ticket.number, a2.ticket.number, a3.ticket.number]).toEqual([1001, 1002, 1003]);
      expect(b1.ticket.number).toBe(1001);
    });

    it('records who created it: the customer, for a widget chat', async () => {
      const ws = await createWorkspace(db());
      const { ticket: t } = await startChat(db(), ws, 'hello');
      const [created] = await db().q(`SELECT * FROM ticket_events WHERE ticket_id = $1 AND action = 'created'`, [t.id]);
      expect(created).toMatchObject({ actor_type: 'customer', actor_id: ws.visitorId, new_value: 'new' });
    });

    it('starts open when auto-assignment gives the chat an agent', async () => {
      const ws = await createWorkspace(db());
      await db().q(`UPDATE workspaces SET auto_assignment = '{"enabled": true}' WHERE id = $1`, [ws.id]);
      await db().q(`UPDATE agents SET status = 'online' WHERE id = $1`, [ws.agentId]);
      const { ticket: t } = await startChat(db(), ws, 'hi there');
      expect(t.assignee_id).not.toBeNull();
      expect(t.status).toBe('open');
    });
  });

  describe('new → open', () => {
    it('opens when an agent replies publicly, and assigns the replier', async () => {
      const ws = await createWorkspace(db());
      const { conversationId, ticket: t } = await startChat(db(), ws, 'Where is my order?');
      await agentSays(db(), conversationId, ws.agentId, 'Let me check.');
      expect(await ticket(db(), t.id)).toMatchObject({ status: 'open', assignee_id: ws.agentId });
      const [change] = await db().q(
        `SELECT actor_type, actor_id FROM ticket_events WHERE ticket_id = $1 AND action = 'updated' AND field = 'status'`,
        [t.id]
      );
      expect(change).toMatchObject({ actor_type: 'agent', actor_id: ws.agentId });
    });

    it('does not open for an internal note or a bot reply', async () => {
      const ws = await createWorkspace(db());
      const { conversationId, ticket: t } = await startChat(db(), ws, 'Question');
      await agentSays(db(), conversationId, ws.agentId, 'Looking into it', true);
      await db().as({ kind: 'service' }, `INSERT INTO messages (conversation_id, sender_type, content) VALUES ($1, 'ai', 'Bot answer')`, [
        conversationId,
      ]);
      expect((await ticket(db(), t.id)).status).toBe('new');
    });

    it('opens when the ticket is assigned', async () => {
      const ws = await createWorkspace(db());
      const { ticket: t } = await startChat(db(), ws, 'Question');
      await db().as({ kind: 'user', id: ws.adminId }, 'UPDATE tickets SET assignee_id = $1 WHERE id = $2', [ws.agentId, t.id]);
      expect(await ticket(db(), t.id)).toMatchObject({ status: 'open', assignee_id: ws.agentId });
    });

    it('cannot be moved back to new', async () => {
      const ws = await createWorkspace(db());
      const { ticket: t } = await startChat(db(), ws, 'Question');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'open' WHERE id = $1`, [t.id]);
      const err = await db().rejects({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'new' WHERE id = $1`, [t.id]);
      expect(err).toMatch(/cannot go back to New/);
    });
  });

  describe('customer replies', () => {
    it.each(['pending', 'solved'])('reopen a %s ticket', async (status) => {
      const ws = await createWorkspace(db());
      const { conversationId, ticket: t } = await startChat(db(), ws, 'Question');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = $1 WHERE id = $2`, [status, t.id]);
      await visitorSays(db(), conversationId, 'Any update?');
      const after = await ticket(db(), t.id);
      expect(after.status).toBe('open');
      expect(after.solved_at).toBeNull();
      const [change] = await db().q(
        `SELECT actor_type, old_value, new_value FROM ticket_events
          WHERE ticket_id = $1 AND field = 'status' ORDER BY id DESC LIMIT 1`,
        [t.id]
      );
      expect(change).toMatchObject({ actor_type: 'customer', old_value: status, new_value: 'open' });
    });

    it('leave an on-hold ticket on hold', async () => {
      const ws = await createWorkspace(db());
      const { conversationId, ticket: t } = await startChat(db(), ws, 'Question');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'on_hold' WHERE id = $1`, [t.id]);
      await visitorSays(db(), conversationId, 'Hello?');
      expect((await ticket(db(), t.id)).status).toBe('on_hold');
    });
  });

  describe('solved → closed', () => {
    it('closes tickets solved more than 4 days ago, and only those', async () => {
      const ws = await createWorkspace(db());
      const old = await startChat(db(), ws, 'old');
      const recent = await startChat(db(), ws, 'recent');
      for (const t of [old.ticket, recent.ticket]) {
        await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'solved' WHERE id = $1`, [t.id]);
      }
      await db().q(`UPDATE tickets SET solved_at = now() - interval '4 days 1 minute' WHERE id = $1`, [old.ticket.id]);
      await db().q(`UPDATE tickets SET solved_at = now() - interval '3 days' WHERE id = $1`, [recent.ticket.id]);

      const [{ fn_close_solved_tickets: closed }] = await db().as<{ fn_close_solved_tickets: number }>(
        { kind: 'service' },
        'SELECT fn_close_solved_tickets()'
      );
      expect(closed).toBe(1);
      expect((await ticket(db(), old.ticket.id)).status).toBe('closed');
      expect((await ticket(db(), recent.ticket.id)).status).toBe('solved');
      const [event] = await db().q(
        `SELECT actor_type FROM ticket_events WHERE ticket_id = $1 AND new_value = 'closed'`,
        [old.ticket.id]
      );
      expect(event.actor_type).toBe('system');
    });

    it('cannot be triggered by agents or the widget', async () => {
      expect(await db().rejects({ kind: 'anon' }, 'SELECT fn_close_solved_tickets()')).toMatch(/permission denied/);
      const ws = await createWorkspace(db());
      expect(await db().rejects({ kind: 'user', id: ws.agentId }, 'SELECT fn_close_solved_tickets()')).toMatch(/permission denied/);
    });
  });

  describe('closed tickets', () => {
    async function closedTicket() {
      const ws = await createWorkspace(db());
      const chat = await startChat(db(), ws, 'Refund please');
      await agentSays(db(), chat.conversationId, ws.agentId, 'Refunded.');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'closed' WHERE id = $1`, [chat.ticket.id]);
      return { ws, ...chat };
    }

    it('are read-only', async () => {
      const { ws, ticket: t } = await closedTicket();
      for (const sql of [
        `UPDATE tickets SET priority = 'high' WHERE id = $1`,
        `UPDATE tickets SET status = 'open' WHERE id = $1`,
        `UPDATE messages SET content = 'edited' WHERE ticket_id = $1`,
        `DELETE FROM messages WHERE ticket_id = $1`,
      ]) {
        expect(await db().rejects({ kind: 'user', id: ws.adminId }, sql, [t.id])).toMatch(/closed/);
      }
      // Even the service role cannot edit the record.
      expect(await db().rejects({ kind: 'service' }, `UPDATE tickets SET subject = 'x' WHERE id = $1`, [t.id])).toMatch(/closed/);
    });

    it('still accept read receipts on their messages', async () => {
      const { ws, conversationId, ticket: t } = await closedTicket();
      // The visitor's widget reading the team's reply.
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      await db().as({ kind: 'anon' }, 'SELECT fn_widget_mark($1, $2, $3, true)', [ws.visitorId, token, conversationId]);
      // And the agent reading the customer's message.
      await db().as({ kind: 'user', id: ws.agentId }, `SELECT fn_mark_messages_read($1, 'agent')`, [conversationId]);
      const rows = await db().q('SELECT read_at FROM messages WHERE ticket_id = $1', [t.id]);
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((r) => r.read_at !== null)).toBe(true);
    });

    it('send a new customer message to a follow-up ticket linked to the old one', async () => {
      const { ws, conversationId, ticket: closed } = await closedTicket();
      const before = await db().q('SELECT id, content FROM messages WHERE ticket_id = $1 ORDER BY created_at', [closed.id]);

      await visitorSays(db(), conversationId, 'The refund never arrived');
      const followUp = await ticketOf(db(), conversationId);

      expect(followUp.id).not.toBe(closed.id);
      expect(followUp).toMatchObject({
        follow_up_of_id: closed.id,
        status: 'new',
        number: closed.number + 1,
        subject: closed.subject,
        requester_id: ws.visitorId,
        conversation_id: conversationId,
      });
      const [msg] = await db().q(`SELECT ticket_id FROM messages WHERE content = 'The refund never arrived'`);
      expect(msg.ticket_id).toBe(followUp.id);
      // The closed ticket's thread is exactly what it was.
      expect(await db().q('SELECT id, content FROM messages WHERE ticket_id = $1 ORDER BY created_at', [closed.id])).toEqual(before);
      const [event] = await db().q(`SELECT * FROM ticket_events WHERE ticket_id = $1 AND action = 'follow_up_created'`, [
        followUp.id,
      ]);
      expect(event).toMatchObject({ actor_type: 'customer', new_value: `#${closed.number}` });
    });

    it('send later messages to the same follow-up rather than starting another', async () => {
      const { ws, conversationId } = await closedTicket();
      await visitorSays(db(), conversationId, 'Hello again');
      const followUp = await ticketOf(db(), conversationId);
      await visitorSays(db(), conversationId, 'Anyone there?');
      await agentSays(db(), conversationId, ws.agentId, 'Yes, checking now');
      expect((await ticketOf(db(), conversationId)).id).toBe(followUp.id);
      const [{ count }] = await db().q(`SELECT count(*)::int AS count FROM tickets WHERE follow_up_of_id IS NOT NULL`);
      expect(count).toBe(1);
      expect((await ticket(db(), followUp.id)).status).toBe('open');
    });

    it('keep the chat working: the widget conversation id never changes', async () => {
      const { conversationId } = await closedTicket();
      await visitorSays(db(), conversationId, 'Still there?');
      const [{ count }] = await db().q('SELECT count(*)::int AS count FROM conversations');
      expect(count).toBe(1);
      const [conv] = await db().q('SELECT status FROM conversations WHERE id = $1', [conversationId]);
      expect(conv.status).toBe('open');
    });
  });

  describe('live chat compatibility (conversation ↔ ticket)', () => {
    it('resolving in the old inbox solves the ticket, and reopening reopens it', async () => {
      const ws = await createWorkspace(db());
      const { conversationId, ticket: t } = await startChat(db(), ws, 'Question');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE conversations SET status = 'closed' WHERE id = $1`, [conversationId]);
      expect((await ticket(db(), t.id)).status).toBe('solved');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE conversations SET status = 'open' WHERE id = $1`, [conversationId]);
      expect((await ticket(db(), t.id)).status).toBe('open');
    });

    it('ticket status, priority, assignee and tags flow back to the conversation', async () => {
      const ws = await createWorkspace(db());
      const { conversationId, ticket: t } = await startChat(db(), ws, 'Question');
      await db().as(
        { kind: 'user', id: ws.agentId },
        `UPDATE tickets SET status = 'pending', priority = 'urgent', assignee_id = $1, tags = '{vip}' WHERE id = $2`,
        [ws.adminId, t.id]
      );
      const [conv] = await db().q('SELECT status, priority, assigned_agent_id, tags FROM conversations WHERE id = $1', [conversationId]);
      expect(conv).toEqual({ status: 'pending', priority: 'urgent', assigned_agent_id: ws.adminId, tags: ['vip'] });
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'solved' WHERE id = $1`, [t.id]);
      const [solved] = await db().q('SELECT status, last_resolved_at FROM conversations WHERE id = $1', [conversationId]);
      expect(solved.status).toBe('closed');
      expect(solved.last_resolved_at).not.toBeNull();
    });

    it('a bot handover (conversation priority/assignee) updates the ticket', async () => {
      const ws = await createWorkspace(db());
      const { conversationId, ticket: t } = await startChat(db(), ws, 'Talk to a human');
      await db().as({ kind: 'service' }, `UPDATE conversations SET priority = 'high', assigned_agent_id = $1 WHERE id = $2`, [
        ws.agentId,
        conversationId,
      ]);
      expect(await ticket(db(), t.id)).toMatchObject({ priority: 'high', assignee_id: ws.agentId, status: 'open' });
    });
  });

  describe('merging', () => {
    it('moves the thread, closes the source, and routes its later messages to the target', async () => {
      const ws = await createWorkspace(db());
      const target = await startChat(db(), ws, 'Payment failed');
      const source = await startChat(db(), ws, 'Payment failed again');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET tags = '{billing}' WHERE id = $1`, [source.ticket.id]);

      await db().as({ kind: 'user', id: ws.agentId }, 'SELECT fn_merge_tickets($1, ARRAY[$2]::uuid[])', [
        target.ticket.id,
        source.ticket.id,
      ]);

      expect(await ticket(db(), source.ticket.id)).toMatchObject({ status: 'closed', merged_into_id: target.ticket.id });
      expect((await ticket(db(), target.ticket.id)).tags).toContain('billing');
      const [moved] = await db().q(`SELECT ticket_id FROM messages WHERE content = 'Payment failed again'`);
      expect(moved.ticket_id).toBe(target.ticket.id);

      await visitorSays(db(), source.conversationId, 'Is it fixed?');
      const [later] = await db().q(`SELECT ticket_id FROM messages WHERE content = 'Is it fixed?'`);
      expect(later.ticket_id).toBe(target.ticket.id);
      const [{ count }] = await db().q('SELECT count(*)::int AS count FROM tickets WHERE follow_up_of_id IS NOT NULL');
      expect(count).toBe(0);

      const [merged] = await db().q(`SELECT actor_type, actor_id FROM ticket_events WHERE ticket_id = $1 AND action = 'merged'`, [
        source.ticket.id,
      ]);
      expect(merged).toMatchObject({ actor_type: 'agent', actor_id: ws.agentId });
    });

    it('refuses closed tickets', async () => {
      const ws = await createWorkspace(db());
      const a = await startChat(db(), ws, 'a');
      const b = await startChat(db(), ws, 'b');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'closed' WHERE id = $1`, [b.ticket.id]);
      expect(
        await db().rejects({ kind: 'user', id: ws.agentId }, 'SELECT fn_merge_tickets($1, ARRAY[$2]::uuid[])', [a.ticket.id, b.ticket.id])
      ).toMatch(/closed/);
    });
  });

  describe('audit log', () => {
    it('records every field change with who, what and when', async () => {
      const ws = await createWorkspace(db());
      const { conversationId, ticket: t } = await startChat(db(), ws, 'Question');
      await db().as(
        { kind: 'user', id: ws.adminId },
        `UPDATE tickets SET priority = 'high', type = 'incident', subject = 'Checkout broken', tags = '{bug,checkout}' WHERE id = $1`,
        [t.id]
      );
      await agentSays(db(), conversationId, ws.agentId, 'Escalating to engineering', true);

      const events = await db().q(
        `SELECT actor_type, actor_id, action, field, old_value, new_value, created_at FROM ticket_events WHERE ticket_id = $1 ORDER BY id`,
        [t.id]
      );
      const byField = Object.fromEntries(events.filter((e) => e.field).map((e) => [e.field, e]));
      expect(byField.priority).toMatchObject({ actor_id: ws.adminId, old_value: 'normal', new_value: 'high' });
      expect(byField.type).toMatchObject({ actor_id: ws.adminId, old_value: 'question', new_value: 'incident' });
      expect(byField.subject).toMatchObject({ old_value: 'Question', new_value: 'Checkout broken' });
      expect(byField.tags).toMatchObject({ old_value: '', new_value: 'bug, checkout' });
      expect(events.find((e) => e.action === 'internal_note')).toMatchObject({ actor_id: ws.agentId, new_value: 'Escalating to engineering' });
      expect(events.every((e) => e.created_at instanceof Date)).toBe(true);
    });
  });

  describe('backfill', () => {
    it('gives conversations from before ticketing a ticket, status, subject and thread', async () => {
      const ws = await createWorkspace(db());
      // Pre-ticketing rows: visitor and conversation inserted without a
      // workspace so no ticket is made (auto-assignment would copy the
      // visitor's), then given one, as the migration finds them in production.
      const [{ id: other }] = await db().q<{ id: string }>(`INSERT INTO visitors (name) VALUES ('Legacy visitor') RETURNING id`);
      const [conv] = await db().q<{ id: string }>(
        `INSERT INTO conversations (visitor_id, status, created_at) VALUES ($1, 'open', now() - interval '20 days') RETURNING id`,
        [other]
      );
      await db().q(`INSERT INTO messages (conversation_id, sender_type, content) VALUES ($1, 'visitor', 'Old question')`, [conv.id]);
      await db().q(
        `UPDATE conversations SET workspace_id = $1, status = 'closed', closed_at = now() - interval '10 days' WHERE id = $2`,
        [ws.id, conv.id]
      );
      await db().q('UPDATE visitors SET workspace_id = $1 WHERE id = $2', [ws.id, other]);

      await db().q('SELECT fn_backfill_tickets()');
      const t = await ticketOf(db(), conv.id);
      expect(t).toMatchObject({ status: 'closed', subject: 'Old question', requester_id: other, number: 1001 });
      const [msg] = await db().q('SELECT ticket_id FROM messages WHERE conversation_id = $1', [conv.id]);
      expect(msg.ticket_id).toBe(t.id);
    });
  });
});
