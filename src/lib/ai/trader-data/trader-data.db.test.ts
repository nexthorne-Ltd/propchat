/**
 * The trader data tables (20261120090000_trader_data_lookup.sql) hold an
 * endpoint key and verification state: no visitor and no member may read or
 * write them, only the service role.
 *
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { createWorkspace, hasDatabase, startChat, useTestDatabase } from '@/test/db';

describe.skipIf(!hasDatabase)('trader data tables (database)', () => {
  const { db } = useTestDatabase();

  async function fixture() {
    const ws = await createWorkspace(db());
    const { conversationId } = await startChat(db(), ws, 'mera account breach kyun hua?');
    await db().q(`INSERT INTO trader_data_connections (workspace_id, enabled, kind, url, secret_encrypted) VALUES ($1, true, 'supabase', 'https://x.example.com', 'v1:secret')`, [ws.id]);
    await db().q(
      `INSERT INTO trader_identity_verifications (workspace_id, conversation_id, status, email, code_hash) VALUES ($1, $2, 'awaiting_code', 'ali@x.com', 'hash')`,
      [ws.id, conversationId]
    );
    return { ws, conversationId };
  }

  it('anon and every member role see nothing', async () => {
    const { ws } = await fixture();
    for (const actor of [{ kind: 'anon' as const }, { kind: 'user' as const, id: ws.ownerId }, { kind: 'user' as const, id: ws.agentId }]) {
      expect(await db().as(actor, 'SELECT * FROM trader_data_connections')).toEqual([]);
      expect(await db().as(actor, 'SELECT * FROM trader_identity_verifications')).toEqual([]);
    }
  });

  it('members cannot write them', async () => {
    const { ws } = await fixture();
    await db().attempt({ kind: 'user', id: ws.ownerId }, `UPDATE trader_data_connections SET url = 'https://evil.example.com'`);
    await db().attempt({ kind: 'user', id: ws.ownerId }, `UPDATE trader_identity_verifications SET status = 'verified'`);
    expect(await db().one(`SELECT url FROM trader_data_connections WHERE workspace_id = $1`, [ws.id])).toEqual({ url: 'https://x.example.com' });
    expect(await db().one(`SELECT status FROM trader_identity_verifications WHERE workspace_id = $1`, [ws.id])).toEqual({ status: 'awaiting_code' });
  });

  it('the service role reads them; one verification per conversation', async () => {
    const { ws, conversationId } = await fixture();
    expect(await db().as({ kind: 'service' }, 'SELECT secret_encrypted FROM trader_data_connections WHERE workspace_id = $1', [ws.id])).toEqual([{ secret_encrypted: 'v1:secret' }]);
    await expect(
      db().q(`INSERT INTO trader_identity_verifications (workspace_id, conversation_id) VALUES ($1, $2)`, [ws.id, conversationId])
    ).rejects.toThrow(/duplicate|unique/i);
  });
});
