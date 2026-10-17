/**
 * Team chat (20261118090000_team_chat.sql): who can read and write what.
 *
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { createWorkspace, hasDatabase, startChat, useTestDatabase, type WorkspaceFixture } from '@/test/db';

const as = (id: string) => ({ kind: 'user', id }) as const;

describe.skipIf(!hasDatabase)('team chat (database)', () => {
  const { db } = useTestDatabase();

  const general = async (ws: WorkspaceFixture, who = ws.agentId) =>
    (await db().as<{ id: string }>(as(who), 'SELECT fn_team_general($1) AS id', [ws.id]))[0].id;
  const direct = async (ws: WorkspaceFixture, me: string, other: string) =>
    (await db().as<{ id: string }>(as(me), 'SELECT fn_team_open_direct($1, $2) AS id', [ws.id, other]))[0].id;
  const send = (who: string, thread: string, content: string, extra: { conversation_id?: string; mentions?: string[] } = {}) =>
    db().as(
      as(who),
      'INSERT INTO team_messages (thread_id, sender_id, content, conversation_id, mentions, workspace_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      // workspace_id is filled in by the trigger; any value here is replaced.
      [thread, who, content, extra.conversation_id ?? null, extra.mentions ?? [], '00000000-0000-0000-0000-000000000000']
    );
  const read = (who: string, thread: string) =>
    db().as<{ content: string }>(as(who), 'SELECT content FROM team_messages WHERE thread_id = $1 ORDER BY created_at', [thread]);

  it('the whole team shares one General channel', async () => {
    const ws = await createWorkspace(db());
    const a = await general(ws, ws.agentId);
    const b = await general(ws, ws.ownerId);
    expect(a).toBe(b);
    await send(ws.agentId, a, 'Anyone know the refund rule for Step 2?');
    expect((await read(ws.adminId, a)).map((m) => m.content)).toEqual(['Anyone know the refund rule for Step 2?']);
  });

  it('a direct thread is private to its two people', async () => {
    const ws = await createWorkspace(db());
    const dm = await direct(ws, ws.agentId, ws.adminId);
    expect(await direct(ws, ws.adminId, ws.agentId)).toBe(dm);
    await send(ws.agentId, dm, 'Can you check ticket 1042?');
    expect(await read(ws.adminId, dm)).toHaveLength(1);
    expect(await read(ws.ownerId, dm)).toHaveLength(0);
    expect(await db().rejects(as(ws.ownerId), 'INSERT INTO team_messages (thread_id, sender_id, content, workspace_id) VALUES ($1, $2, $3, $4)', [
      dm,
      ws.ownerId,
      'sneaking in',
      ws.id,
    ])).toMatch(/row-level security/);
  });

  it('another workspace sees nothing and cannot open a thread here', async () => {
    const ws = await createWorkspace(db());
    const other = await createWorkspace(db());
    const g = await general(ws);
    await send(ws.agentId, g, 'internal');
    expect(await read(other.agentId, g)).toHaveLength(0);
    expect(await db().rejects(as(other.agentId), 'SELECT fn_team_general($1)', [ws.id])).toMatch(/not a member/);
    expect(await db().rejects(as(ws.agentId), 'SELECT fn_team_open_direct($1, $2)', [ws.id, other.agentId])).toMatch(/not on this team/);
  });

  it('nobody writes as someone else, and a deactivated member is out', async () => {
    const ws = await createWorkspace(db());
    const g = await general(ws);
    expect(
      await db().rejects(as(ws.agentId), 'INSERT INTO team_messages (thread_id, sender_id, content, workspace_id) VALUES ($1, $2, $3, $4)', [
        g,
        ws.adminId,
        'forged',
        ws.id,
      ])
    ).toMatch(/row-level security/);
    await db().q('UPDATE agents SET is_active = false WHERE id = $1', [ws.agentId]);
    expect(await read(ws.agentId, g)).toHaveLength(0);
  });

  it('a shared customer chat must be from the same workspace; mentions only of the team', async () => {
    const ws = await createWorkspace(db());
    const other = await createWorkspace(db());
    const { conversationId: mine } = await startChat(db(), ws, 'Where is my payout?');
    const { conversationId: theirs } = await startChat(db(), other, 'Hello');
    const g = await general(ws);
    const [ok] = await send(ws.agentId, g, 'Look at this one', { conversation_id: mine, mentions: [ws.adminId, other.agentId] });
    expect(ok.conversation_id).toBe(mine);
    expect(ok.mentions).toEqual([ws.adminId]);
    expect(ok.workspace_id).toBe(ws.id);
    const [dropped] = await send(ws.agentId, g, 'And this', { conversation_id: theirs });
    expect(dropped.conversation_id).toBeNull();
  });

  it('counts unread and mentions per person, and reading clears them', async () => {
    const ws = await createWorkspace(db());
    const g = await general(ws);
    const dm = await direct(ws, ws.agentId, ws.adminId);
    await db().as(as(ws.adminId), 'SELECT fn_team_mark_read($1)', [g]);
    await db().q(`UPDATE team_thread_members SET last_read_at = now() - interval '1 minute'`);
    await db().q(`UPDATE team_messages SET created_at = now() - interval '2 minutes'`);
    await send(ws.agentId, g, 'Heads up @admin', { mentions: [ws.adminId] });
    await send(ws.agentId, dm, 'Ping');

    type Row = { thread_id: string; kind: string; other_agent_id: string | null; unread: number; mentions_me: number };
    const inbox = await db().as<Row>(as(ws.adminId), 'SELECT * FROM fn_team_inbox($1)', [ws.id]);
    const channel = inbox.find((r) => r.thread_id === g)!;
    const dmRow = inbox.find((r) => r.thread_id === dm)!;
    expect(channel).toMatchObject({ kind: 'channel', unread: 1, mentions_me: 1 });
    expect(dmRow).toMatchObject({ kind: 'direct', other_agent_id: ws.agentId, unread: 1 });

    // The sender's own messages are never unread for them.
    const senderInbox = await db().as<Row>(as(ws.agentId), 'SELECT * FROM fn_team_inbox($1)', [ws.id]);
    expect(senderInbox.every((r) => r.unread === 0)).toBe(true);

    await db().q(`UPDATE team_messages SET created_at = now() - interval '5 seconds'`);
    await db().as(as(ws.adminId), 'SELECT fn_team_mark_read($1)', [g]);
    const after = await db().as<Row>(as(ws.adminId), 'SELECT * FROM fn_team_inbox($1)', [ws.id]);
    expect(after.find((r) => r.thread_id === g)?.unread).toBe(0);
  });

  it('only the sender can take a message back', async () => {
    const ws = await createWorkspace(db());
    const g = await general(ws);
    const [msg] = await send(ws.agentId, g, 'oops');
    expect(await db().rejects(as(ws.adminId), 'SELECT fn_team_delete_message($1)', [msg.id])).toMatch(/cannot be deleted/);
    await db().as(as(ws.agentId), 'SELECT fn_team_delete_message($1)', [msg.id]);
    expect((await read(ws.adminId, g))[0].content).toBe('…');
  });

  it('is closed to the widget', async () => {
    const ws = await createWorkspace(db());
    expect(await db().rejects({ kind: 'anon' }, 'SELECT fn_team_general($1)', [ws.id])).toMatch(/permission denied/);
    expect(await db().attempt({ kind: 'anon' }, 'SELECT * FROM team_messages')).toEqual([]);
  });
});
