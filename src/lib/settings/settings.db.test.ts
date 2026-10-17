/**
 * Notification preferences and the workspace audit log. Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { createWorkspace, hasDatabase, useTestDatabase } from '@/test/db';

describe.skipIf(!hasDatabase)('settings hub (database)', () => {
  const { db } = useTestDatabase();

  // The test schema stubs production's workspace policies and has no UPDATE
  // one. Production lets owners and admins update their workspace through RLS;
  // this stand-in (rolled back with the test) does the same.
  async function allowAdminsToUpdateWorkspaces() {
    await db().q(
      `CREATE POLICY test_admin_update ON workspaces FOR UPDATE TO authenticated
         USING (fn_role_can(id, 'manage_settings')) WITH CHECK (fn_role_can(id, 'manage_settings'))`
    );
  }

  describe('notification preferences', () => {
    it('an agent reads and writes only their own row', async () => {
      const ws = await createWorkspace(db());
      const me = { kind: 'user' as const, id: ws.agentId };
      const other = { kind: 'user' as const, id: ws.adminId };

      await db().as(
        me,
        `INSERT INTO agent_notification_preferences (agent_id, workspace_id, email) VALUES ($1, $2, '{"assigned": true}')`,
        [ws.agentId, ws.id]
      );
      expect(await db().as(me, 'SELECT 1 FROM agent_notification_preferences')).toHaveLength(1);
      expect(await db().as(other, 'SELECT 1 FROM agent_notification_preferences')).toHaveLength(0);
      expect(
        await db().rejects(
          other,
          `INSERT INTO agent_notification_preferences (agent_id, workspace_id) VALUES ($1, $2)`,
          [ws.agentId, ws.id]
        )
      ).toMatch(/row-level security/);
    });

    it('a deactivated agent cannot save preferences', async () => {
      const ws = await createWorkspace(db());
      await db().q('UPDATE agents SET is_active = false WHERE id = $1', [ws.agentId]);
      expect(
        await db().rejects(
          { kind: 'user', id: ws.agentId },
          `INSERT INTO agent_notification_preferences (agent_id, workspace_id) VALUES ($1, $2)`,
          [ws.agentId, ws.id]
        )
      ).toMatch(/row-level security/);
    });

    it('rejects preferences that are not JSON objects', async () => {
      const ws = await createWorkspace(db());
      expect(
        await db().rejects(
          { kind: 'user', id: ws.agentId },
          `INSERT INTO agent_notification_preferences (agent_id, workspace_id, email) VALUES ($1, $2, '[1]')`,
          [ws.agentId, ws.id]
        )
      ).toMatch(/notification_prefs_email_object/);
    });
  });

  describe('workspace audit log', () => {
    it('records which fields an admin changed, never the values', async () => {
      const ws = await createWorkspace(db());
      await allowAdminsToUpdateWorkspaces();
      await db().as(
        { kind: 'user', id: ws.adminId },
        `UPDATE workspaces SET timezone = 'Asia/Karachi', ai_settings = '{"api_key": "sk-secret"}' WHERE id = $1`,
        [ws.id]
      );
      const rows = await db().q<{ action: string; details: { fields: string[] }; actor_id: string }>(
        'SELECT action, details, actor_id FROM workspace_audit_logs WHERE workspace_id = $1',
        [ws.id]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('workspace.updated');
      expect(rows[0].actor_id).toBe(ws.adminId);
      expect(rows[0].details.fields).toEqual(['ai_settings', 'timezone']);
      expect(JSON.stringify(rows[0].details)).not.toContain('sk-secret');
    });

    it('ignores machine writes with no signed-in user', async () => {
      const ws = await createWorkspace(db());
      await db().as({ kind: 'service' }, `UPDATE workspaces SET timezone = 'UTC' WHERE id = $1`, [ws.id]);
      expect(await db().q('SELECT 1 FROM workspace_audit_logs WHERE workspace_id = $1', [ws.id])).toHaveLength(0);
    });

    it('is readable by owners and admins only, and nobody can edit it', async () => {
      const ws = await createWorkspace(db());
      await allowAdminsToUpdateWorkspaces();
      await db().as({ kind: 'user', id: ws.adminId }, `UPDATE workspaces SET language = 'ur' WHERE id = $1`, [ws.id]);

      const read = (id: string) => db().as({ kind: 'user', id }, 'SELECT 1 FROM workspace_audit_logs');
      expect(await read(ws.ownerId)).toHaveLength(1);
      expect(await read(ws.adminId)).toHaveLength(1);
      expect(await read(ws.agentId)).toHaveLength(0);

      // The test database grants every role every table (as Supabase does by
      // default), so it is RLS, not the REVOKE, that has to hold here.
      await db().as({ kind: 'user', id: ws.adminId }, `DELETE FROM workspace_audit_logs`);
      await db().as({ kind: 'user', id: ws.adminId }, `UPDATE workspace_audit_logs SET action = 'edited'`);
      expect(await db().q(`SELECT 1 FROM workspace_audit_logs WHERE workspace_id = $1 AND action = 'workspace.updated'`, [ws.id])).toHaveLength(1);
      expect(
        await db().rejects(
          { kind: 'user', id: ws.adminId },
          `INSERT INTO workspace_audit_logs (workspace_id, action) VALUES ($1, 'fake')`,
          [ws.id]
        )
      ).toMatch(/row-level security/);
    });

    it('records role changes and deactivation', async () => {
      const ws = await createWorkspace(db());
      await db().as({ kind: 'user', id: ws.ownerId }, `SELECT fn_set_member_role($1, $2, 'light_agent')`, [ws.id, ws.agentId]);
      const rows = await db().q<{ action: string; details: { from: string; to: string } }>(
        `SELECT action, details FROM workspace_audit_logs WHERE workspace_id = $1 AND action LIKE 'member.%'`,
        [ws.id]
      );
      expect(rows.map((r) => r.action)).toContain('member.role_changed');
      expect(rows.find((r) => r.action === 'member.role_changed')?.details).toEqual({ from: 'agent', to: 'light_agent' });
    });

    it('rejects a malformed language code', async () => {
      const ws = await createWorkspace(db());
      await allowAdminsToUpdateWorkspaces();
      expect(await db().rejects({ kind: 'user', id: ws.adminId }, `UPDATE workspaces SET language = 'English!' WHERE id = $1`, [ws.id])).toMatch(
        /workspaces_language_format/
      );
    });
  });
});
