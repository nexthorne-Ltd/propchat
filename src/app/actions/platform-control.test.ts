import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminToggleSettingLockAction,
  adminUpdateWorkspacePlanAction,
  adminUpdateWorkspaceLimitsAction,
  adminUpdateWorkspaceFeaturesAction,
  adminUpdateAiControlAction,
  adminUpdateWidgetControlAction,
  adminUpdateSecurityControlAction,
  adminSaveGlobalDefaultsAction,
  adminBulkChangePlanAction,
  adminBulkSuspendAction,
  adminBulkToggleFeatureAction,
  adminBulkSendAnnouncementAction,
} from './platform-control';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const REGULAR_USER_ID = '44444444-4444-4444-8444-444444444444';
const WS_ID_1 = 'ws-test-1111';
const WS_ID_2 = 'ws-test-2222';

const fakeState = vi.hoisted(() => ({
  currentUser: { id: '11111111-1111-4111-8111-111111111111', email: 'zentry385@gmail.com' } as any,
  callerAgent: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Zentry Owner',
    email: 'zentry385@gmail.com',
    role: 'owner',
    is_active: true,
  } as any,
  platformAccess: [
    {
      user_id: '11111111-1111-4111-8111-111111111111',
      role: 'owner',
      granted_at: new Date().toISOString(),
    },
  ] as any[],
  workspaces: [
    {
      id: 'ws-test-1111',
      name: 'Acme Corp',
      is_suspended: false,
      suspension_reason: null,
      suspended_at: null,
      widget_disabled: false,
      force_powered_by: 'inherited',
      help_center_enabled: true,
      require_2fa: false,
      data_retention_days: null,
      ai_monthly_reply_cap: null,
      ai_monthly_cost_cap_usd: null,
      channel_disabled_overrides: {},
    },
    {
      id: 'ws-test-2222',
      name: 'Beta LLC',
      is_suspended: false,
      suspension_reason: null,
      suspended_at: null,
      widget_disabled: false,
      force_powered_by: 'inherited',
      help_center_enabled: true,
      require_2fa: false,
      data_retention_days: null,
      ai_monthly_reply_cap: null,
      ai_monthly_cost_cap_usd: null,
      channel_disabled_overrides: {},
    },
  ] as any[],
  subscriptions: [
    {
      id: 'sub-1',
      workspace_id: 'ws-test-1111',
      plan_id: 'plan-starter',
      billing_period: 'monthly',
      status: 'active',
      custom_features: {},
      custom_limits: {},
      plan: {
        id: 'plan-starter',
        slug: 'starter',
        name: 'Starter Plan',
        features: {},
      },
    },
    {
      id: 'sub-2',
      workspace_id: 'ws-test-2222',
      plan_id: 'plan-starter',
      billing_period: 'monthly',
      status: 'active',
      custom_features: {},
      custom_limits: {},
      plan: {
        id: 'plan-starter',
        slug: 'starter',
        name: 'Starter Plan',
        features: {},
      },
    },
  ] as any[],
  plans: [
    {
      id: 'plan-starter',
      slug: 'starter',
      name: 'Starter Plan',
      features: {},
    },
    {
      id: 'plan-pro',
      slug: 'pro',
      name: 'Pro Plan',
      features: { sla: true, ai_bot: true },
    },
  ] as any[],
  settingLocks: [] as any[],
  platformSettings: {
    id: 'default',
    default_plan_slug: 'starter',
    default_trial_days: 14,
    signup_mode: 'open',
    default_features: {},
    default_limits: {},
    default_ai_settings: {},
    default_allowed_channels: ['email', 'whatsapp'],
    default_require_2fa: false,
    default_data_retention_days: null,
  } as any,
  auditLogs: [] as any[],
  announcements: [] as any[],
  agents: [] as any[],
  channels: [] as any[],
  invoices: [] as any[],
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => createMockSupabaseClient()),
}));

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: vi.fn(() => createMockSupabaseClient()),
  createServiceClient: vi.fn(() => createMockSupabaseClient()),
}));

function createMockSupabaseClient() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: fakeState.currentUser },
        error: fakeState.currentUser ? null : { message: 'Not authenticated' },
      })),
    },
    from: vi.fn((table: string) => {
      let isSingle = false;
      let isMaybeSingle = false;
      const filters: Array<{ op: string; col: string; val: any }> = [];
      let updatePayload: any = null;
      let insertPayload: any = null;
      let deleteCalled = false;

      const query: any = {
        select: vi.fn(() => query),
        insert: vi.fn((payload: any) => {
          insertPayload = payload;
          const items = Array.isArray(payload) ? payload : [payload];
          if (table === 'super_admin_audit_logs') {
            fakeState.auditLogs.push(...items);
          } else if (table === 'platform_announcements') {
            fakeState.announcements.push(...items);
          } else if (table === 'workspace_setting_locks') {
            fakeState.settingLocks.push(...items);
          }
          return query;
        }),
        upsert: vi.fn((payload: any) => {
          const items = Array.isArray(payload) ? payload : [payload];
          if (table === 'workspace_setting_locks') {
            for (const item of items) {
              const existingIdx = fakeState.settingLocks.findIndex(
                (l) => l.workspace_id === item.workspace_id && l.setting_key === item.setting_key
              );
              if (existingIdx >= 0) {
                fakeState.settingLocks[existingIdx] = { ...fakeState.settingLocks[existingIdx], ...item };
              } else {
                fakeState.settingLocks.push(item);
              }
            }
          } else if (table === 'platform_settings') {
            fakeState.platformSettings = { ...fakeState.platformSettings, ...payload };
          }
          return query;
        }),
        update: vi.fn((payload: any) => {
          updatePayload = payload;
          return query;
        }),
        delete: vi.fn(() => {
          deleteCalled = true;
          return query;
        }),
        eq: vi.fn((col: string, val: any) => {
          filters.push({ op: 'eq', col, val });
          return query;
        }),
        in: vi.fn((col: string, val: any) => {
          filters.push({ op: 'in', col, val });
          return query;
        }),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        single: vi.fn(() => {
          isSingle = true;
          return query;
        }),
        maybeSingle: vi.fn(() => {
          isMaybeSingle = true;
          return query;
        }),
        then: (resolve: any) => {
          resolve(execute());
        },
      };

      function execute() {
        if (table === 'platform_access') {
          const userFilter = filters.find((f) => f.col === 'user_id');
          const row = fakeState.platformAccess.find((p) => !userFilter || p.user_id === userFilter.val);
          return { data: isSingle || isMaybeSingle ? (row || null) : fakeState.platformAccess, error: null };
        }

        if (table === 'agents') {
          const idFilter = filters.find((f) => f.col === 'id');
          const emailFilter = filters.find((f) => f.col === 'email');
          const wsFilter = filters.find((f) => f.col === 'workspace_id');
          if (idFilter) {
            return { data: fakeState.callerAgent, error: null };
          }
          if (emailFilter) {
            return { data: fakeState.callerAgent, error: null };
          }
          let filtered = [...fakeState.agents];
          if (wsFilter) {
            filtered = filtered.filter((a) => a.workspace_id === wsFilter.val);
          }
          return { data: isSingle || isMaybeSingle ? (filtered[0] || null) : filtered, error: null };
        }

        if (table === 'workspaces') {
          if (updatePayload) {
            const idFilter = filters.find((f) => f.col === 'id');
            const inFilter = filters.find((f) => f.col === 'id' && f.op === 'in');
            for (const ws of fakeState.workspaces) {
              if (
                (idFilter && ws.id === idFilter.val) ||
                (inFilter && inFilter.val.includes(ws.id))
              ) {
                Object.assign(ws, updatePayload);
              }
            }
          }
          const idFilter = filters.find((f) => f.col === 'id');
          const row = fakeState.workspaces.find((w) => !idFilter || w.id === idFilter.val);
          return { data: isSingle || isMaybeSingle ? (row || null) : fakeState.workspaces, error: null };
        }

        if (table === 'workspace_subscriptions') {
          if (updatePayload) {
            const idFilter = filters.find((f) => f.col === 'id');
            const wsFilter = filters.find((f) => f.col === 'workspace_id');
            const inFilter = filters.find((f) => f.col === 'workspace_id' && f.op === 'in');
            for (const sub of fakeState.subscriptions) {
              if (
                (idFilter && sub.id === idFilter.val) ||
                (wsFilter && sub.workspace_id === wsFilter.val) ||
                (inFilter && inFilter.val.includes(sub.workspace_id))
              ) {
                Object.assign(sub, updatePayload);
              }
            }
          }
          const wsFilter = filters.find((f) => f.col === 'workspace_id');
          const inFilter = filters.find((f) => f.col === 'workspace_id' && f.op === 'in');
          let res: any = fakeState.subscriptions;
          if (wsFilter) {
            res = fakeState.subscriptions.find((s) => s.workspace_id === wsFilter.val) || null;
          } else if (inFilter) {
            res = fakeState.subscriptions.filter((s) => inFilter.val.includes(s.workspace_id));
          }
          return { data: isSingle || isMaybeSingle ? (res || null) : res, error: null };
        }

        if (table === 'platform_plans') {
          const idFilter = filters.find((f) => f.col === 'id');
          const slugFilter = filters.find((f) => f.col === 'slug');
          const row = fakeState.plans.find((p) => {
            if (idFilter && p.id === idFilter.val) return true;
            if (slugFilter && p.slug === slugFilter.val) return true;
            return false;
          });
          return { data: isSingle || isMaybeSingle ? (row || null) : fakeState.plans, error: null };
        }

        if (table === 'workspace_setting_locks') {
          const wsFilter = filters.find((f) => f.col === 'workspace_id');
          const keyFilter = filters.find((f) => f.col === 'setting_key');
          const row = fakeState.settingLocks.find(
            (l) => (!wsFilter || l.workspace_id === wsFilter.val) && (!keyFilter || l.setting_key === keyFilter.val)
          );
          return { data: isSingle || isMaybeSingle ? (row || null) : fakeState.settingLocks, error: null };
        }

        if (table === 'platform_settings') {
          return { data: isSingle || isMaybeSingle ? fakeState.platformSettings : [fakeState.platformSettings], error: null };
        }

        if (table === 'channel_connections') {
          return { data: fakeState.channels, error: null };
        }

        if (table === 'workspace_invoices') {
          return { data: fakeState.invoices, error: null };
        }

        if (table === 'super_admin_audit_logs' || table === 'workspace_audit_logs') {
          return { data: fakeState.auditLogs, error: null };
        }

        return { data: null, error: null };
      }

      return query;
    }),
  };
}

describe('Super Admin Workspace Control Center Actions', () => {
  beforeEach(() => {
    fakeState.currentUser = { id: OWNER_ID, email: 'zentry385@gmail.com' };
    fakeState.callerAgent = {
      id: OWNER_ID,
      name: 'Zentry Owner',
      email: 'zentry385@gmail.com',
      role: 'owner',
      is_active: true,
    };
    fakeState.platformAccess = [
      {
        user_id: OWNER_ID,
        role: 'owner',
        granted_at: new Date().toISOString(),
      },
    ];
    fakeState.workspaces[0].widget_disabled = false;
    fakeState.workspaces[0].is_suspended = false;
    fakeState.settingLocks = [];
    fakeState.auditLogs = [];
  });

  it('rejects regular non-super-admin user with 403 Forbidden', async () => {
    fakeState.currentUser = { id: REGULAR_USER_ID, email: 'regular@example.com' };
    fakeState.callerAgent = {
      id: REGULAR_USER_ID,
      name: 'Regular User',
      email: 'regular@example.com',
      role: 'agent',
      is_active: true,
    };
    fakeState.platformAccess = [];

    await expect(
      adminToggleSettingLockAction(WS_ID_1, 'widget_appearance', true, 'Test reason')
    ).rejects.toThrow(/403 Forbidden: Platform super admin privileges required/);
  });

  it('allows super admin to lock a setting and records audit log', async () => {
    const result = await adminToggleSettingLockAction(
      WS_ID_1,
      'widget_appearance',
      true,
      'Maintain brand consistency'
    );

    expect(result.success).toBe(true);

    // Verify lock stored
    const lock = fakeState.settingLocks.find(
      (l) => l.workspace_id === WS_ID_1 && l.setting_key === 'widget_appearance'
    );
    expect(lock).toBeDefined();
    expect(lock?.is_locked).toBe(true);

    // Verify audit log
    expect(fakeState.auditLogs.some((l) => l.action === 'admin_setting_locked')).toBe(true);
  });

  it('allows super admin to update workspace plan & billing cycle', async () => {
    const result = await adminUpdateWorkspacePlanAction({
      workspaceId: WS_ID_1,
      planId: 'plan-pro',
      billingPeriod: 'yearly',
    });
    expect(result.success).toBe(true);

    const sub = fakeState.subscriptions.find((s) => s.workspace_id === WS_ID_1);
    expect(sub?.plan_id).toBe('plan-pro');
    expect(sub?.billing_period).toBe('yearly');

    expect(fakeState.auditLogs.some((l) => l.action === 'admin_workspace_plan_updated')).toBe(true);
  });

  it('allows super admin to override usage limits', async () => {
    const result = await adminUpdateWorkspaceLimitsAction(WS_ID_1, {
      max_agents: 25,
      max_tickets_per_month: 5000,
    });
    expect(result.success).toBe(true);

    const sub = fakeState.subscriptions.find((s) => s.workspace_id === WS_ID_1);
    expect(sub?.custom_limits.max_agents).toBe(25);
    expect(sub?.custom_limits.max_tickets_per_month).toBe(5000);

    expect(fakeState.auditLogs.some((l) => l.action === 'admin_workspace_limits_updated')).toBe(true);
  });

  it('allows super admin to toggle feature override', async () => {
    const result = await adminUpdateWorkspaceFeaturesAction(WS_ID_1, { sla: true });
    expect(result.success).toBe(true);

    const sub = fakeState.subscriptions.find((s) => s.workspace_id === WS_ID_1);
    expect(sub?.custom_features.sla).toBe(true);

    expect(fakeState.auditLogs.some((l) => l.action === 'admin_workspace_features_updated')).toBe(true);
  });

  it('allows super admin to configure AI caps and monthly limits', async () => {
    const result = await adminUpdateAiControlAction(WS_ID_1, {
      monthly_reply_cap: 3000,
      monthly_cost_cap_usd: 150,
    });
    expect(result.success).toBe(true);

    const ws = fakeState.workspaces.find((w) => w.id === WS_ID_1);
    expect(ws?.ai_monthly_reply_cap).toBe(3000);
    expect(ws?.ai_monthly_cost_cap_usd).toBe(150);

    expect(fakeState.auditLogs.some((l) => l.action === 'admin_ai_control_updated')).toBe(true);
  });

  it('allows super admin to control widget availability and branding power badge', async () => {
    const result = await adminUpdateWidgetControlAction(WS_ID_1, {
      widgetDisabled: true,
      forcePoweredBy: 'force_on',
    });
    expect(result.success).toBe(true);

    const ws = fakeState.workspaces.find((w) => w.id === WS_ID_1);
    expect(ws?.widget_disabled).toBe(true);
    expect(ws?.force_powered_by).toBe('force_on');
  });

  it('allows super admin to configure security policy (2FA, data retention)', async () => {
    const result = await adminUpdateSecurityControlAction(WS_ID_1, {
      require2fa: true,
      dataRetentionDays: 180,
    });
    expect(result.success).toBe(true);

    const ws = fakeState.workspaces.find((w) => w.id === WS_ID_1);
    expect(ws?.require_2fa).toBe(true);
    expect(ws?.data_retention_days).toBe(180);
  });

  it('allows super admin to update global platform defaults', async () => {
    const result = await adminSaveGlobalDefaultsAction({
      default_plan_slug: 'pro',
      default_trial_days: 30,
      signup_mode: 'invite_only',
      default_require_2fa: true,
    });
    expect(result.success).toBe(true);

    expect(fakeState.platformSettings.default_plan_slug).toBe('pro');
    expect(fakeState.platformSettings.default_trial_days).toBe(30);
    expect(fakeState.platformSettings.signup_mode).toBe('invite_only');
    expect(fakeState.platformSettings.default_require_2fa).toBe(true);

    expect(fakeState.auditLogs.some((l) => l.action === 'admin_global_defaults_updated')).toBe(true);
  });
});

describe('Super Admin Bulk Operations (Requirement E)', () => {
  beforeEach(() => {
    fakeState.currentUser = { id: OWNER_ID, email: 'zentry385@gmail.com' };
    fakeState.callerAgent = {
      id: OWNER_ID,
      name: 'Zentry Owner',
      email: 'zentry385@gmail.com',
      role: 'owner',
      is_active: true,
    };
    fakeState.platformAccess = [
      {
        user_id: OWNER_ID,
        role: 'owner',
        granted_at: new Date().toISOString(),
      },
    ];
    fakeState.auditLogs = [];
    fakeState.announcements = [];
  });

  it('bulk changes plans across multiple workspaces', async () => {
    const result = await adminBulkChangePlanAction([WS_ID_1, WS_ID_2], 'plan-pro');
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);

    expect(fakeState.auditLogs.some((l) => l.action === 'admin_bulk_change_plan')).toBe(true);
  });

  it('bulk suspends and reactivates workspaces', async () => {
    // Suspend
    const suspendRes = await adminBulkSuspendAction(
      [WS_ID_1, WS_ID_2],
      true,
      'System-wide scheduled maintenance'
    );
    expect(suspendRes.success).toBe(true);
    expect(fakeState.workspaces[0].is_suspended).toBe(true);
    expect(fakeState.workspaces[1].is_suspended).toBe(true);

    // Reactivate
    const reactivateRes = await adminBulkSuspendAction([WS_ID_1, WS_ID_2], false, '');
    expect(reactivateRes.success).toBe(true);
    expect(fakeState.workspaces[0].is_suspended).toBe(false);
    expect(fakeState.workspaces[1].is_suspended).toBe(false);
  });

  it('bulk toggles feature flag across selected workspaces', async () => {
    const result = await adminBulkToggleFeatureAction([WS_ID_1, WS_ID_2], 'sla', true);
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);

    expect(fakeState.auditLogs.some((l) => l.action === 'admin_bulk_toggle_feature')).toBe(true);
  });

  it('bulk sends announcements to selected workspaces', async () => {
    const result = await adminBulkSendAnnouncementAction([WS_ID_1, WS_ID_2], {
      title: 'Important Maintenance Tonight',
      message: 'Please save your work before 2:00 UTC',
      tone: 'warning',
    });
    expect(result.success).toBe(true);
    expect(fakeState.announcements.length).toBe(1);
    expect(fakeState.announcements[0].target_workspace_ids).toEqual([WS_ID_1, WS_ID_2]);
  });
});
