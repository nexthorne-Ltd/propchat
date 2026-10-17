/**
 * The email channel's rules in the database
 * (supabase/migrations/20261015090000_email_channel.sql): which ticket an
 * email joins, who may write into a ticket, bounces, loops, and the requester
 * notifications. Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { agentSays, createWorkspace, hasDatabase, ticket, useTestDatabase, type Db, type WorkspaceFixture } from '@/test/db';

async function connect(db: Db, ws: WorkspaceFixture, address = `support-${ws.id.slice(0, 8)}@in.example.test`): Promise<string> {
  const { id } = await db.one<{ id: string }>(
    `INSERT INTO channel_connections (workspace_id, channel, status, external_account_id, display_name)
     VALUES ($1, 'email', 'connected', $2, $2) RETURNING id`,
    [ws.id, address]
  );
  return id;
}

interface Opts {
  name?: string;
  inReplyTo?: string | null;
  refs?: string[];
  token?: number | null;
  subjectRef?: number | null;
  subject?: string;
  content?: string;
  cc?: { email: string; name?: string }[];
  attachments?: unknown[];
}

async function receive(db: Db, conn: string, from: string, mid: string, o: Opts = {}) {
  const [row] = await db.as<{ r: Record<string, unknown> }>(
    { kind: 'service' },
    `SELECT fn_email_ingest_inbound($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11::jsonb, '{}'::jsonb, $12::jsonb, now()) AS r`,
    [conn, from, o.name ?? null, mid, o.inReplyTo ?? null, o.refs ?? [], o.token ?? null, o.subjectRef ?? null, o.subject ?? 'Help me', o.content ?? 'Hello', JSON.stringify(o.attachments ?? []), JSON.stringify(o.cc ?? [])]
  );
  return row.r as { duplicate: boolean; created: boolean; matched_by: string; conversation_id: string; ticket_id: string; ticket_number: number; message_id: string };
}

describe.skipIf(!hasDatabase)('email channel (database)', () => {
  const { db } = useTestDatabase();

  describe('new tickets', () => {
    it('turns an email into an email ticket with its subject, requester and CC', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const r = await receive(db(), conn, 'Alice@Example.org', 'new1@mail.test', {
        name: 'Alice Example',
        subject: 'Cannot log in',
        cc: [{ email: 'Bob@Example.org', name: 'Bob' }],
        attachments: [{ name: 'a.log', url: 'https://cdn.test/a.log', type: 'text/plain', size: 10, inline: false }],
      });
      expect(r).toMatchObject({ created: true, matched_by: 'new', duplicate: false });
      expect(await ticket(db(), r.ticket_id)).toMatchObject({ channel: 'email', subject: 'Cannot log in', status: 'new' });
      const visitor = await db().one<{ email: string; name: string }>(
        `SELECT v.email, v.name FROM visitors v JOIN tickets t ON t.requester_id = v.id WHERE t.id = $1`,
        [r.ticket_id]
      );
      expect(visitor).toEqual({ email: 'alice@example.org', name: 'Alice Example' });
      const conv = await db().one<{ channel: string; channel_user_id: string; channel_metadata: { email_cc: { email: string }[] } }>(
        'SELECT channel, channel_user_id, channel_metadata FROM conversations WHERE id = $1',
        [r.conversation_id]
      );
      expect(conv).toMatchObject({ channel: 'email', channel_user_id: 'alice@example.org' });
      expect(conv.channel_metadata.email_cc.map((c) => c.email)).toEqual(['bob@example.org']);
      const msg = await db().one<{ attachment_url: string; channel_message_id: string }>('SELECT attachment_url, channel_message_id FROM messages WHERE id = $1', [r.message_id]);
      expect(msg).toEqual({ attachment_url: 'https://cdn.test/a.log', channel_message_id: 'new1@mail.test' });
    });

    it('ignores a retried delivery of the same email', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      await receive(db(), conn, 'a@example.org', 'dup@mail.test');
      expect((await receive(db(), conn, 'a@example.org', 'dup@mail.test')).duplicate).toBe(true);
      expect(await db().q('SELECT 1 FROM tickets WHERE workspace_id = $1 AND channel = $2', [ws.id, 'email'])).toHaveLength(1);
    });

    it('two different emails from one person are two tickets', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const a = await receive(db(), conn, 'a@example.org', 'x1@mail.test', { subject: 'Billing' });
      const b = await receive(db(), conn, 'a@example.org', 'x2@mail.test', { subject: 'Shipping' });
      expect(a.ticket_id).not.toBe(b.ticket_id);
    });

    it('reuses a requester the workspace already knows by email', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      await db().q(`UPDATE visitors SET email = 'known@example.org', name = 'Known Person' WHERE id = $1`, [ws.visitorId]);
      const r = await receive(db(), conn, 'KNOWN@example.org', 'k1@mail.test');
      expect((await ticket(db(), r.ticket_id)).requester_id).toBe(ws.visitorId);
    });
  });

  describe('replies', () => {
    async function threaded() {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const first = await receive(db(), conn, 'alice@example.org', 'first@mail.test', { subject: 'Cannot log in' });
      // An agent reply that went out with this Message-ID (what the outbound worker stores).
      await agentSays(db(), first.conversation_id, ws.agentId, 'Try resetting your password.');
      await db().q(
        `UPDATE messages SET channel_message_id = 'out1@in.example.test' WHERE conversation_id = $1 AND sender_type = 'agent'`,
        [first.conversation_id]
      );
      return { ws, conn, first };
    }

    it('joins the ticket named by In-Reply-To', async () => {
      const { conn, first } = await threaded();
      const r = await receive(db(), conn, 'alice@example.org', 'r1@mail.test', { inReplyTo: 'out1@in.example.test', subject: 'Re: Something else entirely' });
      expect(r).toMatchObject({ created: false, matched_by: 'header', ticket_id: first.ticket_id });
    });

    it('joins by a References entry when In-Reply-To is missing', async () => {
      const { conn, first } = await threaded();
      const r = await receive(db(), conn, 'alice@example.org', 'r2@mail.test', { refs: ['unrelated@x.test', 'out1@in.example.test'] });
      expect(r).toMatchObject({ matched_by: 'header', ticket_id: first.ticket_id });
    });

    it('joins by the id the provider assigned when it replaced our Message-ID', async () => {
      const { ws, conn, first } = await threaded();
      await db().q(`UPDATE messages SET metadata = jsonb_build_object('email_provider_id', 'pm-uuid-1') WHERE channel_message_id = 'out1@in.example.test'`);
      const r = await receive(db(), conn, 'alice@example.org', 'r3@mail.test', { inReplyTo: 'pm-uuid-1@mtasv.net' });
      expect(r).toMatchObject({ matched_by: 'header', ticket_id: first.ticket_id });
      expect(ws.id).toBeTruthy();
    });

    it('joins by the verified ticket token when the headers are gone', async () => {
      const { conn, first } = await threaded();
      const r = await receive(db(), conn, 'alice@example.org', 'r4@mail.test', { token: first.ticket_number });
      expect(r).toMatchObject({ matched_by: 'token', ticket_id: first.ticket_id });
    });

    it('a colleague replying with the token joins the ticket and is added to CC', async () => {
      const { conn, first } = await threaded();
      await receive(db(), conn, 'colleague@example.org', 'r5@mail.test', { token: first.ticket_number, name: 'Col League' });
      const conv = await db().one<{ channel_user_id: string; channel_metadata: { email_cc: { email: string }[] } }>(
        'SELECT channel_user_id, channel_metadata FROM conversations WHERE id = $1',
        [first.conversation_id]
      );
      expect(conv.channel_user_id).toBe('alice@example.org'); // replies still go to the requester
      expect(conv.channel_metadata.email_cc.map((c) => c.email)).toEqual(['colleague@example.org']);
    });

    it('believes the subject reference only from the requester or someone already copied', async () => {
      const { conn, first } = await threaded();
      const own = await receive(db(), conn, 'ALICE@example.org', 's1@mail.test', { subjectRef: first.ticket_number });
      expect(own).toMatchObject({ matched_by: 'subject', ticket_id: first.ticket_id });

      const stranger = await receive(db(), conn, 'mallory@example.org', 's2@mail.test', { subjectRef: first.ticket_number, subject: 'Re: x [#' + first.ticket_number + ']' });
      expect(stranger.created).toBe(true);
      expect(stranger.ticket_id).not.toBe(first.ticket_id);
    });

    it('never joins a ticket of another workspace', async () => {
      const a = await threaded();
      const other = await createWorkspace(db());
      const otherConn = await connect(db(), other);
      const r = await receive(db(), otherConn, 'alice@example.org', 'x1@mail.test', { inReplyTo: 'out1@in.example.test', token: a.first.ticket_number, subjectRef: a.first.ticket_number });
      expect(r.created).toBe(true);
      expect(r.ticket_id).not.toBe(a.first.ticket_id);
    });

    it('a reply to a closed ticket opens a linked follow-up', async () => {
      const { ws, conn, first } = await threaded();
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'solved' WHERE id = $1`, [first.ticket_id]);
      await db().q(`UPDATE tickets SET status = 'closed' WHERE id = $1`, [first.ticket_id]);
      const r = await receive(db(), conn, 'alice@example.org', 'late@mail.test', { inReplyTo: 'out1@in.example.test' });
      expect(r.ticket_id).not.toBe(first.ticket_id);
      expect((await ticket(db(), r.ticket_id)).follow_up_of_id).toBe(first.ticket_id);
    });

    it('a reply to a solved ticket reopens it', async () => {
      const { ws, conn, first } = await threaded();
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'solved' WHERE id = $1`, [first.ticket_id]);
      await receive(db(), conn, 'alice@example.org', 'again@mail.test', { inReplyTo: 'out1@in.example.test' });
      expect((await ticket(db(), first.ticket_id)).status).toBe('open');
    });
  });

  describe('loops and bounces', () => {
    it('pauses a sender that mails more than 15 times in 10 minutes', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      for (let i = 0; i < 15; i++) await receive(db(), conn, 'robot@example.org', `bulk${i}@mail.test`, { subject: `Msg ${i}` });
      expect(await db().rejects({ kind: 'service' }, `SELECT fn_email_ingest_inbound($1, 'robot@example.org', NULL, 'bulk99@mail.test', NULL, '{}', NULL, NULL, 's', 'c', '[]', '{}', '[]', now())`, [conn])).toMatch(/Too many emails/);
    });

    it('a hard bounce fails the message, tells the agents and suppresses the address', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const r = await receive(db(), conn, 'ghost@example.org', 'g1@mail.test');
      await agentSays(db(), r.conversation_id, ws.agentId, 'Hello ghost');
      await db().q(`UPDATE messages SET channel_message_id = 'out-ghost@in.example.test' WHERE conversation_id = $1 AND sender_type = 'agent'`, [r.conversation_id]);

      const [{ r: out }] = await db().as<{ r: { matched: boolean; recipient: string } }>(
        { kind: 'service' },
        `SELECT fn_email_record_bounce($1, 'OUT-ghost@in.example.test', NULL, '550 5.1.1 unknown user', true) AS r`,
        [conn]
      );
      expect(out).toMatchObject({ matched: true, recipient: 'ghost@example.org' });
      const failed = await db().one<{ channel_status: string; channel_error: string }>(
        `SELECT channel_status, channel_error FROM messages WHERE channel_message_id = 'out-ghost@in.example.test'`
      );
      expect(failed).toEqual({ channel_status: 'failed', channel_error: '550 5.1.1 unknown user' });
      expect(await db().q(`SELECT 1 FROM messages WHERE conversation_id = $1 AND is_internal AND content LIKE 'Email to ghost@example.org bounced%'`, [r.conversation_id])).toHaveLength(1);
      expect(await db().q('SELECT 1 FROM email_suppressions WHERE workspace_id = $1 AND email = $2', [ws.id, 'ghost@example.org'])).toHaveLength(1);
    });

    it('a soft bounce does not suppress the address', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      await db().as({ kind: 'service' }, `SELECT fn_email_record_bounce($1, NULL, 'full@example.org', 'mailbox full', false)`, [conn]);
      expect(await db().q('SELECT 1 FROM email_suppressions WHERE workspace_id = $1', [ws.id])).toHaveLength(0);
    });

    it('never suppresses the workspace’s own address', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws, 'self@in.example.test');
      await db().as({ kind: 'service' }, `SELECT fn_email_record_bounce($1, NULL, 'self@in.example.test', 'loop', true)`, [conn]);
      expect(await db().q('SELECT 1 FROM email_suppressions WHERE workspace_id = $1', [ws.id])).toHaveLength(0);
    });
  });

  describe('sending', () => {
    it('queues an agent reply on an email conversation for the outbound worker', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const r = await receive(db(), conn, 'a@example.org', 'q1@mail.test');
      await agentSays(db(), r.conversation_id, ws.agentId, 'On it.');
      const q = await db().q<{ channel: string; status: string }>('SELECT channel, status FROM channel_outbound_queue WHERE conversation_id = $1', [r.conversation_id]);
      expect(q).toEqual([{ channel: 'email', status: 'queued' }]);
    });

    it('does not queue internal notes, and leaves hand-logged email tickets on the SMTP path', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      const r = await receive(db(), conn, 'a@example.org', 'q2@mail.test');
      await agentSays(db(), r.conversation_id, ws.agentId, 'Private', true);
      expect(await db().q('SELECT 1 FROM channel_outbound_queue WHERE conversation_id = $1', [r.conversation_id])).toHaveLength(0);

      const [manual] = await db().q<{ id: string }>(
        `INSERT INTO conversations (workspace_id, visitor_id, status, channel, channel_metadata)
         VALUES ($1, $2, 'open', 'web', '{"ticket_channel":"email","ticket_subject":"Logged by hand"}') RETURNING id`,
        [ws.id, ws.visitorId]
      );
      await db().q(`INSERT INTO messages (conversation_id, sender_type, content) VALUES ($1, 'visitor', 'hello')`, [manual.id]);
      await agentSays(db(), manual.id, ws.agentId, 'Reply by SMTP');
      expect(await db().q('SELECT 1 FROM channel_outbound_queue WHERE conversation_id = $1', [manual.id])).toHaveLength(0);
    });
  });

  describe('requester notifications as trigger actions', () => {
    async function withRules() {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      await db().q('DELETE FROM automation_rules WHERE workspace_id = $1', [ws.id]);
      await db().as({ kind: 'service' }, 'SELECT fn_install_email_notification_rules($1)', [ws.id]);
      return { ws, conn };
    }

    it('installs three rules once, with the chat-reply one switched off', async () => {
      const { ws } = await withRules();
      await db().as({ kind: 'service' }, 'SELECT fn_install_email_notification_rules($1)', [ws.id]);
      const rules = await db().q<{ name: string; is_active: boolean }>('SELECT name, is_active FROM automation_rules WHERE workspace_id = $1 ORDER BY position', [ws.id]);
      expect(rules).toHaveLength(3);
      expect(rules.map((r) => r.is_active)).toEqual([true, true, false]);
    });

    it('queues "received" for a new email ticket, and "solved" when it is solved', async () => {
      const { ws, conn } = await withRules();
      const r = await receive(db(), conn, 'alice@example.org', 'n1@mail.test', { name: 'Alice Example', subject: 'Cannot log in' });
      const rows = () => db().q<{ payload: Record<string, unknown> }>(`SELECT payload FROM automation_outbox WHERE ticket_id = $1 ORDER BY created_at`, [r.ticket_id]);
      expect((await rows()).map((o) => o.payload.template)).toEqual(['received']);
      expect((await rows())[0].payload).toMatchObject({ to: 'alice@example.org', requester_name: 'Alice Example', ticket_number: r.ticket_number, ticket_subject: 'Cannot log in' });

      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'solved' WHERE id = $1`, [r.ticket_id]);
      expect((await rows()).map((o) => o.payload.template)).toEqual(['received', 'solved']);
    });

    it('does not send "received" for a ticket an agent logged by hand', async () => {
      const { ws } = await withRules();
      const [conv] = await db().q<{ id: string }>(
        `INSERT INTO conversations (workspace_id, visitor_id, status, channel, channel_metadata)
         VALUES ($1, $2, 'open', 'web', '{"ticket_channel":"email","ticket_subject":"Logged"}') RETURNING id`,
        [ws.id, ws.visitorId]
      );
      await db().q(`UPDATE visitors SET email = 'cust@example.org' WHERE id = $1`, [ws.visitorId]);
      await db().q(`INSERT INTO messages (conversation_id, sender_type, content, metadata) VALUES ($1, 'visitor', 'hi', '{"logged_by_agent_id":"x"}')`, [conv.id]);
      expect(await db().q('SELECT 1 FROM automation_outbox WHERE workspace_id = $1', [ws.id])).toHaveLength(0);
    });

    it('sends nothing when the email channel is not connected', async () => {
      const ws = await createWorkspace(db());
      await db().q('DELETE FROM automation_rules WHERE workspace_id = $1', [ws.id]);
      await db().q(
        `INSERT INTO automation_rules (workspace_id, kind, name, conditions, actions)
         VALUES ($1, 'trigger', 'n', '[{"field":"changed","op":"is","value":"created"}]', '[{"type":"notify_requester","value":"received"}]')`,
        [ws.id]
      );
      await db().q(`UPDATE visitors SET email = 'cust@example.org' WHERE id = $1`, [ws.visitorId]);
      const [conv] = await db().q<{ id: string }>(`INSERT INTO conversations (workspace_id, visitor_id, status, channel) VALUES ($1, $2, 'open', 'web') RETURNING id`, [ws.id, ws.visitorId]);
      await db().q(`INSERT INTO messages (conversation_id, sender_type, content) VALUES ($1, 'visitor', 'hi')`, [conv.id]);
      expect(await db().q('SELECT 1 FROM automation_outbox WHERE workspace_id = $1', [ws.id])).toHaveLength(0);
    });

    it('rejects an unknown notification and keeps the action out of macros', async () => {
      const ws = await createWorkspace(db());
      const admin = { kind: 'user' as const, id: ws.adminId };
      expect(
        await db().rejects(admin, `INSERT INTO automation_rules (workspace_id, kind, name, conditions, actions) VALUES ($1, 'trigger', 'x', '[{"field":"status","op":"is","value":"open"}]', '[{"type":"notify_requester","value":"spam"}]')`, [ws.id])
      ).toMatch(/Choose which notification/);
      expect(await db().rejects(admin, `INSERT INTO macros (workspace_id, title, content, actions) VALUES ($1, 't', 'c', '[{"type":"notify_requester","value":"solved"}]')`, [ws.id])).toMatch(/not allowed/);
    });
  });

  describe('access', () => {
    it('only owners and admins read the inbound log and the suppression list', async () => {
      const ws = await createWorkspace(db());
      await db().q(`INSERT INTO email_inbound_log (workspace_id, outcome, detail) VALUES ($1, 'ignored_auto_reply', 'x')`, [ws.id]);
      await db().q(`INSERT INTO email_suppressions (workspace_id, email) VALUES ($1, 'x@y.test')`, [ws.id]);
      for (const table of ['email_inbound_log', 'email_suppressions']) {
        expect(await db().as({ kind: 'user', id: ws.adminId }, `SELECT 1 FROM ${table}`)).toHaveLength(1);
        expect(await db().as({ kind: 'user', id: ws.agentId }, `SELECT 1 FROM ${table}`)).toHaveLength(0);
        expect(await db().as({ kind: 'anon' }, `SELECT 1 FROM ${table}`)).toHaveLength(0);
      }
      expect(await db().rejects({ kind: 'user', id: ws.adminId }, `INSERT INTO email_inbound_log (workspace_id, outcome) VALUES ($1, 'failed')`, [ws.id])).toMatch(/row-level security|permission denied/);
      await db().as({ kind: 'user', id: ws.adminId }, `DELETE FROM email_suppressions WHERE email = 'x@y.test'`);
      expect(await db().q('SELECT 1 FROM email_suppressions')).toHaveLength(0);
    });

    it('the ingest function cannot be called by a signed-in user', async () => {
      const ws = await createWorkspace(db());
      const conn = await connect(db(), ws);
      expect(await db().rejects({ kind: 'user', id: ws.adminId }, `SELECT fn_email_ingest_inbound($1, 'a@b.test', NULL, 'm@x', NULL, '{}', NULL, NULL, 's', 'c', '[]', '{}', '[]', now())`, [conn])).toMatch(/permission denied/);
    });
  });
});
