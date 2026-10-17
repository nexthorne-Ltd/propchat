/**
 * Channel rules that live in the database (supabase/migrations/20261011090000_channels.sql):
 * inbound messages become tickets, webhook retries are harmless, replies are
 * queued and retried, receipts only move forward, the WhatsApp window is
 * enforced for every writer, and secrets stay server-side.
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { agentSays, createWorkspace, hasDatabase, ticketOf, useTestDatabase, type Db, type WorkspaceFixture } from '@/test/db';

async function connect(db: Db, ws: WorkspaceFixture, phoneNumberId = `pn-${ws.id.slice(0, 8)}`): Promise<string> {
  const { id } = await db.one<{ id: string }>(
    `INSERT INTO channel_connections (workspace_id, channel, status, external_account_id, display_name)
     VALUES ($1, 'whatsapp', 'connected', $2, '+1 555 0100') RETURNING id`,
    [ws.id, phoneNumberId]
  );
  return id;
}

interface Ingested extends Record<string, unknown> {
  duplicate: boolean;
  conversation_id: string;
  message_id: string;
  ticket_id: string;
  workspace_id: string;
}

async function ingest(db: Db, connectionId: string, wamid: string, text: string, from = '15550001111', at = 'now()') {
  const [row] = await db.as<{ r: Ingested }>(
    { kind: 'service' },
    `SELECT fn_channel_ingest_inbound($1, $2, 'Ana Souza', $3, $4, NULL, '{}'::jsonb, ${at}) AS r`,
    [connectionId, from, wamid, text]
  );
  return row.r;
}

describe.skipIf(!hasDatabase)('channels (database)', () => {
  const { db } = useTestDatabase();

  describe('inbound', () => {
    it('turns a first WhatsApp message into a visitor, conversation and WhatsApp ticket', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const r = await ingest(db(), conn, 'wamid.A1', 'My order never arrived\nOrder 5512');
      expect(r.duplicate).toBe(false);
      expect(r.workspace_id).toBe(ws.id);
      const t = await ticketOf(db(), r.conversation_id);
      expect(t).toMatchObject({ channel: 'whatsapp', subject: 'My order never arrived', status: 'new' });
      const conv = await db().one('SELECT channel, channel_user_id, channel_last_inbound_at FROM conversations WHERE id = $1', [r.conversation_id]);
      expect(conv).toMatchObject({ channel: 'whatsapp', channel_user_id: '15550001111' });
      expect(conv.channel_last_inbound_at).not.toBeNull();
      const visitor = await db().one('SELECT v.name, v.channel FROM visitors v JOIN conversations c ON c.visitor_id = v.id WHERE c.id = $1', [r.conversation_id]);
      expect(visitor).toMatchObject({ name: 'Ana Souza', channel: 'whatsapp' });
      const [created] = await db().q(`SELECT actor_type FROM ticket_events WHERE ticket_id = $1 AND action = 'created'`, [t.id]);
      expect(created.actor_type).toBe('customer');
    });

    it('ignores a webhook retry of the same message', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const first = await ingest(db(), conn, 'wamid.R1', 'hello');
      const again = await ingest(db(), conn, 'wamid.R1', 'hello');
      expect(again).toMatchObject({ duplicate: true, message_id: first.message_id });
      const [{ n }] = await db().q<{ n: string }>('SELECT count(*) AS n FROM messages WHERE conversation_id = $1', [first.conversation_id]);
      expect(Number(n)).toBe(1);
    });

    it('adds later messages from the same number to the same ticket, and reopens it', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const a = await ingest(db(), conn, 'wamid.S1', 'first');
      await db().q(`UPDATE tickets SET status = 'pending' WHERE id = $1`, [a.ticket_id]);
      const b = await ingest(db(), conn, 'wamid.S2', 'second');
      expect(b.conversation_id).toBe(a.conversation_id);
      expect(b.ticket_id).toBe(a.ticket_id);
      expect((await ticketOf(db(), a.conversation_id)).status).toBe('open');
    });

    it('opens a linked follow-up when the ticket was closed', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const a = await ingest(db(), conn, 'wamid.F1', 'first');
      await db().q(`UPDATE tickets SET status = 'closed' WHERE id = $1`, [a.ticket_id]);
      const b = await ingest(db(), conn, 'wamid.F2', 'back again');
      expect(b.ticket_id).not.toBe(a.ticket_id);
      const follow = await db().one('SELECT follow_up_of_id, channel FROM tickets WHERE id = $1', [b.ticket_id]);
      expect(follow).toMatchObject({ follow_up_of_id: a.ticket_id, channel: 'whatsapp' });
    });

    it('keeps different numbers and workspaces apart', async () => {
      const a = await createWorkspace(db());
      const b = await createWorkspace(db());
      const connA = await connect(db(), a);
      const connB = await connect(db(), b);
      const x = await ingest(db(), connA, 'wamid.X1', 'hi', '111');
      const y = await ingest(db(), connA, 'wamid.X2', 'hi', '222');
      const z = await ingest(db(), connB, 'wamid.X3', 'hi', '111');
      expect(new Set([x.conversation_id, y.conversation_id, z.conversation_id]).size).toBe(3);
      expect(z.workspace_id).toBe(b.id);
    });

    it('refuses a disconnected connection, and is not callable by users or the widget', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      await db().q(`UPDATE channel_connections SET status = 'disconnected' WHERE id = $1`, [conn]);
      expect(await db().rejects({ kind: 'service' }, `SELECT fn_channel_ingest_inbound($1, '1', 'x', 'wamid.D1', 'hi')`, [conn])).toMatch(/not connected/);
      expect(await db().rejects({ kind: 'anon' }, `SELECT fn_channel_ingest_inbound($1, '1', 'x', 'wamid.D2', 'hi')`, [conn])).toMatch(/permission denied/);
      expect(await db().rejects({ kind: 'user', id: ws.ownerId }, `SELECT fn_channel_ingest_inbound($1, '1', 'x', 'wamid.D3', 'hi')`, [conn])).toMatch(/permission denied/);
    });

    it('lets only one active connection claim a phone number', async () => {
      const a = await createWorkspace(db());
      const b = await createWorkspace(db());
      await connect(db(), a, 'pn-shared');
      expect(await db().rejects({ kind: 'superuser' }, `INSERT INTO channel_connections (workspace_id, channel, status, external_account_id) VALUES ($1, 'whatsapp', 'connected', 'pn-shared')`, [b.id])).toMatch(/duplicate key/);
    });
  });

  describe('outbound', () => {
    it('queues an agent reply on a WhatsApp conversation, but not notes or widget chats', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const r = await ingest(db(), conn, 'wamid.O1', 'help');
      await agentSays(db(), r.conversation_id, ws.agentId, 'On it!');
      await agentSays(db(), r.conversation_id, ws.agentId, 'internal', true);
      const rows = await db().q('SELECT q.status, m.content, m.channel_status FROM channel_outbound_queue q JOIN messages m ON m.id = q.message_id WHERE q.conversation_id = $1', [r.conversation_id]);
      expect(rows).toEqual([{ status: 'queued', content: 'On it!', channel_status: 'queued' }]);
    });

    it('refuses free text outside the 24-hour window, but accepts a template', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const r = await ingest(db(), conn, 'wamid.W1', 'hello', '999', `now() - interval '25 hours'`);
      const err = await db().rejects(
        { kind: 'user', id: ws.agentId },
        `INSERT INTO messages (conversation_id, sender_type, sender_id, content) VALUES ($1, 'agent', $2, 'late reply')`,
        [r.conversation_id, ws.agentId]
      );
      expect(err).toMatch(/24-hour customer service window/);
      // The bot is held to the same rule.
      expect(
        await db().rejects({ kind: 'service' }, `INSERT INTO messages (conversation_id, sender_type, content) VALUES ($1, 'ai', 'bot reply')`, [r.conversation_id])
      ).toMatch(/24-hour/);
      await db().as(
        { kind: 'user', id: ws.agentId },
        `INSERT INTO messages (conversation_id, sender_type, sender_id, content, metadata)
         VALUES ($1, 'agent', $2, 'Template: order_update', '{"channel_template": {"name": "order_update", "language": "en_US"}}')`,
        [r.conversation_id, ws.agentId]
      );
      const [{ n }] = await db().q<{ n: string }>('SELECT count(*) AS n FROM channel_outbound_queue WHERE conversation_id = $1', [r.conversation_id]);
      expect(Number(n)).toBe(1);
    });

    it('retries with backoff, then fails for good and marks the message', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const r = await ingest(db(), conn, 'wamid.B1', 'hi');
      await agentSays(db(), r.conversation_id, ws.agentId, 'reply');
      const [claimed] = await db().as<{ id: string; attempts: number; message_id: string }>({ kind: 'service' }, 'SELECT * FROM fn_claim_channel_outbound(10)');
      expect(claimed.attempts).toBe(1);
      // A second worker gets nothing while it is being sent.
      expect(await db().as({ kind: 'service' }, 'SELECT * FROM fn_claim_channel_outbound(10)')).toEqual([]);

      const [{ s }] = await db().as<{ s: string }>({ kind: 'service' }, `SELECT fn_complete_channel_outbound($1, false, NULL, 'HTTP 503', true) AS s`, [claimed.id]);
      expect(s).toBe('queued');
      const q = await db().one<{ next_attempt_at: Date }>('SELECT next_attempt_at FROM channel_outbound_queue WHERE id = $1', [claimed.id]);
      expect(q.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 20_000);

      await db().q(`UPDATE channel_outbound_queue SET attempts = max_attempts, next_attempt_at = now() WHERE id = $1`, [claimed.id]);
      const [{ s: last }] = await db().as<{ s: string }>({ kind: 'service' }, `SELECT fn_complete_channel_outbound($1, false, NULL, 'HTTP 503', true) AS s`, [claimed.id]);
      expect(last).toBe('failed');
      expect(await db().one('SELECT channel_status, channel_error FROM messages WHERE id = $1', [claimed.message_id])).toEqual({
        channel_status: 'failed',
        channel_error: 'HTTP 503',
      });

      // An agent can put it back in the queue once the cause is fixed.
      await db().as({ kind: 'user', id: ws.agentId }, 'SELECT fn_retry_channel_message($1)', [claimed.message_id]);
      expect((await db().one('SELECT status FROM channel_outbound_queue WHERE id = $1', [claimed.id])).status).toBe('queued');
    });

    it('fails at once on a permanent error, and records the provider id on success', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const r = await ingest(db(), conn, 'wamid.P1', 'hi');
      await agentSays(db(), r.conversation_id, ws.agentId, 'one');
      await agentSays(db(), r.conversation_id, ws.agentId, 'two');
      const claimed = await db().as<{ id: string; message_id: string }>({ kind: 'service' }, 'SELECT * FROM fn_claim_channel_outbound(10)');
      expect(claimed).toHaveLength(2);
      const [{ s }] = await db().as<{ s: string }>({ kind: 'service' }, `SELECT fn_complete_channel_outbound($1, false, NULL, 'bad number', false) AS s`, [claimed[0].id]);
      expect(s).toBe('failed');
      await db().as({ kind: 'service' }, `SELECT fn_complete_channel_outbound($1, true, 'wamid.OUT2')`, [claimed[1].id]);
      expect(await db().one('SELECT channel_message_id, channel_status FROM messages WHERE id = $1', [claimed[1].message_id])).toEqual({
        channel_message_id: 'wamid.OUT2',
        channel_status: 'sent',
      });
    });
  });

  describe('receipts', () => {
    it('only moves forward', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const r = await ingest(db(), conn, 'wamid.T1', 'hi');
      await agentSays(db(), r.conversation_id, ws.agentId, 'reply');
      const [q] = await db().as<{ id: string; message_id: string }>({ kind: 'service' }, 'SELECT * FROM fn_claim_channel_outbound(10)');
      await db().as({ kind: 'service' }, `SELECT fn_complete_channel_outbound($1, true, 'wamid.OUT')`, [q.id]);
      const status = (s: string) => db().as<{ ok: boolean }>({ kind: 'service' }, `SELECT fn_channel_record_status('wamid.OUT', $1) AS ok`, [s]);
      expect((await status('read'))[0].ok).toBe(true);
      expect((await status('delivered'))[0].ok).toBe(false);
      const m = await db().one('SELECT channel_status, delivered_at, read_at FROM messages WHERE id = $1', [q.message_id]);
      expect(m.channel_status).toBe('read');
      expect(m.delivered_at).not.toBeNull();
      expect(m.read_at).not.toBeNull();
      expect((await db().as<{ ok: boolean }>({ kind: 'service' }, `SELECT fn_channel_record_status('wamid.unknown', 'read') AS ok`))[0].ok).toBe(false);
    });
  });

  describe('access', () => {
    it('shows connections to members only, lets only admins change them, and hides secrets from everyone but the server', async () => {
      const a = await createWorkspace(db());
      const b = await createWorkspace(db());
      const conn = await connect(db(), a);
      await db().q(`INSERT INTO channel_secrets (connection_id, workspace_id, ciphertext) VALUES ($1, $2, 'v1:x:y:z')`, [conn, a.id]);

      expect(await db().as({ kind: 'user', id: a.agentId }, 'SELECT id FROM channel_connections')).toHaveLength(1);
      expect(await db().as({ kind: 'user', id: b.ownerId }, 'SELECT id FROM channel_connections')).toHaveLength(0);
      expect(await db().as({ kind: 'anon' }, 'SELECT id FROM channel_connections').catch(() => [])).toHaveLength(0);

      expect(await db().as({ kind: 'user', id: a.agentId }, `UPDATE channel_connections SET status = 'disconnected' RETURNING id`)).toHaveLength(0);
      expect(await db().as({ kind: 'user', id: a.adminId }, `UPDATE channel_connections SET display_name = 'Support' RETURNING id`)).toHaveLength(1);

      // The migration revokes the table outright; the test harness re-grants
      // every table, so RLS (no policy at all) is what must still hold.
      expect(await db().as({ kind: 'user', id: a.ownerId }, 'SELECT * FROM channel_secrets').catch(() => [])).toHaveLength(0);
      expect(await db().as({ kind: 'service' }, 'SELECT ciphertext FROM channel_secrets')).toHaveLength(1);
    });
  });
});
