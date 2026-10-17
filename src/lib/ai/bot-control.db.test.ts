/**
 * Who answers a conversation, decided by the database (migration
 * 20261031090000): a person's reply takes over from any writer, only a person
 * switches the bot back on, and fn_deliver_ai_reply refuses a bot reply that
 * was written before control changed. These are the checks the auto-responder
 * relies on; the route only reads their verdict.
 *
 * Every test runs in one transaction, where now() never moves, so messages
 * are written with clock_timestamp() to keep their order.
 *
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import {
  createWorkspace,
  hasDatabase,
  startChat,
  visitorSays,
  widgetToken,
  useTestDatabase,
  type Actor,
  type Db,
  type WorkspaceFixture,
} from '@/test/db';

describe.skipIf(!hasDatabase)('bot control and reply delivery (database)', () => {
  const { db } = useTestDatabase();

  interface Chat {
    ws: WorkspaceFixture;
    conversationId: string;
  }

  async function chat(first = 'Hi, my parcel is late'): Promise<Chat> {
    const ws = await createWorkspace(db(), 'Acme');
    const { conversationId } = await startChat(db(), ws, first);
    return { ws, conversationId };
  }

  async function say(
    d: Db,
    actor: Actor,
    conversationId: string,
    sender: 'visitor' | 'agent',
    content: string,
    opts: { senderId?: string | null; internal?: boolean; metadata?: Record<string, unknown> } = {}
  ): Promise<string> {
    const [row] = await d.as<{ id: string }>(
      actor,
      `INSERT INTO messages (conversation_id, sender_type, sender_id, content, is_internal, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp()) RETURNING id`,
      [conversationId, sender, opts.senderId ?? null, content, opts.internal ?? false, opts.metadata ?? null]
    );
    return row.id;
  }

  const visitor = (c: Chat, text: string) => visitorSays(db(), c.conversationId, text);
  const agent = (c: Chat, text: string, internal = false) =>
    say(db(), { kind: 'user', id: c.ws.agentId }, c.conversationId, 'agent', text, { senderId: c.ws.agentId, internal });

  async function lastVisitorMessage(c: Chat): Promise<string> {
    const row = await db().one<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = $1 AND sender_type = 'visitor' ORDER BY created_at DESC LIMIT 1`,
      [c.conversationId]
    );
    return row.id;
  }

  async function control(c: Chat) {
    return db().one<{
      ai_mode: string;
      ai_paused_reason: string | null;
      ai_control_version: string;
      ai_resumed_at: string | null;
    }>(`SELECT ai_mode, ai_paused_reason, ai_control_version, ai_resumed_at FROM conversations WHERE id = $1`, [
      c.conversationId,
    ]);
  }

  const version = async (c: Chat) => Number((await control(c)).ai_control_version);

  async function deliver(c: Chat, visitorMessageId: string, expectedVersion: number | null, content = 'Here is the answer.') {
    const [row] = await db().as<{ result: { delivered: boolean; reason?: string; message?: { id: string } } }>(
      { kind: 'service' },
      `SELECT fn_deliver_ai_reply($1, $2, $3, $4, $5) AS result`,
      [c.conversationId, visitorMessageId, expectedVersion, content, { answered_message_id: visitorMessageId }]
    );
    return row.result;
  }

  async function botReplies(c: Chat): Promise<number> {
    const row = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'ai' AND NOT is_internal`,
      [c.conversationId]
    );
    return Number(row.n);
  }

  describe('a person taking over', () => {
    it('a public reply from a person switches the bot off and moves the version', async () => {
      const c = await chat();
      const before = await version(c);
      await agent(c, "I've forwarded your issue to our technical team. I'll update you once I hear back.");
      const after = await control(c);
      expect(after).toMatchObject({ ai_mode: 'disabled', ai_paused_reason: 'human_reply' });
      expect(Number(after.ai_control_version)).toBeGreaterThan(before);
    });

    it('an internal note does not take the conversation over', async () => {
      const c = await chat();
      await agent(c, 'Checking the courier portal', true);
      expect(await control(c)).toMatchObject({ ai_mode: 'autopilot', ai_paused_reason: null });
    });

    it("the widget's welcome line (no sender) does not take it over", async () => {
      // The greeting goes on an empty conversation, before the visitor's first line.
      const ws = await createWorkspace(db(), 'Acme');
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      const [{ conv }] = await db().as<{ conv: { id: string } }>({ kind: 'anon' }, 'SELECT fn_widget_start_conversation($1, $2, true) AS conv', [
        ws.visitorId,
        token,
      ]);
      const [{ m }] = await db().as<{ m: { id: string } | null }>({ kind: 'anon' }, 'SELECT fn_widget_welcome($1, $2, $3, $4) AS m', [
        ws.visitorId,
        token,
        conv.id,
        'Welcome to Acme',
      ]);
      expect(m).not.toBeNull();
      await visitorSays(db(), conv.id, 'Hi');
      expect((await control({ ws, conversationId: conv.id })).ai_mode).toBe('autopilot');
    });
  });

  describe('delivering a bot reply', () => {
    it('delivers when nothing changed, and records it', async () => {
      const c = await chat();
      const msg = await lastVisitorMessage(c);
      const result = await deliver(c, msg, await version(c));
      expect(result.delivered).toBe(true);
      expect(await botReplies(c)).toBe(1);
      const events = await db().q<{ event: string }>(`SELECT event FROM ai_reply_events WHERE conversation_id = $1`, [c.conversationId]);
      expect(events.map((e) => e.event)).toContain('reply_delivered');
    });

    it('refuses a reply written while a person answered (human takes over mid-generation)', async () => {
      const c = await chat();
      const msg = await lastVisitorMessage(c);
      const startedAt = await version(c);
      await agent(c, 'Let me check that for you.');
      const result = await deliver(c, msg, startedAt);
      expect(result).toMatchObject({ delivered: false, reason: 'ai_human_reply' });
      expect(await botReplies(c)).toBe(0);
      const [event] = await db().q<{ reason: string }>(
        `SELECT reason FROM ai_reply_events WHERE conversation_id = $1 AND event = 'reply_suppressed'`,
        [c.conversationId]
      );
      expect(event.reason).toBe('ai_human_reply');
    });

    it('refuses a reply written while an agent switched the bot off', async () => {
      const c = await chat();
      const msg = await lastVisitorMessage(c);
      const startedAt = await version(c);
      await db().as({ kind: 'user', id: c.ws.agentId }, `UPDATE conversations SET ai_mode = 'disabled' WHERE id = $1`, [c.conversationId]);
      expect((await control(c)).ai_paused_reason).toBe('agent_paused');
      const result = await deliver(c, msg, startedAt);
      expect(result).toMatchObject({ delivered: false, reason: 'ai_agent_paused' });
    });

    it('refuses a reply when the switch went off and on again during generation', async () => {
      const c = await chat();
      const msg = await lastVisitorMessage(c);
      const startedAt = await version(c);
      const as: Actor = { kind: 'user', id: c.ws.agentId };
      await db().as(as, `UPDATE conversations SET ai_mode = 'disabled' WHERE id = $1`, [c.conversationId]);
      await db().as(as, `UPDATE conversations SET ai_mode = 'autopilot' WHERE id = $1`, [c.conversationId]);
      expect(await deliver(c, msg, startedAt)).toMatchObject({ delivered: false, reason: 'control_changed' });
    });

    it('a retry of a delivered reply is refused, not sent twice', async () => {
      const c = await chat();
      const msg = await lastVisitorMessage(c);
      const v = await version(c);
      expect((await deliver(c, msg, v)).delivered).toBe(true);
      expect(await deliver(c, msg, v)).toMatchObject({ delivered: false, reason: 'already_answered' });
      expect(await botReplies(c)).toBe(1);
    });

    it('a reply to an older message is dropped when the visitor wrote again', async () => {
      const c = await chat('Hi');
      const first = await lastVisitorMessage(c);
      await visitor(c, 'how do I reset my password?');
      const second = await lastVisitorMessage(c);
      const v = await version(c);
      expect(await deliver(c, first, v)).toMatchObject({ delivered: false, reason: 'superseded' });
      expect((await deliver(c, second, v)).delivered).toBe(true);
    });

    it('refuses a reply once the conversation is closed', async () => {
      const c = await chat();
      const msg = await lastVisitorMessage(c);
      const v = await version(c);
      await db().q(`UPDATE conversations SET status = 'closed' WHERE id = $1`, [c.conversationId]);
      expect(await deliver(c, msg, await version(c))).toMatchObject({ delivered: false, reason: 'conversation_closed' });
      expect(v).toBeGreaterThanOrEqual(0);
    });

    it('refuses a message id from another conversation', async () => {
      const c = await chat();
      const other = await chat('Another chat');
      const foreign = await lastVisitorMessage(other);
      expect(await deliver(c, foreign, await version(c))).toMatchObject({
        delivered: false,
        reason: 'visitor_message_not_found',
      });
    });

    it('only the service role may call it', async () => {
      const c = await chat();
      const msg = await lastVisitorMessage(c);
      for (const actor of [{ kind: 'anon' }, { kind: 'user', id: c.ws.agentId }] as Actor[]) {
        const err = await db().rejects(actor, `SELECT fn_deliver_ai_reply($1, $2, 0, 'x', '{}')`, [c.conversationId, msg]);
        expect(err).toMatch(/permission denied/);
      }
    });
  });

  describe('turning the bot back on', () => {
    it('clears the reason, records the resume and sends nothing by itself', async () => {
      const c = await chat();
      await agent(c, "I'll update you once the technical team replies.");
      const paused = await version(c);
      await db().as({ kind: 'user', id: c.ws.agentId }, `UPDATE conversations SET ai_mode = 'autopilot' WHERE id = $1`, [
        c.conversationId,
      ]);
      const after = await control(c);
      expect(after).toMatchObject({ ai_mode: 'autopilot', ai_paused_reason: null });
      expect(after.ai_resumed_at).not.toBeNull();
      expect(Number(after.ai_control_version)).toBeGreaterThan(paused);
      expect(await botReplies(c)).toBe(0);
    });

    it("answers the customer's next message after it was turned back on", async () => {
      const c = await chat();
      await agent(c, "I'll update you once the technical team replies.");
      await db().as({ kind: 'user', id: c.ws.agentId }, `UPDATE conversations SET ai_mode = 'autopilot' WHERE id = $1`, [
        c.conversationId,
      ]);
      await visitor(c, 'Any update?');
      const msg = await lastVisitorMessage(c);
      expect((await deliver(c, msg, await version(c))).delivered).toBe(true);
    });

    it('a resolved conversation that reopens gives the bot its turn back', async () => {
      const c = await chat();
      await agent(c, 'All sorted, closing this.');
      await db().q(`UPDATE conversations SET status = 'closed' WHERE id = $1`, [c.conversationId]);
      await visitor(c, 'One more question');
      expect(await control(c)).toMatchObject({ ai_mode: 'autopilot', ai_paused_reason: null });
    });
  });

  describe('who may flip the switch', () => {
    it('the widget (anon) cannot switch the bot back on', async () => {
      const c = await chat();
      await agent(c, 'Taking this one.');
      await db().attempt({ kind: 'anon' }, `UPDATE conversations SET ai_mode = 'autopilot', ai_paused_reason = NULL WHERE id = $1`, [
        c.conversationId,
      ]);
      expect(await control(c)).toMatchObject({ ai_mode: 'disabled', ai_paused_reason: 'human_reply' });
    });

    it('the widget cannot bump the version to void a reply either', async () => {
      const c = await chat();
      const before = await version(c);
      await db().attempt({ kind: 'anon' }, `UPDATE conversations SET ai_control_version = ai_control_version + 5 WHERE id = $1`, [
        c.conversationId,
      ]);
      expect(await version(c)).toBe(before);
    });
  });

  describe('bot decisions are private to the workspace', () => {
    it("another workspace's agents cannot read them, and the widget cannot read or write them", async () => {
      const c = await chat();
      const outsider = await createWorkspace(db(), 'Elsewhere');
      const msg = await lastVisitorMessage(c);
      await deliver(c, msg, await version(c));

      const own = await db().as({ kind: 'user', id: c.ws.agentId }, `SELECT id FROM ai_reply_events WHERE conversation_id = $1`, [
        c.conversationId,
      ]);
      expect(own.length).toBeGreaterThan(0);
      const theirs = await db().as({ kind: 'user', id: outsider.agentId }, `SELECT id FROM ai_reply_events WHERE conversation_id = $1`, [
        c.conversationId,
      ]);
      expect(theirs).toHaveLength(0);
      // No anon policy: the widget sees nothing (production also revokes the grant).
      expect(await db().attempt({ kind: 'anon' }, `SELECT id FROM ai_reply_events`)).toHaveLength(0);
      await db().rejects(
        { kind: 'user', id: c.ws.agentId },
        `INSERT INTO ai_reply_events (workspace_id, conversation_id, event) VALUES ($1, $2, 'reply_delivered')`,
        [c.ws.id, c.conversationId]
      );
    });
  });
});
