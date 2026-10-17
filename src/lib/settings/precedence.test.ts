import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEffectiveWorkspaceSettings,
  isWorkspaceSettingLocked,
  assertSettingNotLocked,
} from './precedence';

const WS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const fakeState = vi.hoisted(() => ({
  workspace: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Acme Test Workspace',
    brand_color: '#2563eb',
    widget_disabled: false,
    force_powered_by: 'inherited',
    help_center_enabled: true,
    require_2fa: false,
    data_retention_days: null,
    ai_monthly_reply_cap: null,
    ai_monthly_cost_cap_usd: null,
    channel_disabled_overrides: {},
    ai_settings: { enabled: true, model: 'claude-3-5-sonnet' },
  } as any,
  subscription: {
    id: 'sub-1',
    workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    plan_id: 'pro',
    status: 'active',
    custom_features: {} as Record<string, boolean>,
    custom_limits: {} as Record<string, number | null>,
    plan: {
      id: 'plan-pro',
      slug: 'pro',
      name: 'Pro Plan',
      features: {
        sla: true,
        ai_bot: true,
        custom_help_center_domain: true,
        csat_reports: false,
      },
      max_agents: 10,
      max_channels_connected: 5,
    },
  } as any,
  globalSettings: {
    id: 'default',
    default_plan_slug: 'starter',
    default_trial_days: 14,
    default_features: {
      sla: false,
      ai_bot: false,
      csat_reports: true,
      api_webhooks: false,
    },
    default_limits: {
      max_agents: 3,
      max_channels_connected: 2,
    },
    default_ai_settings: {
      enabled: true,
      model: 'claude-3-5-haiku',
      monthly_token_cap: 200000,
      monthly_reply_cap: 500,
      monthly_cost_cap_usd: 25,
    },
    default_require_2fa: false,
    default_data_retention_days: 90,
  } as any,
  locks: [] as any[],
}));

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      let isSingle = false;
      let isMaybeSingle = false;
      const filters: any[] = [];

      const query: any = {
        select: vi.fn(() => query),
        eq: vi.fn((col: string, val: any) => {
          filters.push({ col, val });
          return query;
        }),
        single: vi.fn(async () => {
          isSingle = true;
          if (table === 'workspaces') {
            if (filters.some((f) => f.col === 'id' && f.val === fakeState.workspace.id)) {
              return { data: fakeState.workspace, error: null };
            }
            return { data: null, error: { message: 'Not found' } };
          }
          return { data: null, error: null };
        }),
        maybeSingle: vi.fn(async () => {
          isMaybeSingle = true;
          if (table === 'workspaces') {
            return { data: fakeState.workspace, error: null };
          }
          if (table === 'workspace_subscriptions') {
            return { data: fakeState.subscription, error: null };
          }
          if (table === 'platform_settings') {
            return { data: fakeState.globalSettings, error: null };
          }
          if (table === 'workspace_setting_locks') {
            const keyFilter = filters.find((f) => f.col === 'setting_key');
            const found = fakeState.locks.find((l) => !keyFilter || l.setting_key === keyFilter.val);
            return { data: found || null, error: null };
          }
          return { data: null, error: null };
        }),
        then: vi.fn((resolve: any) => {
          if (table === 'workspace_setting_locks') {
            return resolve({ data: fakeState.locks, error: null });
          }
          return resolve({ data: [], error: null });
        }),
      };
      return query;
    }),
  })),
}));

describe('Precedence & Settings Resolver (Requirement D)', () => {
  beforeEach(() => {
    fakeState.workspace = {
      id: WS_ID,
      name: 'Acme Test Workspace',
      widget_disabled: false,
      force_powered_by: 'inherited',
      help_center_enabled: true,
      require_2fa: false,
      data_retention_days: null,
      ai_monthly_reply_cap: null,
      ai_monthly_cost_cap_usd: null,
      channel_disabled_overrides: {},
      ai_settings: { enabled: true, model: 'claude-3-5-sonnet' },
    };
    fakeState.subscription = {
      id: 'sub-1',
      workspace_id: WS_ID,
      plan_id: 'pro',
      status: 'active',
      custom_features: {},
      custom_limits: {},
      plan: {
        id: 'plan-pro',
        slug: 'pro',
        name: 'Pro Plan',
        features: {
          sla: true,
          ai_bot: true,
          custom_help_center_domain: true,
          csat_reports: false,
        },
        max_agents: 10,
        max_channels_connected: 5,
      },
    };
    fakeState.locks = [];
  });

  it('resolves feature flags in precedence order: override > plan > global default', async () => {
    // 1. Plan features apply by default
    let effective = await getEffectiveWorkspaceSettings(WS_ID);
    expect(effective.features.sla).toEqual({
      enabled: true,
      source: 'plan',
    });

    // 2. Custom override takes precedence over plan
    fakeState.subscription.custom_features = {
      sla: false, // override to false even though plan has true
    };
    effective = await getEffectiveWorkspaceSettings(WS_ID);
    expect(effective.features.sla).toEqual({
      enabled: false,
      source: 'override',
    });

    // 3. Fallback to global default when plan does not specify feature
    // 'api_webhooks' is not on plan.features, but is in default_features (false)
    expect(effective.features.api_webhooks).toEqual({
      enabled: false,
      source: 'global_default',
    });
  });

  it('resolves limits in precedence order: override > plan > global default', async () => {
    // Plan limit applies
    let effective = await getEffectiveWorkspaceSettings(WS_ID);
    expect(effective.limits.max_agents).toEqual({
      value: 10,
      source: 'plan',
    });

    // Custom limit override takes precedence
    fakeState.subscription.custom_limits = {
      max_agents: 50,
    };
    effective = await getEffectiveWorkspaceSettings(WS_ID);
    expect(effective.limits.max_agents).toEqual({
      value: 50,
      source: 'override',
    });
  });

  it('resolves AI settings, channel overrides, widget and security settings', async () => {
    fakeState.workspace.ai_monthly_reply_cap = 2500;
    fakeState.workspace.channel_disabled_overrides = { tiktok: true };
    fakeState.workspace.widget_disabled = true;
    fakeState.workspace.require_2fa = true;

    const effective = await getEffectiveWorkspaceSettings(WS_ID);
    expect(effective.ai.monthly_reply_cap).toBe(2500);
    expect(effective.ai.source).toBe('override');
    expect(effective.channels.disabledOverrides.tiktok).toBe(true);
    expect(effective.widget.disabled).toBe(true);
    expect(effective.security.require2fa).toBe(true);
  });
});

describe('Workspace Setting Locks & Guard Assertions (Requirement C)', () => {
  beforeEach(() => {
    fakeState.locks = [
      {
        workspace_id: WS_ID,
        setting_key: 'widget_appearance',
        is_locked: true,
        reason: 'Brand consistency enforced',
      },
    ];
  });

  it('correctly reports locked status for a locked key and unlocked for others', async () => {
    const isLocked = await isWorkspaceSettingLocked(WS_ID, 'widget_appearance');
    expect(isLocked).toBe(true);

    const isUnlocked = await isWorkspaceSettingLocked(WS_ID, 'business_hours');
    expect(isUnlocked).toBe(false);
  });

  it('assertSettingNotLocked passes silently when key is unlocked', async () => {
    await expect(assertSettingNotLocked(WS_ID, 'business_hours')).resolves.not.toThrow();
  });

  it('assertSettingNotLocked throws 403 Forbidden when key is locked', async () => {
    await expect(assertSettingNotLocked(WS_ID, 'widget_appearance')).rejects.toThrow(
      /403 Forbidden: The setting "widget_appearance" is locked by Zentry platform administration/
    );
  });
});
