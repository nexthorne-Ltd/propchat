import { serviceClient } from '@/lib/supabase/service';
import { PlanFeatureKey, PlanLimitKey, FEATURE_MAP, LIMIT_MAP } from '@/lib/plans/features';
import { PlatformSettings } from '@/types/platform-management';
import { PlatformPlan, WorkspaceSubscription } from '@/types/plans';
import { Workspace, WorkspaceSettingLock } from '@/types/database';
import { userError } from '@/lib/errors/user-error';

export interface ResolvedWorkspaceSettings {
  workspace: Workspace;
  subscription: WorkspaceSubscription | null;
  plan: PlatformPlan | null;
  globalSettings: PlatformSettings | null;
  locks: Record<string, boolean>; // setting_key -> is_locked
  features: Record<PlanFeatureKey, {
    enabled: boolean;
    source: 'override' | 'plan' | 'global_default';
  }>;
  limits: Record<PlanLimitKey, {
    value: number | null;
    source: 'override' | 'plan' | 'global_default';
  }>;
  ai: {
    enabled: boolean;
    model: string;
    monthly_reply_cap: number | null;
    monthly_cost_cap_usd: number | null;
    monthly_token_cap: number | null;
    source: 'override' | 'global_default';
  };
  channels: {
    disabledOverrides: Record<string, boolean>;
    isOutboundBlocked: boolean;
  };
  widget: {
    disabled: boolean;
    forcePoweredBy: 'inherited' | 'force_on' | 'force_off';
  };
  helpCenter: {
    enabled: boolean;
    customDomain: string | null;
    isCustomDomainVerified: boolean;
  };
  security: {
    require2fa: boolean;
    dataRetentionDays: number | null;
  };
}

/**
 * Requirement D: Central precedence function used everywhere:
 * 1. My per-workspace override
 * 2. Plan
 * 3. Global default
 *
 * Existing workspaces keep working exactly as before: no default switches off
 * a feature they use now.
 */
export async function getEffectiveWorkspaceSettings(
  workspaceId: string
): Promise<ResolvedWorkspaceSettings> {
  const adminClient = serviceClient();

  const [
    { data: ws },
    { data: sub },
    { data: globalSettingsData },
    { data: locksData },
  ] = await Promise.all([
    adminClient.from('workspaces').select('*').eq('id', workspaceId).single(),
    adminClient.from('workspace_subscriptions').select('*, plan:platform_plans(*)').eq('workspace_id', workspaceId).maybeSingle(),
    adminClient.from('platform_settings').select('*').eq('id', 'default').maybeSingle(),
    adminClient.from('workspace_setting_locks').select('*').eq('workspace_id', workspaceId),
  ]);

  if (!ws) {
    throw userError(`Workspace not found: ${workspaceId}`);
  }

  const workspace = ws as Workspace;
  const subscription = sub as WorkspaceSubscription | null;
  const plan = (subscription?.plan as PlatformPlan) || null;
  const globalSettings = (globalSettingsData as PlatformSettings) || null;

  // Build locks map
  const locks: Record<string, boolean> = {};
  (locksData || []).forEach((l: WorkspaceSettingLock) => {
    locks[l.setting_key] = Boolean(l.is_locked);
  });

  // 1. Resolve Features (Override -> Plan -> Global Default)
  const features = {} as ResolvedWorkspaceSettings['features'];
  const customFeatures = (subscription?.custom_features || {}) as Record<string, boolean | undefined>;
  const planFeatures = (plan?.features || {}) as Record<string, boolean>;
  const defaultFeatures = (globalSettings?.default_features || {}) as Record<string, boolean>;

  for (const key of Array.from(FEATURE_MAP.keys())) {
    if (customFeatures[key] !== undefined) {
      features[key] = {
        enabled: Boolean(customFeatures[key]),
        source: 'override',
      };
    } else if (plan && planFeatures[key] !== undefined) {
      features[key] = {
        enabled: Boolean(planFeatures[key]),
        source: 'plan',
      };
    } else if (defaultFeatures[key] !== undefined) {
      features[key] = {
        enabled: Boolean(defaultFeatures[key]),
        source: 'global_default',
      };
    } else {
      // Grandfathered default: if no explicit configuration, keep standard starter/enabled for existing tools
      features[key] = {
        enabled: true,
        source: 'global_default',
      };
    }
  }

  // 2. Resolve Limits (Override -> Plan -> Global Default)
  const limits = {} as ResolvedWorkspaceSettings['limits'];
  const customLimits = (subscription?.custom_limits || {}) as Record<string, number | null | undefined>;
  const defaultLimits = (globalSettings?.default_limits || {}) as Record<string, number | null>;

  for (const key of Array.from(LIMIT_MAP.keys())) {
    if (customLimits[key] !== undefined) {
      limits[key] = {
        value: customLimits[key] ?? null,
        source: 'override',
      };
    } else if (plan && (plan as any)[key] !== undefined) {
      limits[key] = {
        value: (plan as any)[key] ?? null,
        source: 'plan',
      };
    } else if (defaultLimits[key] !== undefined) {
      limits[key] = {
        value: defaultLimits[key] ?? null,
        source: 'global_default',
      };
    } else {
      limits[key] = {
        value: null, // Unlimited fallback
        source: 'global_default',
      };
    }
  }

  // 3. Resolve AI settings
  const defaultAi = globalSettings?.default_ai_settings || {};
  const wsAi = (workspace.ai_settings || {}) as any;

  const aiEnabled = wsAi.enabled !== undefined
    ? Boolean(wsAi.enabled)
    : (defaultAi.enabled !== undefined ? Boolean(defaultAi.enabled) : true);

  const aiModel = wsAi.model || defaultAi.model || 'claude-3-5-sonnet';

  const aiReplyCap = workspace.ai_monthly_reply_cap !== null && workspace.ai_monthly_reply_cap !== undefined
    ? Number(workspace.ai_monthly_reply_cap)
    : (defaultAi.monthly_reply_cap ? Number(defaultAi.monthly_reply_cap) : null);

  const aiCostCap = workspace.ai_monthly_cost_cap_usd !== null && workspace.ai_monthly_cost_cap_usd !== undefined
    ? Number(workspace.ai_monthly_cost_cap_usd)
    : (defaultAi.monthly_cost_cap_usd ? Number(defaultAi.monthly_cost_cap_usd) : null);

  const aiTokenCap = (workspace as any).ai_monthly_token_cap !== null && (workspace as any).ai_monthly_token_cap !== undefined
    ? Number((workspace as any).ai_monthly_token_cap)
    : (defaultAi.monthly_token_cap ? Number(defaultAi.monthly_token_cap) : 500000);

  // 4. Resolve Channels
  const channelDisabledOverrides = (workspace.channel_disabled_overrides || {}) as Record<string, boolean>;
  const isOutboundBlocked = Boolean(workspace.is_outbound_blocked);

  // 5. Resolve Widget & Branding
  const widgetDisabled = Boolean(workspace.widget_disabled);
  const forcePoweredBy = workspace.force_powered_by || 'inherited';

  // 6. Resolve Help Center
  const helpCenterEnabled = workspace.help_center_enabled !== false;
  const customDomain = workspace.custom_domain || null;
  const isCustomDomainVerified = workspace.custom_domain_status === 'live' || workspace.custom_domain_status === 'verified';

  // 7. Resolve Security & Data
  const require2fa = workspace.require_2fa !== undefined && workspace.require_2fa !== null
    ? Boolean(workspace.require_2fa)
    : Boolean(globalSettings?.default_require_2fa);

  const dataRetentionDays = workspace.data_retention_days !== undefined && workspace.data_retention_days !== null
    ? workspace.data_retention_days
    : (globalSettings?.default_data_retention_days ?? null);

  return {
    workspace,
    subscription,
    plan,
    globalSettings,
    locks,
    features,
    limits,
    ai: {
      enabled: aiEnabled,
      model: aiModel,
      monthly_reply_cap: aiReplyCap,
      monthly_cost_cap_usd: aiCostCap,
      monthly_token_cap: aiTokenCap,
      source: workspace.ai_monthly_reply_cap ? 'override' : 'global_default',
    },
    channels: {
      disabledOverrides: channelDisabledOverrides,
      isOutboundBlocked,
    },
    widget: {
      disabled: widgetDisabled,
      forcePoweredBy,
    },
    helpCenter: {
      enabled: helpCenterEnabled,
      customDomain,
      isCustomDomainVerified,
    },
    security: {
      require2fa,
      dataRetentionDays,
    },
  };
}

/**
 * Checks if a specific setting is locked for a workspace.
 */
export async function isWorkspaceSettingLocked(
  workspaceId: string,
  settingKey: string
): Promise<boolean> {
  const adminClient = serviceClient();
  const { data } = await adminClient
    .from('workspace_setting_locks')
    .select('is_locked')
    .eq('workspace_id', workspaceId)
    .eq('setting_key', settingKey)
    .maybeSingle();

  return Boolean(data?.is_locked);
}

/**
 * Asserts that a setting is not locked. Throws 403 error if locked.
 */
export async function assertSettingNotLocked(
  workspaceId: string,
  settingKey: string
): Promise<void> {
  const locked = await isWorkspaceSettingLocked(workspaceId, settingKey);
  if (locked) {
    throw userError(
      `403 Forbidden: The setting "${settingKey}" is locked by Zentry platform administration and cannot be modified.`
    );
  }
}
