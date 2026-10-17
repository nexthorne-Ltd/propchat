import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const fakeState = vi.hoisted(() => ({
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@platform.test' } as any,
  agent: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Platform Super Admin',
    email: 'admin@platform.test',
    role: 'owner',
    workspace_id: null,
    is_active: true,
    is_super_admin: true,
  } as any,
  workspaces: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Acme Support',
      website_url: 'https://acme.example.com',
      brand_color: '#3b82f6',
      logo_url: null,
      plan: 'pro',
      is_suspended: false,
      suspended_at: null,
      suspension_reason: null,
      deleted_at: null,
      created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ] as any[],
  auditLogs: [] as any[],
  agents: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Alice Agent',
      email: 'alice@acme.example.com',
      role: 'owner',
      status: 'active',
      is_active: true,
      created_at: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Bob Agent',
      email: 'bob@acme.example.com',
      role: 'agent',
      status: 'active',
      is_active: true,
      created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ] as any[],
  tickets: [
    {
      id: 'ticket-1',
      workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'solved',
      conversation_id: 'conv-1',
      created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      solved_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'ticket-2',
      workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'open',
      conversation_id: 'conv-2',
      created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      solved_at: null,
      updated_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ] as any[],
  channelConns: [
    {
      workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      channel: 'email',
      status: 'connected',
    },
    {
      workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      channel: 'whatsapp',
      status: 'connected',
    },
  ] as any[],
  visitors: [
    {
      id: 'visitor-1',
      workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      last_seen: new Date().toISOString(),
    },
  ] as any[],
  articles: [
    {
      id: 'article-1',
      workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'How to Reset Password',
      slug: 'how-to-reset-password',
      views_count: 142,
      helpful_count: 38,
      status: 'published',
      created_at: new Date().toISOString(),
    },
  ] as any[],
  messages: [
    {
      id: 'msg-1',
      conversation_id: 'conv-1',
      sender_type: 'ai',
      created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 15000).toISOString(),
    },
    {
      id: 'msg-2',
      conversation_id: 'conv-2',
      sender_type: 'ai',
      created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + 10000).toISOString(),
    },
    {
      id: 'msg-3',
      conversation_id: 'conv-2',
      sender_type: 'agent',
      created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + 60000).toISOString(),
    },
  ] as any[],
}));

function createMockSupabaseClient() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: fakeState.user },
        error: fakeState.user ? null : { message: 'Not authenticated' },
      }),
    },
    rpc: async (fn: string, args: any) => {
      // Return null so actions fall back to simulated serviceClient logic in tests
      return { data: null, error: { message: 'RPC not in unit test DB' } };
    },
    from: (table: string) => {
      let isSingle = false;
      let isMaybeSingle = false;
      let filters: Array<{ op: string; args: any[] }> = [];
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
          return builder;
        }),
        then: (resolve: (v: any) => any, reject?: (e: any) => any) => {
          try {
            if (insertPayload) {
              return resolve({ data: insertPayload, error: null });
            }

            if (updatePayload) {
              const eqId = filters.find((f) => f.op === 'eq' && f.args[0] === 'id')?.args[1];
              if (table === 'workspaces' && eqId) {
                const target = fakeState.workspaces.find((w) => w.id === eqId);
                if (target) {
                  Object.assign(target, updatePayload);
                }
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
            } else if (table === 'channel_connections') {
              sourceData = fakeState.channelConns;
            } else if (table === 'visitors') {
              sourceData = fakeState.visitors;
            } else if (table === 'articles') {
              sourceData = fakeState.articles;
            } else if (table === 'messages') {
              sourceData = fakeState.messages;
            } else if (table === 'super_admin_audit_logs') {
              sourceData = fakeState.auditLogs;
            } else if (table === 'platform_access') {
              if (fakeState.agent && fakeState.agent.is_super_admin) {
                sourceData = [{
                  id: `pa-${fakeState.agent.id}`,
                  user_id: fakeState.agent.id,
                  role: fakeState.agent.is_platform_owner || fakeState.agent.role === 'owner' ? 'owner' : 'admin',
                  granted_by: null,
                  granted_at: new Date().toISOString(),
                }];
              } else {
                sourceData = [];
              }
            }

            // Apply basic filters
            let filtered = [...sourceData];
            for (const f of filters) {
              if (f.op === 'eq') {
                const [col, val] = f.args;
                filtered = filtered.filter((row) => row[col] === val);
              } else if (f.op === 'neq') {
                const [col, val] = f.args;
                filtered = filtered.filter((row) => row[col] !== val);
              } else if (f.op === 'is') {
                const [col, val] = f.args;
                filtered = filtered.filter((row) => row[col] === val);
              }
            }

            // Special handle for caller agent lookup in assertSuperAdmin
            if (table === 'agents') {
              const eqId = filters.find((f) => f.op === 'eq' && f.args[0] === 'id')?.args[1];
              if (eqId === USER_ID && fakeState.agent) {
                return resolve({ data: fakeState.agent, error: null });
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

            return resolve({ data: filtered, error: null });
          } catch (err) {
            if (reject) return reject(err);
            return resolve({ data: null, error: err });
          }
        },
      };

      return builder;
    },
  };
}

vi.mock('server-only', () => ({}));
vi.mock('@/lib/vercel-domains', () => ({
  addDomain: vi.fn(),
  removeDomain: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock('@/components/admin/WorkspaceDetailView', () => ({
  WorkspaceDetailView: vi.fn((props: any) => ({ type: 'WorkspaceDetailView', props })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => createMockSupabaseClient(),
}));

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => createMockSupabaseClient(),
  hasServiceRole: () => true,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: vi.fn(),
    set: vi.fn(),
  }),
}));

import {
  assertSuperAdmin,
  getPlatformWorkspacesAction,
  getPlatformOverviewAction,
  getWorkspaceDetailAction,
  suspendWorkspaceAction,
  reactivateWorkspaceAction,
} from './platform';
import WorkspacePage from '../admin/workspaces/[id]/page';

describe('Platform Owner Admin: Server-Side Authorization', () => {
  beforeEach(() => {
    fakeState.auditLogs = [];
    fakeState.user = { id: USER_ID, email: 'admin@platform.test' };
    fakeState.agent = {
      id: USER_ID,
      name: 'Platform Super Admin',
      email: 'admin@platform.test',
      role: 'owner',
      workspace_id: null,
      is_active: true,
      is_super_admin: true,
    };
    fakeState.workspaces = [
      {
        id: WS_ID,
        name: 'Acme Support',
        website_url: 'https://acme.example.com',
        brand_color: '#3b82f6',
        logo_url: null,
        plan: 'pro',
        is_suspended: false,
        suspended_at: null,
        suspension_reason: null,
        deleted_at: null,
        created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];
  });

  describe('assertSuperAdmin guard', () => {
    it('throws 401 Unauthorized when user is not logged in', async () => {
      fakeState.user = null;
      await expect(assertSuperAdmin()).rejects.toThrow(/401 Unauthorized/);
    });

    it('throws 403 Forbidden when user has no agent record', async () => {
      fakeState.agent = null;
      await expect(assertSuperAdmin()).rejects.toThrow(/403 Forbidden/);
    });

    it('throws 403 Forbidden when caller is a standard workspace agent (is_super_admin: false)', async () => {
      fakeState.agent = {
        id: USER_ID,
        name: 'Regular Agent',
        email: 'agent@acme.example.com',
        role: 'agent',
        workspace_id: WS_ID,
        is_active: true,
        is_super_admin: false,
      };
      await expect(assertSuperAdmin()).rejects.toThrow(/403 Forbidden/);
    });

    it('throws 403 Forbidden when caller is a workspace admin (is_super_admin: false)', async () => {
      fakeState.agent = {
        id: USER_ID,
        name: 'Workspace Admin',
        email: 'admin@acme.example.com',
        role: 'admin',
        workspace_id: WS_ID,
        is_active: true,
        is_super_admin: false,
      };
      await expect(assertSuperAdmin()).rejects.toThrow(/403 Forbidden/);
    });

    it('throws 403 Forbidden when caller is a workspace owner without platform super admin rights', async () => {
      // Critical check: workspace owner is NOT the platform owner!
      fakeState.agent = {
        id: USER_ID,
        name: 'Workspace Owner',
        email: 'owner@acme.example.com',
        role: 'owner',
        workspace_id: WS_ID,
        is_active: true,
        is_super_admin: false,
      };
      await expect(assertSuperAdmin()).rejects.toThrow(/403 Forbidden/);
    });

    it('succeeds when caller is a platform super admin (is_super_admin: true)', async () => {
      fakeState.agent = {
        id: USER_ID,
        name: 'Super Admin',
        email: 'admin@platform.test',
        role: 'owner',
        workspace_id: null,
        is_active: true,
        is_super_admin: true,
      };
      const result = await assertSuperAdmin();
      expect(result.user.id).toBe(USER_ID);
      expect(result.agent.is_super_admin).toBe(true);
    });
  });

  describe('Admin actions enforce authorization against normal workspace users', () => {
    beforeEach(() => {
      // Configure caller as a normal workspace user
      fakeState.agent = {
        id: USER_ID,
        name: 'Normal User',
        email: 'normal@user.com',
        role: 'agent',
        workspace_id: WS_ID,
        is_active: true,
        is_super_admin: false,
      };
    });

    it('denies normal workspace user from listing platform workspaces', async () => {
      await expect(getPlatformWorkspacesAction()).rejects.toThrow(/403 Forbidden/);
    });

    it('denies normal workspace user from viewing platform overview', async () => {
      await expect(getPlatformOverviewAction(30)).rejects.toThrow(/403 Forbidden/);
    });

    it('denies normal workspace user from viewing workspace detail', async () => {
      await expect(getWorkspaceDetailAction(WS_ID, 30)).rejects.toThrow(/403 Forbidden/);
    });

    it('denies normal workspace user from suspending a workspace', async () => {
      await expect(suspendWorkspaceAction(WS_ID, 'Suspicious billing')).rejects.toThrow(/403 Forbidden/);
    });

    it('denies normal workspace user from reactivating a workspace', async () => {
      await expect(reactivateWorkspaceAction(WS_ID)).rejects.toThrow(/403 Forbidden/);
    });
  });

  describe('Super Admin operations & audit trail', () => {
    beforeEach(() => {
      fakeState.agent = {
        id: USER_ID,
        name: 'Super Admin',
        email: 'admin@platform.test',
        role: 'owner',
        workspace_id: null,
        is_active: true,
        is_super_admin: true,
      };
    });

    it('getPlatformWorkspacesAction returns list with all required columns and metrics', async () => {
      const workspaces = await getPlatformWorkspacesAction();
      expect(workspaces).toHaveLength(1);
      const ws = workspaces[0];
      expect(ws.name).toBe('Acme Support');
      expect(ws.website_url).toBe('https://acme.example.com');
      expect(ws.status).toBe('active');
      expect(ws.agents_count).toBe(2);
      expect(ws.tickets_30d_count).toBe(2);
      expect(ws.connected_channels).toContain('email');
      expect(ws.connected_channels).toContain('whatsapp');
      expect(ws.connected_channels).toContain('chat');
      expect(ws.last_activity_at).toBeDefined();
    });

    it('getPlatformOverviewAction computes totals across all workspaces', async () => {
      const overview = await getPlatformOverviewAction(30);
      expect(overview.range_days).toBe(30);
      expect(overview.total_workspaces).toBe(1);
      expect(overview.active_workspaces).toBe(1);
      expect(overview.suspended_workspaces).toBe(0);
      expect(overview.total_tickets).toBe(2);
      expect(overview.resolution_rate_percent).toBe(50); // 1 solved out of 2
      expect(overview.tickets_per_day).toBeDefined();
      expect(overview.top_articles).toHaveLength(1);
      expect(overview.bot_resolved_count).toBe(1); // conv-1 has AI only
      expect(overview.bot_handover_count).toBe(1); // conv-2 has AI + agent
    });

    it('getWorkspaceDetailAction returns workspace metrics and roster', async () => {
      const detail = await getWorkspaceDetailAction(WS_ID, 30);
      expect(detail.workspace.id).toBe(WS_ID);
      expect(detail.workspace.name).toBe('Acme Support');
      expect(detail.workspace.status).toBe('active');
      expect(detail.resolution_rate_percent).toBe(50);
      expect(detail.members).toHaveLength(2);
      expect(detail.top_articles).toHaveLength(1);
      expect(detail.tickets_per_day).toBeDefined();
      expect(detail.bot_resolved_count).toBe(1);
      expect(detail.bot_handover_count).toBe(1);
    });

    it('suspendWorkspaceAction updates status and writes audit log entry', async () => {
      const reason = 'Terms of Service violation: unpaid invoice';
      const res = await suspendWorkspaceAction(WS_ID, reason);
      expect(res.success).toBe(true);

      const targetWs = fakeState.workspaces.find((w) => w.id === WS_ID);
      expect(targetWs.is_suspended).toBe(true);
      expect(targetWs.suspension_reason).toBe(reason);
      expect(targetWs.suspended_at).toBeDefined();

      // Check audit log
      expect(fakeState.auditLogs).toHaveLength(1);
      const log = fakeState.auditLogs[0];
      expect(log.action).toBe('suspend_workspace');
      expect(log.workspace_id).toBe(WS_ID);
      expect(log.admin_id).toBe(USER_ID);
      expect(log.details.reason).toBe(reason);
    });

    it('reactivateWorkspaceAction clears suspension and writes audit log entry', async () => {
      // First suspend
      fakeState.workspaces[0].is_suspended = true;
      fakeState.workspaces[0].suspension_reason = 'Previous violation';

      const res = await reactivateWorkspaceAction(WS_ID);
      expect(res.success).toBe(true);

      const targetWs = fakeState.workspaces.find((w) => w.id === WS_ID);
      expect(targetWs.is_suspended).toBe(false);
      expect(targetWs.suspension_reason).toBeNull();
      expect(targetWs.suspended_at).toBeNull();

      // Check audit log
      expect(fakeState.auditLogs).toHaveLength(1);
      const log = fakeState.auditLogs[0];
      expect(log.action).toBe('reactivate_workspace');
      expect(log.workspace_id).toBe(WS_ID);
      expect(log.admin_id).toBe(USER_ID);
    });
  });

  describe('Workspace detail route authorization (/admin/workspaces/[id])', () => {
    it('redirects unauthenticated visitor to login', async () => {
      fakeState.user = null;
      await expect(
        WorkspacePage({ params: Promise.resolve({ id: WS_ID }) })
      ).rejects.toThrow(/REDIRECT:\/login/);
    });

    it('renders 403 Forbidden UI when accessed by a normal workspace user', async () => {
      fakeState.agent = {
        id: USER_ID,
        name: 'Workspace User',
        email: 'agent@acme.example.com',
        role: 'agent',
        workspace_id: WS_ID,
        is_active: true,
        is_super_admin: false,
      };

      const result = await WorkspacePage({ params: Promise.resolve({ id: WS_ID }) });
      expect(result).toBeDefined();
      // Verify 403 error page is returned instead of WorkspaceDetailView
      expect((result as any).type).not.toBe('WorkspaceDetailView');
      // Verify forbidden content rendered in JSX structure
      const renderedJson = JSON.stringify(result);
      expect(renderedJson).toContain('403 - Forbidden');
      expect(renderedJson).toContain('Platform super administrator privileges are required');
    });

    it('renders WorkspaceDetailPage when accessed by platform super admin', async () => {
      fakeState.agent = {
        id: USER_ID,
        name: 'Platform Super Admin',
        email: 'admin@platform.test',
        role: 'owner',
        workspace_id: null,
        is_active: true,
        is_super_admin: true,
      };

      const result = await WorkspacePage({ params: Promise.resolve({ id: WS_ID }) });
      expect(result).toBeDefined();
      expect((result as any).props.workspaceId).toBe(WS_ID);
    });
  });
});

