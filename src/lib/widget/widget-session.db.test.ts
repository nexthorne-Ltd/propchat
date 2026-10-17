/**
 * The widget's database access (docs/AUDIT.md H-3): every widget read and
 * write goes through fn_widget_* with the visitor's session token, and the
 * anon role on its own reaches nobody's chats once the lockdown
 * (20261107090000_widget_anon_lockdown.sql) is applied.
 *
 * Tests re-apply the lockdown (and its undo) inside their transaction, so the
 * file works whether or not the database already has it.
 *
 * Run with `npm run test:db`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createVisitor,
  createWorkspace,
  hasDatabase,
  startChat,
  ticketOf,
  useTestDatabase,
  visitorSays,
  widgetToken,
  type WorkspaceFixture,
} from '@/test/db';

const sql = (file: string) => fs.readFileSync(path.resolve('supabase', file), 'utf8');
const LOCKDOWN = sql('migrations/20261107090000_widget_anon_lockdown.sql');
const UNDO = sql('pending/20261107090000_widget_anon_lockdown_undo.sql');

const anon = { kind: 'anon' } as const;

describe.skipIf(!hasDatabase)('widget visitor sessions (database)', () => {
  const { db } = useTestDatabase();

  async function session(workspaceId: string, visitorId: string, token: string | null = null) {
    const [{ s }] = await db().as<{ s: { token: string | null; topic: string; conversation: { id: string; status: string } | null } }>(
      anon,
      'SELECT fn_widget_session($1, $2, $3) AS s',
      [workspaceId, visitorId, token]
    );
    return s;
  }

  /**
   * A team message written with the real clock: inside one test transaction
   * now() never moves, and the widget functions stamp clock_timestamp().
   */
  async function teamSays(ws: WorkspaceFixture, conversationId: string, content: string, internal = false) {
    await db().as(
      { kind: 'user', id: ws.agentId },
      `INSERT INTO messages (conversation_id, sender_type, sender_id, content, is_internal, created_at)
       VALUES ($1, 'agent', $2, $3, $4, clock_timestamp())`,
      [conversationId, ws.agentId, content, internal]
    );
  }

  async function messagesOf(ws: WorkspaceFixture, conversationId: string, visitorId = ws.visitorId) {
    const token = await widgetToken(db(), ws.id, visitorId);
    const [{ r }] = await db().as<{ r: { conversation: { status: string }; messages: Record<string, unknown>[] } }>(
      anon,
      'SELECT fn_widget_messages($1, $2, $3) AS r',
      [visitorId, token, conversationId]
    );
    return r;
  }

  describe('sessions', () => {
    it('issue a token once; afterwards only that token opens the session', async () => {
      const ws = await createWorkspace(db());
      const visitorId = crypto.randomUUID();
      const first = await session(ws.id, visitorId);
      expect(first.token).toMatch(/^[0-9a-f]{64}$/);
      expect(first.topic).toMatch(/^zv-[0-9a-f]{64}$/);
      expect(first.conversation).toBeNull();

      // The visitor row was created for the workspace.
      expect(await db().one('SELECT workspace_id FROM visitors WHERE id = $1', [visitorId])).toEqual({ workspace_id: ws.id });

      const again = await session(ws.id, visitorId, first.token);
      expect(again.token).toBeNull();
      expect(again.topic).toBe(first.topic);

      // Someone who only knows the visitor id gets nothing.
      expect(await db().rejects(anon, 'SELECT fn_widget_session($1, $2, NULL)', [ws.id, visitorId])).toMatch(/visitor_session_invalid/);
      expect(await db().rejects(anon, 'SELECT fn_widget_session($1, $2, $3)', [ws.id, visitorId, 'f'.repeat(64)])).toMatch(
        /visitor_session_invalid/
      );
    });

    it("a visitor id from another workspace cannot be used here", async () => {
      const a = await createWorkspace(db(), 'Alpha');
      const b = await createWorkspace(db(), 'Bravo');
      expect(await db().rejects(anon, 'SELECT fn_widget_session($1, $2, NULL)', [b.id, a.visitorId])).toMatch(
        /visitor_session_invalid/
      );
    });

    it('refuses session when the workspace is suspended', async () => {
      const ws = await createWorkspace(db());
      await db().q('UPDATE workspaces SET is_suspended = true WHERE id = $1', [ws.id]);
      const visitorId = crypto.randomUUID();
      expect(await db().rejects(anon, 'SELECT fn_widget_session($1, $2, NULL)', [ws.id, visitorId])).toMatch(
        /workspace_unavailable/
      );
    });

    it('refuses session when the workspace is soft-deleted', async () => {
      const ws = await createWorkspace(db());
      await db().q('UPDATE workspaces SET deleted_at = now() WHERE id = $1', [ws.id]);
      const visitorId = crypto.randomUUID();
      expect(await db().rejects(anon, 'SELECT fn_widget_session($1, $2, NULL)', [ws.id, visitorId])).toMatch(
        /workspace_unavailable/
      );
    });

    it('the token is stored only as a hash, and the table is closed to the widget and agents', async () => {
      const ws = await createWorkspace(db());
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      const row = await db().one<{ token_hash: string }>('SELECT token_hash FROM visitor_sessions WHERE visitor_id = $1', [ws.visitorId]);
      expect(row.token_hash).not.toBe(token);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      // test-db.sh grants every table to anon afterwards, so check what they
      // see (RLS on, no policy) rather than the grant the migration revokes.
      expect(await db().attempt(anon, 'SELECT * FROM visitor_sessions')).toEqual([]);
      expect(await db().attempt({ kind: 'user', id: ws.ownerId }, 'SELECT * FROM visitor_sessions')).toEqual([]);
      expect(await db().rejects(anon, 'SELECT fn_widget_auth($1, $2)', [ws.visitorId, token])).toMatch(/permission denied/);
    });

    it('resumes the latest conversation', async () => {
      const ws = await createWorkspace(db());
      const { conversationId } = await startChat(db(), ws, 'Hello');
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      expect((await session(ws.id, ws.visitorId, token)).conversation).toMatchObject({ id: conversationId, status: 'open' });
    });
  });

  describe('reading', () => {
    it("shows a visitor their public messages and nothing else, and never another visitor's chat", async () => {
      const ws = await createWorkspace(db());
      const { conversationId } = await startChat(db(), ws, 'Where is my order?');
      await teamSays(ws, conversationId, 'Checking now.');
      await teamSays(ws, conversationId, 'Customer seems angry', true);

      const own = await messagesOf(ws, conversationId);
      expect(own.messages.map((m) => m.content)).toEqual(['Where is my order?', 'Checking now.']);
      // Only what the widget renders: no sender ids, no internal flag.
      expect(Object.keys(own.messages[1]).sort()).toEqual(
        ['attachment_url', 'content', 'conversation_id', 'created_at', 'delivered_at', 'id', 'metadata', 'read_at', 'reply_to_message_id', 'sender_type'].sort()
      );

      const other = await createVisitor(db(), ws.id, 'Someone else');
      const otherToken = await widgetToken(db(), ws.id, other);
      expect(await db().rejects(anon, 'SELECT fn_widget_messages($1, $2, $3)', [other, otherToken, conversationId])).toMatch(
        /conversation_not_found/
      );
      // A real visitor id with a made-up token does not help either.
      expect(await db().rejects(anon, 'SELECT fn_widget_messages($1, $2, $3)', [ws.visitorId, 'nope', conversationId])).toMatch(
        /visitor_session_invalid/
      );
    });

    it('passes only the metadata the widget shows', async () => {
      const ws = await createWorkspace(db());
      const { conversationId } = await startChat(db(), ws, 'Hola');
      await db().q(
        `INSERT INTO messages (conversation_id, sender_type, content, metadata, created_at)
         VALUES ($1, 'ai', 'Hello', '{"translation": {"translated_text": "Hola", "provider": "x"}, "ai_idempotency_key": "k", "sources": [1]}', clock_timestamp())`,
        [conversationId]
      );
      const { messages } = await messagesOf(ws, conversationId);
      expect(messages[1].metadata).toEqual({ translation: { translated_text: 'Hola' } });
    });

    it("lists the visitor's own conversations", async () => {
      const ws = await createWorkspace(db());
      await startChat(db(), ws, 'First');
      await startChat(db(), ws, 'Second');
      const elsewhere = await createWorkspace(db());
      await startChat(db(), elsewhere, 'Not mine');
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      const [{ r }] = await db().as<{ r: { last_message: { content: string } }[] }>(anon, 'SELECT fn_widget_conversations($1, $2) AS r', [
        ws.visitorId,
        token,
      ]);
      expect(r.map((c) => c.last_message.content).sort()).toEqual(['First', 'Second']);
    });
  });

  describe('writing', () => {
    it('a visitor message reaches the ticket like before', async () => {
      const ws = await createWorkspace(db());
      const { conversationId, ticket } = await startChat(db(), ws, 'My invoice is wrong');
      expect(ticket.subject).toMatch(/invoice/);
      expect(ticket.requester_id).toBe(ws.visitorId);
      const [m] = await db().q('SELECT sender_type, is_internal, ticket_id FROM messages WHERE conversation_id = $1', [conversationId]);
      expect(m).toEqual({ sender_type: 'visitor', is_internal: false, ticket_id: ticket.id });
    });

    it('reopens a closed conversation when the visitor writes again', async () => {
      const ws = await createWorkspace(db());
      const { conversationId } = await startChat(db(), ws, 'Hi');
      await db().q(`UPDATE conversations SET status = 'closed' WHERE id = $1`, [conversationId]);
      await visitorSays(db(), conversationId, 'Me again');
      expect(await db().one('SELECT status FROM conversations WHERE id = $1', [conversationId])).toEqual({ status: 'open' });
    });

    it("refuses empty messages, non-https attachments and someone else's conversation", async () => {
      const ws = await createWorkspace(db());
      const { conversationId } = await startChat(db(), ws, 'Hi');
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      const send = (content: string, url: string | null = null) =>
        db().rejects(anon, 'SELECT fn_widget_send_message($1, $2, $3, $4, $5)', [ws.visitorId, token, conversationId, content, url]);
      expect(await send('   ')).toMatch(/message_empty/);
      expect(await send('', 'javascript:alert(1)')).toMatch(/attachment_url_invalid/);

      const other = await createVisitor(db(), ws.id, 'Intruder');
      const otherToken = await widgetToken(db(), ws.id, other);
      expect(
        await db().rejects(anon, 'SELECT fn_widget_send_message($1, $2, $3, $4)', [other, otherToken, conversationId, 'hi'])
      ).toMatch(/conversation_not_found/);
    });

    it('the greeting is written once, on an empty conversation only', async () => {
      const ws = await createWorkspace(db());
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      const [{ c }] = await db().as<{ c: { id: string } }>(anon, 'SELECT fn_widget_start_conversation($1, $2, true) AS c', [ws.visitorId, token]);
      const welcome = () =>
        db().as<{ m: { metadata: unknown } | null }>(anon, 'SELECT fn_widget_welcome($1, $2, $3, $4) AS m', [ws.visitorId, token, c.id, 'Welcome!']);
      expect((await welcome())[0].m?.metadata).toEqual({ is_welcome: true });
      expect((await welcome())[0].m).toBeNull();
      const [{ count }] = await db().q<{ count: string }>('SELECT count(*) FROM messages WHERE conversation_id = $1', [c.id]);
      expect(Number(count)).toBe(1);
    });

    it("marks the team's messages read, not the visitor's own", async () => {
      const ws = await createWorkspace(db());
      const { conversationId } = await startChat(db(), ws, 'Hi');
      await teamSays(ws, conversationId, 'Hello!');
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      await db().as(anon, 'SELECT fn_widget_mark($1, $2, $3, true)', [ws.visitorId, token, conversationId]);
      const rows = await db().q<{ sender_type: string; read: boolean }>(
        'SELECT sender_type, read_at IS NOT NULL AS read FROM messages WHERE conversation_id = $1 ORDER BY created_at',
        [conversationId]
      );
      expect(rows).toEqual([
        { sender_type: 'visitor', read: false },
        { sender_type: 'agent', read: true },
      ]);
    });

    it('sets the pre-chat topic as a ticket tag', async () => {
      const ws = await createWorkspace(db());
      await db().q(`UPDATE workspaces SET navbar_trigger_config = '{"prechat": {"topics": ["Billing"]}}' WHERE id = $1`, [ws.id]);
      const { conversationId } = await startChat(db(), ws, 'Hi');
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      await db().as(anon, 'SELECT fn_widget_set_topic($1, $2, $3, $4)', [ws.visitorId, token, conversationId, 'Billing']);
      expect((await ticketOf(db(), conversationId)).tags).toContain('Billing');
    });

    it("updates the visitor's own name and email only", async () => {
      const ws = await createWorkspace(db());
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      await db().as(anon, 'SELECT fn_widget_update_visitor($1, $2, $3, $4)', [ws.visitorId, token, 'Sara', 'sara@example.test']);
      expect(await db().one('SELECT name, email FROM visitors WHERE id = $1', [ws.visitorId])).toEqual({
        name: 'Sara',
        email: 'sara@example.test',
      });
      expect(
        await db().rejects(anon, 'SELECT fn_widget_update_visitor($1, $2, NULL, $3)', [ws.visitorId, token, 'not-an-email'])
      ).toMatch(/email_invalid/);
    });

    it('team presence for the header carries no emails', async () => {
      const ws = await createWorkspace(db());
      const [{ a }] = await db().as<{ a: Record<string, unknown>[] }>(anon, 'SELECT fn_widget_agents($1) AS a', [ws.id]);
      expect(a).toHaveLength(3);
      expect(Object.keys(a[0]).sort()).toEqual(['avatar_url', 'id', 'name', 'status']);
    });
  });

  describe('tracking (20261108090000)', () => {
    it('heartbeat, page trail, offline and meta work with the token and use the session workspace', async () => {
      const ws = await createWorkspace(db());
      const other = await createWorkspace(db());
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      const v = [ws.visitorId, token];
      await db().as(anon, 'SELECT fn_widget_heartbeat($1, $2, $3, $4, NULL, 12)', [...v, 'https://shop.test/a', 'Page A']);
      expect(await db().one('SELECT is_online, current_page_url FROM visitors WHERE id = $1', [ws.visitorId])).toEqual({
        is_online: true,
        current_page_url: 'https://shop.test/a',
      });
      await db().as(anon, 'SELECT fn_widget_record_page($1, $2, $3, $4, NULL, 5)', [...v, 'https://shop.test/b', 'Page B']);
      const trail = await db().q('SELECT url, workspace_id FROM visitor_page_history WHERE visitor_id = $1', [ws.visitorId]);
      expect(trail).toEqual([{ url: 'https://shop.test/b', workspace_id: ws.id }]);
      expect(trail[0].workspace_id).not.toBe(other.id);
      await db().as(anon, 'SELECT fn_widget_update_meta($1, $2, $3, $4)', [...v, 'Asia/Karachi', 'ur-PK']);
      expect(await db().one('SELECT timezone, language FROM visitors WHERE id = $1', [ws.visitorId])).toEqual({
        timezone: 'Asia/Karachi',
        language: 'ur-PK',
      });
      await db().as(anon, 'SELECT fn_widget_offline($1, $2)', v);
      expect(await db().one('SELECT is_online FROM visitors WHERE id = $1', [ws.visitorId])).toEqual({ is_online: false });
    });

    it('a visitor id without its token changes nothing', async () => {
      const ws = await createWorkspace(db());
      await widgetToken(db(), ws.id, ws.visitorId);
      for (const sql of [
        `SELECT fn_widget_offline($1, 'f00')`,
        `SELECT fn_widget_heartbeat($1, 'f00', 'https://evil.test')`,
        `SELECT fn_widget_record_page($1, 'f00', 'https://evil.test')`,
      ]) {
        expect(await db().rejects(anon, sql, [ws.visitorId]), sql).toMatch(/visitor_session_invalid/);
      }
    });

    it('the id-only originals are closed to the public key, open to agents', async () => {
      const ws = await createWorkspace(db());
      for (const sql of [
        `SELECT fn_visitor_offline('${ws.visitorId}')`,
        `SELECT fn_visitor_heartbeat('${ws.visitorId}')`,
        `SELECT fn_record_visitor_page('${ws.visitorId}', 'https://evil.test', NULL, NULL, 0, '${ws.id}')`,
        `SELECT fn_update_visitor_meta('${ws.visitorId}', 'UTC', 'en')`,
      ]) {
        expect(await db().rejects(anon, sql), sql).toMatch(/permission denied/);
      }
      await db().as({ kind: 'user', id: ws.agentId }, `SELECT fn_visitor_heartbeat($1)`, [ws.visitorId]);
    });

    it('the service role can check a token (the API routes do)', async () => {
      const ws = await createWorkspace(db());
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      const [row] = await db().as<{ workspace_id: string }>({ kind: 'service' }, 'SELECT (fn_widget_auth($1, $2)).workspace_id', [
        ws.visitorId,
        token,
      ]);
      expect(row.workspace_id).toBe(ws.id);
    });
  });

  describe('live updates', () => {
    async function withBroadcastRecorder() {
      await db().q(`
        CREATE SCHEMA IF NOT EXISTS realtime;
        CREATE TABLE IF NOT EXISTS realtime.sent (payload jsonb, event text, topic text, private boolean);
        CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true)
        RETURNS void LANGUAGE sql AS $$ INSERT INTO realtime.sent VALUES (payload, event, topic, private) $$;
      `);
      return () =>
        db().q<{
          payload: { op: string; message?: { content?: string }; conversation?: { status?: string } };
          event: string;
          topic: string;
          private: boolean;
        }>('SELECT * FROM realtime.sent');
    }

    it("pushes the visitor's public messages and status changes on their own topic only", async () => {
      const sent = await withBroadcastRecorder();
      const ws = await createWorkspace(db());
      const token = await widgetToken(db(), ws.id, ws.visitorId);
      const { topic } = await session(ws.id, ws.visitorId, token);
      const { conversationId } = await startChat(db(), ws, 'Hi');
      await teamSays(ws, conversationId, 'Hello there');
      await teamSays(ws, conversationId, 'secret note', true);
      await db().q(`UPDATE conversations SET status = 'closed' WHERE id = $1`, [conversationId]);

      const rows = await sent();
      expect(rows.every((r) => r.topic === topic && r.private === false)).toBe(true);
      const messages = rows.filter((r) => r.event === 'message' && r.payload.op === 'INSERT').map((r) => r.payload.message?.content);
      expect(messages).toEqual(['Hi', 'Hello there']);
      expect(JSON.stringify(rows)).not.toContain('secret note');
      expect(rows.some((r) => r.event === 'conversation' && r.payload.conversation?.status === 'closed')).toBe(true);
    });

    it('a failing broadcast never blocks the message', async () => {
      await db().q(`
        CREATE SCHEMA IF NOT EXISTS realtime;
        CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true)
        RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'realtime down'; END $$;
      `);
      const ws = await createWorkspace(db());
      const { conversationId } = await startChat(db(), ws, 'Still arrives');
      expect((await messagesOf(ws, conversationId)).messages).toHaveLength(1);
    });
  });

  describe('after the lockdown', () => {
    it('the anon key reads and writes no chats, visitors or agents directly', async () => {
      const ws = await createWorkspace(db());
      const { conversationId } = await startChat(db(), ws, 'Private message');
      await db().q(LOCKDOWN);
      for (const sql of [
        'SELECT * FROM messages',
        'SELECT * FROM conversations',
        'SELECT * FROM visitors',
        'SELECT * FROM agents',
        `UPDATE messages SET content = 'hacked'`,
        `INSERT INTO messages (conversation_id, sender_type, content) VALUES ('${conversationId}', 'visitor', 'x')`,
        `UPDATE visitors SET email = 'attacker@example.test'`,
      ]) {
        expect(await db().rejects(anon, sql), sql).toMatch(/permission denied/);
      }
      for (const [fn, sql] of [
        ['fn_get_visitor_conversations(uuid,uuid)', `SELECT fn_get_visitor_conversations('${ws.visitorId}', '${ws.id}')`],
        ['fn_mark_messages_read(uuid,text)', `SELECT fn_mark_messages_read('${conversationId}', 'visitor')`],
        ['fn_set_conversation_topic(uuid,uuid,text)', `SELECT fn_set_conversation_topic('${conversationId}', '${ws.visitorId}', 'x')`],
      ]) {
        // Some are created outside the migrations and are not in this database.
        const [{ exists }] = await db().q<{ exists: boolean }>('SELECT to_regprocedure($1) IS NOT NULL AS exists', [fn]);
        if (exists) expect(await db().rejects(anon, sql), sql).toMatch(/permission denied/);
      }
    });

    it('the whole widget flow still works, and agents are unaffected', async () => {
      const ws = await createWorkspace(db());
      await db().q(LOCKDOWN);
      const visitorId = crypto.randomUUID();
      // A brand-new visitor, after the lockdown.
      const token = await widgetToken(db(), ws.id, visitorId);
      await db().as(anon, 'SELECT fn_widget_update_visitor($1, $2, $3, $4)', [visitorId, token, 'Ali', 'ali@example.test']);
      const [{ c }] = await db().as<{ c: { id: string } }>(anon, 'SELECT fn_widget_start_conversation($1, $2, false) AS c', [visitorId, token]);
      await db().as(anon, 'SELECT fn_widget_welcome($1, $2, $3, $4)', [visitorId, token, c.id, 'Welcome']);
      await db().as(anon, 'SELECT fn_widget_send_message($1, $2, $3, $4)', [visitorId, token, c.id, 'Need help']);
      await teamSays(ws, c.id, 'Sure');
      await db().as(anon, 'SELECT fn_widget_mark($1, $2, $3, true)', [visitorId, token, c.id]);
      const { messages } = await messagesOf(ws, c.id, visitorId);
      expect(messages.map((m) => [m.sender_type, m.content])).toEqual([
        ['agent', 'Welcome'],
        ['visitor', 'Need help'],
        ['agent', 'Sure'],
      ]);
      expect((await session(ws.id, visitorId, token)).conversation?.id).toBe(c.id);
      const [{ r }] = await db().as<{ r: unknown[] }>(anon, 'SELECT fn_widget_conversations($1, $2) AS r', [visitorId, token]);
      expect(r).toHaveLength(1);

      // The team still sees and answers it as before.
      const seen = await db().as({ kind: 'user', id: ws.agentId }, 'SELECT content FROM messages WHERE conversation_id = $1', [c.id]);
      expect(seen).toHaveLength(3);
      await db().as({ kind: 'user', id: ws.agentId }, `SELECT fn_mark_messages_read($1, 'agent')`, [c.id]);
      expect((await ticketOf(db(), c.id)).status).toBe('open');
    });

    it('enforces rate limit of 300 new sessions/min per workspace on fn_widget_session', async () => {
      const ws = await createWorkspace(db());
      const bucket = 'ws_session:' + ws.id;

      // Seed 300 hits in the current minute window
      await db().q(
        `INSERT INTO rate_limit_hits (bucket, window_start, hits)
         VALUES ($1, to_timestamp(floor(extract(epoch from now()) / 60) * 60), 300)
         ON CONFLICT (bucket, window_start) DO UPDATE SET hits = 300`,
        [bucket]
      );

      // Attempting to create a NEW session exceeds the 300 limit
      const newVisitorId = crypto.randomUUID();
      const err = await db().rejects(
        anon,
        'SELECT fn_widget_session($1, $2, NULL)',
        [ws.id, newVisitorId]
      );
      expect(err).toMatch(/rate_limited/);

      // But an existing visitor with a valid token is NOT rate-limited
      const existingVisitor = crypto.randomUUID();
      const existingToken = 'b'.repeat(64);
      // One statement per query: a prepared statement cannot hold two.
      await db().q('INSERT INTO visitors (id, workspace_id) VALUES ($1, $2)', [existingVisitor, ws.id]);
      await db().q(
        'INSERT INTO visitor_sessions (visitor_id, workspace_id, token_hash) VALUES ($1, $2, fn_widget_token_hash($3))',
        [existingVisitor, ws.id, existingToken]
      );
      const existingSession = await session(ws.id, existingVisitor, existingToken);
      expect(existingSession).toBeDefined();
    });

    it('enforces rate limit of 20 messages/min on fn_widget_send_message', async () => {
      const ws = await createWorkspace(db());
      const visitorId = crypto.randomUUID();
      const token = await widgetToken(db(), ws.id, visitorId);
      const [{ c }] = await db().as<{ c: { id: string } }>(
        anon,
        'SELECT fn_widget_start_conversation($1, $2, false) AS c',
        [visitorId, token]
      );

      // Seed 20 hits in the current minute window for this visitor
      const minuteBucket = 'visitor_msg_m:' + visitorId;
      await db().q(
        `INSERT INTO rate_limit_hits (bucket, window_start, hits)
         VALUES ($1, to_timestamp(floor(extract(epoch from now()) / 60) * 60), 20)
         ON CONFLICT (bucket, window_start) DO UPDATE SET hits = 20`,
        [minuteBucket]
      );

      const err = await db().rejects(
        anon,
        'SELECT fn_widget_send_message($1, $2, $3, $4)',
        [visitorId, token, c.id, 'Too fast message']
      );
      expect(err).toMatch(/rate_limited/);
    });

    it('the undo script restores the old access', async () => {
      const ws = await createWorkspace(db());
      const { conversationId } = await startChat(db(), ws, 'Hi');
      await db().q(LOCKDOWN);
      await db().q(UNDO);
      expect((await db().as(anon, 'SELECT id FROM messages')).length).toBeGreaterThan(0);
      await db().as(anon, `SELECT fn_mark_messages_read($1, 'agent')`, [conversationId]);
    });

    it('both scripts can be run twice', async () => {
      await db().q(LOCKDOWN);
      await db().q(LOCKDOWN);
      await db().q(UNDO);
      await db().q(UNDO);
    });
  });
});
