/**
 * fn_inbox_summaries (20261117090000_inbox_speed.sql): the inbox list's last
 * message and unread count per conversation, in one small query, and only
 * for conversations the caller may read.
 *
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { agentSays, createWorkspace, hasDatabase, startChat, useTestDatabase, visitorSays } from '@/test/db';

type Summary = { conversation_id: string; last_message: { content: string } | null; unread_count: number; has_visitor_message: boolean };

describe.skipIf(!hasDatabase)('inbox summaries (database)', () => {
  const { db } = useTestDatabase();

  it('gives the newest message, unread visitor messages and whether the visitor spoke', async () => {
    const ws = await createWorkspace(db());
    const { conversationId } = await startChat(db(), ws, 'Hello');
    await visitorSays(db(), conversationId, 'Are you there?');
    await agentSays(db(), conversationId, ws.agentId, 'Yes, how can I help?');
    // now() is fixed within the test's transaction; give the reply its own moment.
    await db().q(`UPDATE messages SET created_at = now() + interval '1 second' WHERE conversation_id = $1 AND sender_type = 'agent'`, [
      conversationId,
    ]);

    const rows = await db().as<Summary>({ kind: 'user', id: ws.agentId }, 'SELECT * FROM fn_inbox_summaries($1)', [[conversationId]]);
    expect(rows).toHaveLength(1);
    expect(rows[0].last_message?.content).toBe('Yes, how can I help?');
    expect(rows[0].unread_count).toBe(2);
    expect(rows[0].has_visitor_message).toBe(true);
  });

  it("shows nothing of another workspace's conversation", async () => {
    const ws = await createWorkspace(db());
    const other = await createWorkspace(db());
    const { conversationId } = await startChat(db(), ws, 'Private question');

    const rows = await db().as<Summary>({ kind: 'user', id: other.agentId }, 'SELECT * FROM fn_inbox_summaries($1)', [[conversationId]]);
    expect(rows[0].last_message).toBeNull();
    expect(rows[0].unread_count).toBe(0);
    expect(rows[0].has_visitor_message).toBe(false);
  });

  it('is closed to the widget', async () => {
    expect(await db().rejects({ kind: 'anon' }, 'SELECT * FROM fn_inbox_summaries($1)', [[]])).toMatch(/permission denied/);
  });
});
