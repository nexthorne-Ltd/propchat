/**
 * Instagram's rules in the database (supabase/migrations/20261012090000_instagram_channel.sql):
 * DMs and story messages become Instagram tickets, and replies are allowed
 * for 24 hours, or 7 days for a person when Human Agent is enabled.
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { createWorkspace, hasDatabase, ticketOf, useTestDatabase, type Db, type WorkspaceFixture } from '@/test/db';

async function connect(db: Db, ws: WorkspaceFixture, humanAgent = false): Promise<string> {
  const { id } = await db.one<{ id: string }>(
    `INSERT INTO channel_connections (workspace_id, channel, status, external_account_id, display_name, settings)
     VALUES ($1, 'instagram', 'connected', $2, '@acme', $3) RETURNING id`,
    [ws.id, `ig-${ws.id.slice(0, 8)}`, JSON.stringify({ human_agent: humanAgent })]
  );
  return id;
}

async function dm(db: Db, connectionId: string, mid: string, text: string, at = 'now()', meta = '{}') {
  const [row] = await db.as<{ r: { conversation_id: string; ticket_id: string; duplicate: boolean } }>(
    { kind: 'service' },
    `SELECT fn_channel_ingest_inbound($1, '17841400000000001', NULL, $2, $3, NULL, $4::jsonb, ${at}) AS r`,
    [connectionId, mid, text, meta]
  );
  return row.r;
}

const reply = (db: Db, ws: WorkspaceFixture, conversationId: string, text: string) =>
  db.as(
    { kind: 'user', id: ws.agentId },
    `INSERT INTO messages (conversation_id, sender_type, sender_id, content) VALUES ($1, 'agent', $2, $3) RETURNING metadata`,
    [conversationId, ws.agentId, text]
  );

describe.skipIf(!hasDatabase)('instagram channel (database)', () => {
  const { db } = useTestDatabase();

  it('turns a DM into an Instagram ticket and ignores the retried webhook', async () => {
    const ws = await createWorkspace(db());
    const conn = await connect(db(), ws);
    const r = await dm(db(), conn, 'aWdfZAG1faWQ1', 'Is the blue one in stock?');
    expect(await ticketOf(db(), r.conversation_id)).toMatchObject({ channel: 'instagram', subject: 'Is the blue one in stock?' });
    expect((await dm(db(), conn, 'aWdfZAG1faWQ1', 'Is the blue one in stock?')).duplicate).toBe(true);
  });

  it('keeps the story context on a story reply', async () => {
    const ws = await createWorkspace(db());
    const conn = await connect(db(), ws);
    const meta = JSON.stringify({ channel_type: 'story_reply', channel_story: { kind: 'reply', id: '1789', url: 'https://cdn.example/story.jpg' } });
    const r = await dm(db(), conn, 'mid.story1', 'Love this!', 'now()', meta);
    const m = await db().one<{ metadata: Record<string, unknown> }>('SELECT metadata FROM messages WHERE conversation_id = $1', [r.conversation_id]);
    expect(m.metadata.channel_story).toEqual({ kind: 'reply', id: '1789', url: 'https://cdn.example/story.jpg' });
  });

  it('queues an in-window reply without a tag', async () => {
    const ws = await createWorkspace(db());
    const conn = await connect(db(), ws);
    const r = await dm(db(), conn, 'mid.w1', 'hi');
    const [row] = await reply(db(), ws, r.conversation_id, 'Hello!');
    expect(row.metadata).toBeNull();
    const [{ n }] = await db().q<{ n: string }>('SELECT count(*) AS n FROM channel_outbound_queue WHERE conversation_id = $1', [r.conversation_id]);
    expect(Number(n)).toBe(1);
  });

  it('refuses replies after 24 hours without Human Agent', async () => {
    const ws = await createWorkspace(db());
    const conn = await connect(db(), ws);
    const r = await dm(db(), conn, 'mid.c1', 'hi', `now() - interval '25 hours'`);
    const err = await db().rejects(
      { kind: 'user', id: ws.agentId },
      `INSERT INTO messages (conversation_id, sender_type, sender_id, content) VALUES ($1, 'agent', $2, 'late')`,
      [r.conversation_id, ws.agentId]
    );
    expect(err).toMatch(/Instagram no longer allows a reply/);
  });

  it('lets a person reply for 7 days with Human Agent, tagged; never the bot; never after 7 days', async () => {
    const ws = await createWorkspace(db());
    const conn = await connect(db(), ws, true);
    const r = await dm(db(), conn, 'mid.h1', 'hi', `now() - interval '3 days'`);
    const [row] = await reply(db(), ws, r.conversation_id, 'Sorry for the wait');
    expect(row.metadata).toEqual({ channel_tag: 'HUMAN_AGENT' });
    expect(
      await db().rejects({ kind: 'service' }, `INSERT INTO messages (conversation_id, sender_type, content) VALUES ($1, 'ai', 'bot')`, [r.conversation_id])
    ).toMatch(/Instagram no longer allows/);

    const ws2 = await createWorkspace(db());
    const conn2 = await connect(db(), ws2, true);
    const r2 = await dm(db(), conn2, 'mid.h3', 'hi', `now() - interval '8 days'`);
    expect(
      await db().rejects(
        { kind: 'user', id: ws2.agentId },
        `INSERT INTO messages (conversation_id, sender_type, sender_id, content) VALUES ($1, 'agent', $2, 'too late')`,
        [r2.conversation_id, ws2.agentId]
      )
    ).toMatch(/Instagram no longer allows/);
  });
});
