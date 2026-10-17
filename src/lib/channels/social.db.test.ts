/**
 * What the database does for X, LinkedIn, TikTok and Threads
 * (supabase/migrations/20261017090000_social_channels.sql): tickets accept
 * the new channels, a person's public posts and direct messages are separate
 * tickets (so a reply cannot cross from one to the other), public items are
 * stored once however often a poll or webhook repeats them, and replies are
 * queued for the outbound worker. Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { agentSays, createWorkspace, hasDatabase, ticketOf, useTestDatabase, type Db, type WorkspaceFixture } from '@/test/db';

const CHANNELS = ['x', 'threads', 'linkedin', 'tiktok'] as const;

async function connect(db: Db, ws: WorkspaceFixture, channel: string, account = `acct-${channel}-${ws.id.slice(0, 6)}`): Promise<string> {
  const { id } = await db.one<{ id: string }>(
    `INSERT INTO channel_connections (workspace_id, channel, status, external_account_id, display_name)
     VALUES ($1, $2, 'connected', $3, 'test') RETURNING id`,
    [ws.id, channel, account]
  );
  return id;
}

interface Ingested extends Record<string, unknown> {
  duplicate: boolean;
  conversation_id: string;
  message_id: string;
}

async function ingest(db: Db, connectionId: string, sender: string, externalId: string, text: string, metadata: Record<string, unknown> = {}) {
  const [row] = await db.as<{ r: Ingested }>(
    { kind: 'service' },
    `SELECT fn_channel_ingest_inbound($1, $2, 'Dana', $3, $4, NULL, $5::jsonb, now()) AS r`,
    [connectionId, sender, externalId, text, JSON.stringify(metadata)]
  );
  return row.r;
}

const publicItem = (itemId: string) => ({ channel_public: { kind: 'mention', itemId, rootId: itemId } });

describe.skipIf(!hasDatabase)('social channels (database)', () => {
  const { db } = useTestDatabase();

  it.each(CHANNELS)('opens a %s ticket for a first item', async (channel) => {
    const ws = await createWorkspace(db());
    const conn = await connect(db(), ws, channel);
    const r = await ingest(db(), conn, 'pub:9001', `${channel}:item:1`, 'Where is my order?\nIt has been two weeks.', publicItem('1'));
    const t = await ticketOf(db(), r.conversation_id);
    expect(t).toMatchObject({ channel, subject: 'Where is my order?', status: 'new' });
    const msg = await db().one<{ metadata: { channel_public: { itemId: string } } }>('SELECT metadata FROM messages WHERE id = $1', [r.message_id]);
    expect(msg.metadata.channel_public.itemId).toBe('1');
  });

  it('still rejects a channel nobody has an adapter for', async () => {
    const ws = await createWorkspace(db());
    expect(await db().rejects({ kind: 'superuser' }, `INSERT INTO tickets (workspace_id, subject, channel) VALUES ($1, 'x', 'myspace')`, [ws.id])).toMatch(/tickets_channel_check/);
  });

  it('keeps a person’s public posts and direct messages in separate tickets', async () => {
    const ws = await createWorkspace(db());
    const conn = await connect(db(), ws, 'x');
    const dm = await ingest(db(), conn, '9001', 'x:dm:1', 'Private question');
    const pub = await ingest(db(), conn, 'pub:9001', 'x:tweet:2', 'Public complaint', publicItem('2'));
    const pub2 = await ingest(db(), conn, 'pub:9001', 'x:tweet:3', 'Another public post', publicItem('3'));
    expect(dm.conversation_id).not.toBe(pub.conversation_id);
    expect(pub2.conversation_id).toBe(pub.conversation_id);
    const convs = await db().q<{ channel_user_id: string }>('SELECT channel_user_id FROM conversations WHERE id = ANY($1) ORDER BY channel_user_id', [[dm.conversation_id, pub.conversation_id]]);
    expect(convs.map((c) => c.channel_user_id)).toEqual(['9001', 'pub:9001']);
    const tickets = await db().q('SELECT id FROM tickets WHERE workspace_id = $1', [ws.id]);
    expect(tickets).toHaveLength(2);
  });

  it('stores an item once however many times a poll or webhook repeats it', async () => {
    const ws = await createWorkspace(db());
    const conn = await connect(db(), ws, 'threads');
    const first = await ingest(db(), conn, 'pub:jo_k', 'threads:100', 'Does this ship to Canada?', publicItem('100'));
    const again = await ingest(db(), conn, 'pub:jo_k', 'threads:100', 'Does this ship to Canada?', publicItem('100'));
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.message_id).toBe(first.message_id);
    expect(await db().q('SELECT 1 FROM messages WHERE channel_message_id = $1', ['threads:100'])).toHaveLength(1);
  });

  it('does not let one workspace’s account receive another’s items', async () => {
    const a = await createWorkspace(db());
    const b = await createWorkspace(db());
    const connA = await connect(db(), a, 'linkedin', '5555');
    // One Page feeds one workspace, or inbound routing would be ambiguous.
    expect(
      await db().rejects(
        { kind: 'superuser' },
        `INSERT INTO channel_connections (workspace_id, channel, status, external_account_id) VALUES ($1, 'linkedin', 'connected', '5555')`,
        [b.id]
      )
    ).toMatch(/channel_connections_account_key/);
    const r = await ingest(db(), connA, 'pub:urn:li:person:1', 'linkedin:c1', 'Hello', publicItem('c1'));
    const t = await ticketOf(db(), r.conversation_id);
    expect(await db().one('SELECT workspace_id FROM tickets WHERE id = $1', [t.id])).toMatchObject({ workspace_id: a.id });
  });

  it('queues an agent’s reply for the outbound worker, with no service window', async () => {
    const ws = await createWorkspace(db());
    const conn = await connect(db(), ws, 'x');
    const r = await ingest(db(), conn, 'pub:9002', 'x:tweet:7', '@acme still waiting', publicItem('7'));
    // Days later: a public channel has no 24-hour rule.
    await db().q(`UPDATE conversations SET channel_last_inbound_at = now() - interval '9 days' WHERE id = $1`, [r.conversation_id]);
    await agentSays(db(), r.conversation_id, ws.agentId, 'Sorry about that, it ships today.');
    const sent = await db().one<{ channel_status: string }>(
      `SELECT channel_status FROM messages WHERE conversation_id = $1 AND sender_type = 'agent'`,
      [r.conversation_id]
    );
    expect(sent.channel_status).toBe('queued');
    const queued = await db().q<{ channel: string; status: string }>('SELECT channel, status FROM channel_outbound_queue WHERE conversation_id = $1', [r.conversation_id]);
    expect(queued).toEqual([{ channel: 'x', status: 'queued' }]);
  });

  it('does not queue an internal note', async () => {
    const ws = await createWorkspace(db());
    const conn = await connect(db(), ws, 'tiktok');
    const r = await ingest(db(), conn, 'pub:u1', 'tiktok:c1', 'Nice', publicItem('c1'));
    await agentSays(db(), r.conversation_id, ws.agentId, 'Check with the shop first', true);
    expect(await db().q('SELECT 1 FROM channel_outbound_queue WHERE conversation_id = $1', [r.conversation_id])).toHaveLength(0);
  });
});
