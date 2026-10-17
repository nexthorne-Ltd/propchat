import { serviceClient } from '@/lib/supabase/service';
import {
  PlanFeatureKey,
  PlanLimitKey,
  FEATURE_MAP,
  LIMIT_MAP,
  STARTER_FEATURES,
  LEGACY_FEATURES,
} from './features';
import {
  PlatformPlan,
  WorkspaceSubscription,
  WorkspaceUsageRecord,
  SubscriptionStatus,
} from '@/types/plans';
import { userError } from '@/lib/errors/user-error';

export interface EnforceFeatureResult {
  allowed: boolean;
  featureKey: PlanFeatureKey;
  featureName: string;
  planName: string;
  upgradeMessage?: string;
}

export interface EnforceLimitResult {
  allowed: boolean;
  limitKey: PlanLimitKey;
  limitName: string;
  currentUsage: number;
  limit: number | null;
  isUnlimited: boolean;
  isNearLimit: boolean; // >= 80% usage
  percentage: number;
  planName: string;
  upgradeMessage?: string;
  warnMessage?: string;
  warningMessage?: string;
}

export interface WorkspaceEffectivePlan {
  subscription: WorkspaceSubscription | null;
  plan: PlatformPlan;
  effectiveLimits: Record<PlanLimitKey, number | null>;
  effectiveFeatures: Record<PlanFeatureKey, boolean>;
  isTrialing: boolean;
  trialDaysRemaining: number | null;
  isTrialExpired: boolean;
  status: SubscriptionStatus;
}

/**
 * Fallback in-memory plans if database tables are unpopulated during transition/mocking
 */
const FALLBACK_LEGACY_PLAN: PlatformPlan = {
  id: '00000000-0000-4000-a000-000000000000',
  slug: 'legacy',
  name: 'Legacy (Unlimited)',
  description: 'Grandfathered plan for existing workspaces with unlimited resources.',
  monthly_price: 0,
  yearly_price: 0,
  currency: 'USD',
  trial_days: 0,
  visibility: 'hidden',
  custom_workspace_id: null,
  is_popular: false,
  is_archived: false,
  is_default: false,
  sort_order: 0,
  version: 1,
  max_agents: null,
  max_tickets_per_month: null,
  max_ai_bot_replies_per_month: null,
  max_channels_connected: null,
  max_articles: null,
  max_automations: null,
  max_storage_mb: null,
  max_api_requests_per_month: null,
  ai_enabled: true,
  ai_monthly_reply_limit: null,
  features: LEGACY_FEATURES,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

/**
 * Fetches the effective plan, subscription status, and all workspace overrides
 */
export async function getWorkspaceEffectivePlan(workspaceId: string): Promise<WorkspaceEffectivePlan> {
  const adminClient = serviceClient();

  // 1. Fetch subscription row
  const { data: subData } = await adminClient
    .from('workspace_subscriptions')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  let subscription: WorkspaceSubscription | null = subData as WorkspaceSubscription | null;
  let plan: PlatformPlan = FALLBACK_LEGACY_PLAN;

  if (subscription) {
    const { data: planData } = await adminClient
      .from('platform_plans')
      .select('*')
      .eq('id', subscription.plan_id)
      .maybeSingle();

    if (planData) {
      plan = planData as PlatformPlan;
    }
  } else {
    // Check if workspace has a legacy string plan or starter default
    const { data: wsData } = await adminClient
      .from('workspaces')
      .select('plan, created_at')
      .eq('id', workspaceId)
      .maybeSingle();

    const planSlug = wsData?.plan || 'legacy';
    const { data: matchedPlan } = await adminClient
      .from('platform_plans')
      .select('*')
      .eq('slug', planSlug)
      .maybeSingle();

    if (matchedPlan) {
      plan = matchedPlan as PlatformPlan;
    }
  }

  // 2. Compute effective limits (Custom overrides take precedence)
  const customLimits = subscription?.custom_limits || {};
  const effectiveLimits: Record<PlanLimitKey, number | null> = {
    max_agents: customLimits.max_agents !== undefined ? customLimits.max_agents : plan.max_agents,
    max_tickets_per_month: customLimits.max_tickets_per_month !== undefined ? customLimits.max_tickets_per_month : plan.max_tickets_per_month,
    max_ai_bot_replies_per_month:
      customLimits.max_ai_bot_replies_per_month !== undefined
        ? customLimits.max_ai_bot_replies_per_month
        : plan.ai_monthly_reply_limit !== undefined
        ? plan.ai_monthly_reply_limit
        : plan.max_ai_bot_replies_per_month,
    max_channels_connected: customLimits.max_channels_connected !== undefined ? customLimits.max_channels_connected : plan.max_channels_connected,
    max_articles: customLimits.max_articles !== undefined ? customLimits.max_articles : plan.max_articles,
    max_automations: customLimits.max_automations !== undefined ? customLimits.max_automations : plan.max_automations,
    max_storage_mb: customLimits.max_storage_mb !== undefined ? customLimits.max_storage_mb : plan.max_storage_mb,
    max_api_requests_per_month: customLimits.max_api_requests_per_month !== undefined ? customLimits.max_api_requests_per_month : plan.max_api_requests_per_month,
  };

  // 3. Compute effective features (Custom overrides take precedence)
  const customFeatures = subscription?.custom_features || {};
  const baseFeatures = plan.features || STARTER_FEATURES;
  const effectiveFeatures: Record<PlanFeatureKey, boolean> = { ...baseFeatures };

  if (plan.ai_enabled !== undefined) {
    effectiveFeatures.ai_bot = Boolean(plan.ai_enabled);
  }

  for (const [k, v] of Object.entries(customFeatures)) {
    if (v !== undefined) {
      effectiveFeatures[k as PlanFeatureKey] = Boolean(v);
    }
  }

  // 4. Trial evaluation
  const now = new Date();
  const status: SubscriptionStatus = subscription?.status || 'active';
  const isTrialing = status === 'trialing';
  let trialDaysRemaining: number | null = null;
  let isTrialExpired = false;

  let effectiveStatus = status;
  if (subscription?.trial_ends_at) {
    const trialEnd = new Date(subscription.trial_ends_at);
    const diffMs = trialEnd.getTime() - now.getTime();
    trialDaysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    if (diffMs <= 0 && isTrialing) {
      isTrialExpired = true;
      effectiveStatus = 'past_due';
    }
  }

  return {
    subscription,
    plan,
    effectiveLimits,
    effectiveFeatures,
    isTrialing,
    trialDaysRemaining,
    isTrialExpired,
    status: effectiveStatus,
  };
}

/**
 * Calculates current resource usage for a given limit key
 */
export async function getWorkspaceCurrentUsage(
  workspaceId: string,
  limitKey: PlanLimitKey
): Promise<number> {
  const adminClient = serviceClient();

  switch (limitKey) {
    case 'max_agents': {
      const { count } = await adminClient
        .from('agents')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .neq('is_active', false);
      return count || 0;
    }

    case 'max_channels_connected': {
      const { count } = await adminClient
        .from('channel_connections')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .neq('status', 'disconnected');
      return count || 0;
    }

    case 'max_articles': {
      const { count } = await adminClient
        .from('articles')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId);
      return count || 0;
    }

    case 'max_automations': {
      const { count } = await adminClient
        .from('automation_rules')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('is_active', true);
      return count || 0;
    }

    case 'max_tickets_per_month': {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { count } = await adminClient
        .from('tickets')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .gte('created_at', thirtyDaysAgo);
      return count || 0;
    }

    case 'max_ai_bot_replies_per_month': {
      const now = new Date();
      const currentPeriodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toISOString()
        .split('T')[0];

      const { data: aiUsage } = await adminClient
        .from('workspace_ai_usage')
        .select('replies_used')
        .eq('workspace_id', workspaceId)
        .eq('period_start', currentPeriodStart)
        .maybeSingle();

      if (aiUsage && typeof aiUsage.replies_used === 'number') {
        return aiUsage.replies_used;
      }

      // Fallback: Query workspace_usage record or fallback to messages sent by ai in 30 days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: usageRow } = await adminClient
        .from('workspace_usage')
        .select('ai_bot_replies_count')
        .eq('workspace_id', workspaceId)
        .order('period_start', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (usageRow?.ai_bot_replies_count !== undefined) {
        return usageRow.ai_bot_replies_count;
      }

      // Count directly from messages
      const { count } = await adminClient
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'ai')
        .gte('created_at', thirtyDaysAgo);
      return count || 0;
    }

    case 'max_storage_mb': {
      const { data: usageRow } = await adminClient
        .from('workspace_usage')
        .select('storage_bytes')
        .eq('workspace_id', workspaceId)
        .order('period_start', { ascending: false })
        .limit(1)
        .maybeSingle();

      const bytes = usageRow?.storage_bytes || 0;
      return Math.round(Number(bytes) / (1024 * 1024));
    }

    case 'max_api_requests_per_month': {
      const { data: usageRow } = await adminClient
        .from('workspace_usage')
        .select('api_requests_count')
        .eq('workspace_id', workspaceId)
        .order('period_start', { ascending: false })
        .limit(1)
        .maybeSingle();

      return usageRow?.api_requests_count || 0;
    }

    default:
      return 0;
  }
}

/**
 * Safely increment usage counter in workspace_usage for period-metered limits
 */
export async function incrementWorkspaceUsage(
  workspaceId: string,
  field: 'tickets' | 'ai_replies' | 'api_requests',
  amount = 1
): Promise<void> {
  try {
    const adminClient = serviceClient();
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

    const { data: existing } = await adminClient
      .from('workspace_usage')
      .select('id, tickets_count, ai_bot_replies_count, api_requests_count')
      .eq('workspace_id', workspaceId)
      .eq('period_start', periodStart)
      .maybeSingle();

    if (existing) {
      const patch: Record<string, any> = { updated_at: now.toISOString() };
      if (field === 'tickets') patch.tickets_count = (existing.tickets_count || 0) + amount;
      if (field === 'ai_replies') patch.ai_bot_replies_count = (existing.ai_bot_replies_count || 0) + amount;
      if (field === 'api_requests') patch.api_requests_count = (existing.api_requests_count || 0) + amount;

      await adminClient.from('workspace_usage').update(patch).eq('id', existing.id);
    } else {
      await adminClient.from('workspace_usage').insert({
        workspace_id: workspaceId,
        period_start: periodStart,
        period_end: periodEnd,
        tickets_count: field === 'tickets' ? amount : 0,
        ai_bot_replies_count: field === 'ai_replies' ? amount : 0,
        api_requests_count: field === 'api_requests' ? amount : 0,
        storage_bytes: 0,
      });
    }
  } catch (err) {
    console.error('[Usage Tracking Error]:', err);
  }
}

/**
 * Checks whether a feature is permitted on the workspace
 */
export async function checkWorkspaceFeature(
  workspaceId: string,
  featureKey: PlanFeatureKey
): Promise<EnforceFeatureResult> {
  const { plan, effectiveFeatures, isTrialExpired, status } = await getWorkspaceEffectivePlan(workspaceId);
  const def = FEATURE_MAP.get(featureKey);
  const featureName = def?.name || featureKey;

  // Account suspension block
  if (status === 'suspended') {
    return {
      allowed: false,
      featureKey,
      featureName,
      planName: plan.name,
      upgradeMessage: 'Account suspended: Your workspace has been suspended. Please contact platform administration.',
    };
  }

  // Expired trial block
  if (isTrialExpired) {
    return {
      allowed: false,
      featureKey,
      featureName,
      planName: plan.name,
      upgradeMessage: `Trial expired: Your ${plan.name} free trial has ended. Please upgrade your subscription to continue using ${featureName}.`,
    };
  }

  const isEnabled = Boolean(effectiveFeatures[featureKey]);

  if (!isEnabled) {
    return {
      allowed: false,
      featureKey,
      featureName,
      planName: plan.name,
      upgradeMessage: `Upgrade required: ${featureName} is not included in the ${plan.name} plan. Upgrade to a higher plan to unlock this feature.`,
    };
  }

  return {
    allowed: true,
    featureKey,
    featureName,
    planName: plan.name,
  };
}

/**
 * Throws a friendly upgrade error if feature is unavailable
 */
export async function assertWorkspaceFeature(
  workspaceId: string,
  featureKey: PlanFeatureKey
): Promise<void> {
  const result = await checkWorkspaceFeature(workspaceId, featureKey);
  if (!result.allowed) {
    throw userError(result.upgradeMessage || `Feature not available on your current plan.`);
  }
}

/**
 * Checks resource usage against the plan limit, calculates 80% threshold warning
 */
export async function checkWorkspaceLimit(
  workspaceId: string,
  limitKey: PlanLimitKey,
  increment = 1
): Promise<EnforceLimitResult> {
  const { plan, effectiveLimits, isTrialExpired, status } = await getWorkspaceEffectivePlan(workspaceId);
  const def = LIMIT_MAP.get(limitKey);
  const limitName = def?.name || limitKey;
  const unit = def?.unit || 'units';

  if (status === 'suspended') {
    return {
      allowed: false,
      limitKey,
      limitName,
      currentUsage: 0,
      limit: 0,
      isUnlimited: false,
      isNearLimit: true,
      percentage: 100,
      planName: plan.name,
      upgradeMessage: 'Account suspended: Your workspace has been suspended. Please contact platform administration.',
    };
  }

  if (isTrialExpired) {
    return {
      allowed: false,
      limitKey,
      limitName,
      currentUsage: 0,
      limit: 0,
      isUnlimited: false,
      isNearLimit: true,
      percentage: 100,
      planName: plan.name,
      upgradeMessage: `Trial expired: Your ${plan.name} trial has ended. Please upgrade your subscription to add more ${unit}.`,
    };
  }

  const limitValue = effectiveLimits[limitKey];
  const isUnlimited = limitValue === null || limitValue === undefined;

  const currentUsage = await getWorkspaceCurrentUsage(workspaceId, limitKey);

  if (isUnlimited) {
    return {
      allowed: true,
      limitKey,
      limitName,
      currentUsage,
      limit: null,
      isUnlimited: true,
      isNearLimit: false,
      percentage: 0,
      planName: plan.name,
    };
  }

  const projectedUsage = currentUsage + increment;
  const percentage = Math.round((currentUsage / limitValue) * 100);
  const isNearLimit = percentage >= 80;

  let warnMessage: string | undefined;
  if (isNearLimit && currentUsage < limitValue) {
    warnMessage = `Approaching plan limit: You have used ${percentage}% (${currentUsage}/${limitValue} ${unit}) of your ${limitName} allowance on the ${plan.name} plan.`;
  }

  if (projectedUsage > limitValue) {
    return {
      allowed: false,
      limitKey,
      limitName,
      currentUsage,
      limit: limitValue,
      isUnlimited: false,
      isNearLimit: true,
      percentage,
      planName: plan.name,
      upgradeMessage: `Plan limit reached: Your current ${plan.name} plan allows up to ${limitValue} ${unit} (${currentUsage} currently in use). Upgrade your plan to increase capacity.`,
    };
  }

  return {
    allowed: true,
    limitKey,
    limitName,
    currentUsage,
    limit: limitValue,
    isUnlimited: false,
    isNearLimit,
    percentage,
    planName: plan.name,
    warnMessage,
    warningMessage: warnMessage,
  };
}

/**
 * Throws a friendly upgrade error if resource limit would be exceeded
 */
export async function assertWorkspaceLimit(
  workspaceId: string,
  limitKey: PlanLimitKey,
  increment = 1
): Promise<EnforceLimitResult> {
  const result = await checkWorkspaceLimit(workspaceId, limitKey, increment);
  if (!result.allowed) {
    throw userError(result.upgradeMessage || `Plan limit reached. Upgrade your plan to continue.`);
  }
  return result;
}
