import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeState = vi.hoisted(() => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const WS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  return {
    USER_ID,
    WS_ID,
    user: { id: USER_ID, email: 'admin@platform.test' } as any,
    agent: {
      id: USER_ID,
      name: 'Super Admin',
      email: 'admin@platform.test',
      role: 'owner',
      workspace_id: WS_ID,
      is_active: true,
      is_super_admin: true,
    } as any,
  workspaces: [
    {
      id: WS_ID,
      name: 'Alpha Workspace',
      website_url: 'https://alpha.example.com',
      brand_color: '#2563eb',
      plan: 'pro',
      is_suspended: false,
      suspended_at: null,
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      owner_id: USER_ID,
    },
  ] as any[],
  agents: [
    {
      id: USER_ID,
      name: 'Super Admin',
      email: 'admin@platform.test',
      role: 'owner',
      workspace_id: WS_ID,
      is_active: true,
      is_super_admin: true,
      created_at: new Date().toISOString(),
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Regular Agent',
      email: 'agent@alpha.example.com',
      role: 'agent',
      workspace_id: WS_ID,
      is_active: true,
      is_super_admin: false,
      created_at: new Date().toISOString(),
    },
  ] as any[],
  tickets: [
    {
      id: 't-1',
      workspace_id: WS_ID,
      created_at: new Date().toISOString(),
      status: 'open',
    },
  ] as any[],
  messages: [] as any[],
    notes: [] as any[],
    auditLogs: [] as any[],
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/vercel-domains', () => ({
  addDomain: vi.fn(),
  removeDomain: vi.fn(),
}));

function createMockSupabaseClient() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: fakeState.user },
        error: fakeState.user ? null : { message: 'Not authenticated' },
      })),
    },
    rpc: vi.fn(async () => ({ data: null, error: { message: 'RPC not in unit test DB' } })),
    from: vi.fn((table: string) => {
      let isSingle = false;
      let isMaybeSingle = false;
      const filters: Array<{ op: string; args: any[] }> = [];
      let updatePayload: any = null;
      let insertPayload: any = null;

      const builder: any = {
        select: vi.fn(() => builder),
        eq: vi.fn((col: string, val: any) => {
          filters.push({ op: 'eq', args: [col, val] });
          return builder;
        }),
        neq: vi.fn((col: string, val: any) => {
          filters.push({ op: 'neq', args: [col, val] });
          return builder;
        }),
        gte: vi.fn((col: string, val: any) => {
          filters.push({ op: 'gte', args: [col, val] });
          return builder;
        }),
        is: vi.fn((col: string, val: any) => {
          filters.push({ op: 'is', args: [col, val] });
          return builder;
        }),
        not: vi.fn((col: string, op: string, val: any) => {
          filters.push({ op: 'not', args: [col, op, val] });
          return builder;
        }),
        or: vi.fn(() => builder),
        in: vi.fn(() => builder),
        ilike: vi.fn((col: string, pattern: string) => {
          filters.push({ op: 'ilike', args: [col, pattern] });
          return builder;
        }),
        order: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        single: vi.fn(() => {
          isSingle = true;
          return builder;
        }),
        maybeSingle: vi.fn(() => {
          isMaybeSingle = true;
          return builder;
        }),
        update: vi.fn((payload: any) => {
          updatePayload = payload;
          return builder;
        }),
        insert: vi.fn((payload: any) => {
          insertPayload = payload;
          if (table === 'super_admin_audit_logs') {
            fakeState.auditLogs.push(payload);
          }
          if (table === 'super_admin_workspace_notes') {
            const note = { id: `note-${fakeState.notes.length + 1}`, ...payload, created_at: new Date().toISOString() };
            fakeState.notes.push(note);
          }
          return builder;
        }),
        then: (resolve: (v: any) => any, reject?: (e: any) => any) => {
          try {
            if (insertPayload) {
              if (table === 'super_admin_workspace_notes') {
                return resolve({ data: fakeState.notes[fakeState.notes.length - 1], error: null });
              }
              return resolve({ data: insertPayload, error: null });
            }

            if (updatePayload) {
              const eqId = filters.find((f) => f.op === 'eq' && f.args[0] === 'id')?.args[1];
              if (table === 'workspaces' && eqId) {
                const target = fakeState.workspaces.find((w: any) => w.id === eqId);
                if (target) Object.assign(target, updatePayload);
              }
              if (table === 'agents' && eqId) {
                const target = fakeState.agents.find((a: any) => a.id === eqId);
                if (target) Object.assign(target, updatePayload);
              }
              return resolve({ data: updatePayload, error: null });
            }

            let sourceData: any[] = [];
            if (table === 'agents') {
              sourceData = fakeState.agents;
            } else if (table === 'workspaces') {
              sourceData = fakeState.workspaces;
            } else if (table === 'tickets') {
              sourceData = fakeState.tickets;
            } else if (table === 'super_admin_workspace_notes') {
              sourceData = fakeState.notes;
            } else if (table === 'super_admin_audit_logs') {
              sourceData = fakeState.auditLogs;
            } else if (table === 'platform_access') {
              if (fakeState.agent && fakeState.agent.is_super_admin) {
                sourceData = [{
                  id: `pa-${fakeState.USER_ID}`,
                  user_id: fakeState.USER_ID,
                  role: fakeState.agent.is_platform_owner || fakeState.agent.role === 'owner' ? 'owner' : 'admin',
                  granted_by: null,
                  granted_at: new Date().toISOString(),
                }];
              } else {
                sourceData = [];
              }
            }

            if (table === 'agents') {
              const eqId = filters.find((f) => f.op === 'eq' && f.args[0] === 'id')?.args[1];
              if (eqId === fakeState.USER_ID && fakeState.agent) {
                return resolve({ data: fakeState.agent, error: null });
              }
            }

            let filtered = [...sourceData];
            for (const f of filters) {
              if (f.op === 'eq') {
                const [col, val] = f.args;
                filtered = filtered.filter((row: any) => row[col] === val);
              } else if (f.op === 'neq') {
                const [col, val] = f.args;
                filtered = filtered.filter((row: any) => row[col] !== val);
              } else if (f.op === 'is') {
                const [col, val] = f.args;
                filtered = filtered.filter((row: any) => (row[col] ?? null) === val);
              } else if (f.op === 'ilike') {
                const [col, pat] = f.args;
                const clean = String(pat).replace(/%/g, '').toLowerCase();
                filtered = filtered.filter((row: any) => String(row[col] || '').toLowerCase().includes(clean));
              }
            }

            if (isSingle) {
              const item = filtered[0];
              if (!item) {
                return resolve({ data: null, error: { message: 'Row not found' } });
              }
              return resolve({ data: item, error: null });
            }

            if (isMaybeSingle) {
              return resolve({ data: filtered[0] || null, error: null });
            }

            return resolve({ data: filtered, error: null, count: filtered.length });
          } catch (err) {
            if (reject) return reject(err);
            return resolve({ data: null, error: err });
          }
        },
      };

      return builder;
    }),
  };
}

// Mock @/lib/supabase/server
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => createMockSupabaseClient()),
}));

// Mock @/lib/supabase/service
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: vi.fn(() => createMockSupabaseClient()),
}));

import {
  getPlatformOverviewMetricsAction,
  getPlatformWorkspacesTableAction,
  getPlatformWorkspaceDetailAction,
  suspendWorkspaceAction,
  reactivateWorkspaceAction,
  getWorkspaceNotesAction,
  saveWorkspaceNotesAction,
  getPlatformUsersAction,
  deactivateUserAction,
  reactivateUserAction,
  getPlatformSystemHealthAction,
  getPlatformGlobalSearchAction,
} from './platform';

const { USER_ID, WS_ID } = fakeState;

describe('Phase 2: Super Admin Platform Polish Suite', () => {
  beforeEach(() => {
    fakeState.user = { id: USER_ID, email: 'admin@platform.test' };
    fakeState.agent = {
      id: USER_ID,
      name: 'Super Admin',
      email: 'admin@platform.test',
      role: 'owner',
      workspace_id: WS_ID,
      is_active: true,
      is_super_admin: true,
    };
    fakeState.notes = [];
    fakeState.auditLogs = [];
  });

  describe('Authorization Enforcement: Unauthenticated Calls Rejection', () => {
    it('denies all actions when caller is unauthenticated (401)', async () => {
      fakeState.user = null;

      await expect(getPlatformOverviewMetricsAction()).rejects.toThrow(/401 Unauthorized/);
      await expect(getPlatformWorkspacesTableAction()).rejects.toThrow(/401 Unauthorized/);
      await expect(getPlatformWorkspaceDetailAction(WS_ID)).rejects.toThrow(/401 Unauthorized/);
      await expect(getWorkspaceNotesAction(WS_ID)).rejects.toThrow(/401 Unauthorized/);
      await expect(saveWorkspaceNotesAction(WS_ID, 'Note')).rejects.toThrow(/401 Unauthorized/);
      await expect(getPlatformUsersAction()).rejects.toThrow(/401 Unauthorized/);
      await expect(deactivateUserAction('some-user')).rejects.toThrow(/401 Unauthorized/);
      await expect(reactivateUserAction('some-user')).rejects.toThrow(/401 Unauthorized/);
      await expect(getPlatformSystemHealthAction()).rejects.toThrow(/401 Unauthorized/);
      await expect(getPlatformGlobalSearchAction('Alpha')).rejects.toThrow(/401 Unauthorized/);
    });
  });

  describe('Authorization Enforcement: Workspace Admin & Agent Rejection (403)', () => {
    it('strictly denies workspace admin when is_super_admin is false', async () => {
      fakeState.agent = {
        id: USER_ID,
        name: 'Workspace Admin',
        email: 'admin@workspace.test',
        role: 'owner',
        workspace_id: WS_ID,
        is_active: true,
        is_super_admin: false,
      };

      await expect(getPlatformOverviewMetricsAction()).rejects.toThrow(/403 Forbidden/);
      await expect(getPlatformWorkspacesTableAction()).rejects.toThrow(/403 Forbidden/);
      await expect(getPlatformWorkspaceDetailAction(WS_ID)).rejects.toThrow(/403 Forbidden/);
      await expect(suspendWorkspaceAction(WS_ID, 'Violation')).rejects.toThrow(/403 Forbidden/);
      await expect(reactivateWorkspaceAction(WS_ID)).rejects.toThrow(/403 Forbidden/);
      await expect(getWorkspaceNotesAction(WS_ID)).rejects.toThrow(/403 Forbidden/);
      await expect(saveWorkspaceNotesAction(WS_ID, 'Confidential note')).rejects.toThrow(/403 Forbidden/);
      await expect(getPlatformUsersAction()).rejects.toThrow(/403 Forbidden/);
      await expect(deactivateUserAction('some-user')).rejects.toThrow(/403 Forbidden/);
      await expect(reactivateUserAction('some-user')).rejects.toThrow(/403 Forbidden/);
      await expect(getPlatformSystemHealthAction()).rejects.toThrow(/403 Forbidden/);
      await expect(getPlatformGlobalSearchAction('Alpha')).rejects.toThrow(/403 Forbidden/);
    });

    it('strictly denies normal agent when is_super_admin is false', async () => {
      fakeState.agent = {
        id: USER_ID,
        name: 'Support Agent',
        email: 'agent@workspace.test',
        role: 'agent',
        workspace_id: WS_ID,
        is_active: true,
        is_super_admin: false,
      };

      await expect(getPlatformOverviewMetricsAction()).rejects.toThrow(/403 Forbidden/);
      await expect(getPlatformWorkspacesTableAction()).rejects.toThrow(/403 Forbidden/);
      await expect(suspendWorkspaceAction(WS_ID, 'Violation')).rejects.toThrow(/403 Forbidden/);
      await expect(reactivateWorkspaceAction(WS_ID)).rejects.toThrow(/403 Forbidden/);
      await expect(getPlatformUsersAction()).rejects.toThrow(/403 Forbidden/);
      await expect(getPlatformSystemHealthAction()).rejects.toThrow(/403 Forbidden/);
    });
  });

  describe('Super Admin Execution & Data Correctness', () => {
    it('getPlatformOverviewMetricsAction returns structured KPI data', async () => {
      const res = await getPlatformOverviewMetricsAction();
      expect(res).toBeDefined();
      expect(res.total_workspaces).toBeGreaterThanOrEqual(0);
      expect(res.trend_tickets).toBeDefined();
      expect(Array.isArray(res.trend_tickets)).toBe(true);
      expect(res.newest_workspaces).toBeDefined();
      expect(Array.isArray(res.alerts)).toBe(true);
    });

    it('getPlatformWorkspacesTableAction returns paginated table items', async () => {
      const res = await getPlatformWorkspacesTableAction({ page: 1, pageSize: 10 });
      expect(res).toBeDefined();
      expect(res.workspaces).toBeDefined();
      expect(Array.isArray(res.workspaces)).toBe(true);
      expect(res.totalCount).toBeGreaterThanOrEqual(1);
      expect(res.page).toBe(1);
    });

    it('getPlatformWorkspaceDetailAction loads workspace details with tabs data', async () => {
      const res = await getPlatformWorkspaceDetailAction(WS_ID);
      expect(res).toBeDefined();
      expect(res.workspace.id).toBe(WS_ID);
      expect(res.workspace.name).toBe('Alpha Workspace');
      expect(res.members).toBeDefined();
      expect(res.channels).toBeDefined();
      expect(res.usage).toBeDefined();
      expect(res.notes).toBeDefined();
    });

    it('saveWorkspaceNotesAction adds private note and records audit log', async () => {
      const noteContent = 'Account requested high capacity limits for holiday sale.';
      const res = await saveWorkspaceNotesAction(WS_ID, noteContent);
      expect(res.success).toBe(true);
      expect(res.note).toBeDefined();
      expect(res.note?.content).toBe(noteContent);

      expect(fakeState.auditLogs.some((l) => l.action === 'add_workspace_note')).toBe(true);
    });

    it('deactivateUserAction prevents super admin self-deactivation', async () => {
      const res = await deactivateUserAction(USER_ID);
      expect(res.success).toBe(false);
      expect(res.error).toContain('Cannot deactivate your own platform super admin account');
    });

    it('deactivateUserAction and reactivateUserAction toggle other user accounts with audit logs', async () => {
      const targetUserId = '22222222-2222-4222-8222-222222222222';
      const deact = await deactivateUserAction(targetUserId);
      expect(deact.success).toBe(true);
      expect(fakeState.auditLogs.some((l) => l.action === 'deactivate_user')).toBe(true);

      const react = await reactivateUserAction(targetUserId);
      expect(react.success).toBe(true);
      expect(fakeState.auditLogs.some((l) => l.action === 'reactivate_user')).toBe(true);
    });

    it('getPlatformSystemHealthAction returns report sections with workspace links', async () => {
      const res = await getPlatformSystemHealthAction();
      expect(res).toBeDefined();
      expect(Array.isArray(res.channel_failures)).toBe(true);
      expect(Array.isArray(res.email_issues)).toBe(true);
      expect(Array.isArray(res.background_errors)).toBe(true);
      expect(res.checked_at).toBeDefined();
    });

    it('getPlatformGlobalSearchAction returns matching workspaces and users', async () => {
      const res = await getPlatformGlobalSearchAction('Alpha');
      expect(res).toBeDefined();
      expect(Array.isArray(res.workspaces)).toBe(true);
      expect(Array.isArray(res.users)).toBe(true);
      expect(res.workspaces.length).toBeGreaterThanOrEqual(1);
    });
  });
});
