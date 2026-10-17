'use server';

import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { assertPlatformOwner, assertSuperAdmin, recordSuperAdminAudit } from '@/app/actions/platform';
import { assertAdminUser } from '@/app/actions/admin';
import {
  PlatformPlan,
  PlatformCoupon,
  WorkspaceSubscription,
  WorkspaceBillingOverview,
  WorkspaceUsageMetric,
  WorkspaceFeatureItem,
  SubscriptionStatus,
  BillingPeriod,
} from '@/types/plans';
import {
  PLAN_FEATURES,
  PLAN_LIMITS,
  PlanFeatureKey,
  PlanLimitKey,
  STARTER_FEATURES,
  PRO_FEATURES,
  ENTERPRISE_FEATURES,
  LEGACY_FEATURES,
} from '@/lib/plans/features';
import {
  getWorkspaceEffectivePlan,
  getWorkspaceCurrentUsage,
} from '@/lib/plans/enforce';
import { userError } from '@/lib/errors/user-error';

/**
 * 1. Retrieves all plans for Platform Super Admin management
 */
export async function getPlatformPlansAction(): Promise<{
  plans: PlatformPlan[];
  callerIsOwner: boolean;
}> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  const { data, error } = await adminClient
    .from('platform_plans')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    throw userError(`Failed to load platform plans: ${error.message}`);
  }

  const callerIsOwner = Boolean(agent.is_platform_owner);

  return {
    plans: (data || []) as PlatformPlan[],
    callerIsOwner,
  };
}

/**
 * 2. Retrieves public plans for the /pricing marketing page
 */
export async function getPublicPlansAction(): Promise<PlatformPlan[]> {
  try {
    const adminClient = serviceClient();
    const { data, error } = await adminClient
      .from('platform_plans')
      .select('*')
      .eq('visibility', 'public')
      .eq('is_archived', false)
      .order('sort_order', { ascending: true });

    if (!error && data && data.length > 0) {
      return data as PlatformPlan[];
    }
  } catch (err) {
    console.warn('[Public Plans Fallback]:', err);
  }

  // Fallback default tiers for resilience
  return [
    {
      id: 'plan-starter',
      slug: 'starter',
      name: 'Starter',
      description: 'Essential customer messaging and AI assistance for small growing teams.',
      monthly_price: 29,
      yearly_price: 290,
      currency: 'USD',
      trial_days: 14,
      visibility: 'public',
      custom_workspace_id: null,
      is_popular: false,
      is_archived: false,
      is_default: true,
      sort_order: 1,
      version: 1,
      max_agents: 3,
      max_tickets_per_month: 500,
      max_ai_bot_replies_per_month: 200,
      max_channels_connected: 2,
      max_articles: 25,
      max_automations: 5,
      max_storage_mb: 1024,
      max_api_requests_per_month: 1000,
      ai_enabled: true,
      ai_monthly_reply_limit: 200,
      features: STARTER_FEATURES,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'plan-pro',
      slug: 'pro',
      name: 'Pro',
      description: 'Advanced omnichannel automation, custom roles, SLA policies, and full AI copilot.',
      monthly_price: 79,
      yearly_price: 790,
      currency: 'USD',
      trial_days: 14,
      visibility: 'public',
      custom_workspace_id: null,
      is_popular: true,
      is_archived: false,
      is_default: false,
      sort_order: 2,
      version: 1,
      max_agents: 10,
      max_tickets_per_month: 2500,
      max_ai_bot_replies_per_month: 1000,
      max_channels_connected: 10,
      max_articles: 100,
      max_automations: 25,
      max_storage_mb: 10240,
      max_api_requests_per_month: 10000,
      ai_enabled: true,
      ai_monthly_reply_limit: 1000,
      features: PRO_FEATURES,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'plan-enterprise',
      slug: 'enterprise',
      name: 'Enterprise',
      description: 'Maximum performance, unbranded white-labeling, custom domains, and dedicated scale.',
      monthly_price: 199,
      yearly_price: 1990,
      currency: 'USD',
      trial_days: 0,
      visibility: 'public',
      custom_workspace_id: null,
      is_popular: false,
      is_archived: false,
      is_default: false,
      sort_order: 3,
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
      features: ENTERPRISE_FEATURES,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
}

/**
 * 3. Create or Edit a Plan (Handles Price Versioning)
 */
export async function savePlanAction(input: {
  id?: string;
  name: string;
  slug?: string;
  description: string;
  monthly_price: number;
  yearly_price: number;
  currency?: string;
  trial_days: number;
  visibility: 'public' | 'hidden' | 'custom';
  custom_workspace_id?: string | null;
  is_popular?: boolean;
  is_default?: boolean;
  sort_order?: number;
  max_agents: number | null;
  max_tickets_per_month: number | null;
  max_ai_bot_replies_per_month: number | null;
  max_channels_connected: number | null;
  max_articles: number | null;
  max_automations: number | null;
  max_storage_mb: number | null;
  max_api_requests_per_month: number | null;
  ai_enabled?: boolean;
  ai_monthly_reply_limit?: number | null;
  features: Record<PlanFeatureKey, boolean>;
}): Promise<{ success: boolean; plan?: PlatformPlan; error?: string }> {
  const { agent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  try {
    const cleanName = input.name.trim();
    if (!cleanName) {
      return { success: false, error: 'Plan name is required.' };
    }

    const cleanSlug = (input.slug || cleanName)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-');

    if (input.id) {
      // Fetch existing plan to check if price or specs changed for versioning
      const { data: existing } = await adminClient
        .from('platform_plans')
        .select('*')
        .eq('id', input.id)
        .single();

      if (!existing) {
        return { success: false, error: 'Plan not found.' };
      }

      const isPriceChanged =
        Number(existing.monthly_price) !== Number(input.monthly_price) ||
        Number(existing.yearly_price) !== Number(input.yearly_price);

      const nextVersion = isPriceChanged ? existing.version + 1 : existing.version;

      // If marked default, unset others
      if (input.is_default && !existing.is_default) {
        await adminClient.from('platform_plans').update({ is_default: false }).neq('id', input.id);
      }

      const updatePayload: Record<string, any> = {
        name: cleanName,
        description: input.description.trim(),
        monthly_price: input.monthly_price,
        yearly_price: input.yearly_price,
        currency: input.currency || 'USD',
        trial_days: Math.max(0, input.trial_days || 0),
        visibility: input.visibility,
        custom_workspace_id: input.visibility === 'custom' ? input.custom_workspace_id || null : null,
        is_popular: Boolean(input.is_popular),
        is_default: Boolean(input.is_default),
        version: nextVersion,
        max_agents: input.max_agents,
        max_tickets_per_month: input.max_tickets_per_month,
        max_ai_bot_replies_per_month: input.max_ai_bot_replies_per_month,
        max_channels_connected: input.max_channels_connected,
        max_articles: input.max_articles,
        max_automations: input.max_automations,
        max_storage_mb: input.max_storage_mb,
        max_api_requests_per_month: input.max_api_requests_per_month,
        ai_enabled: input.ai_enabled ?? existing.ai_enabled ?? true,
        ai_monthly_reply_limit: input.ai_monthly_reply_limit !== undefined ? input.ai_monthly_reply_limit : existing.ai_monthly_reply_limit,
        features: input.features,
        updated_at: new Date().toISOString(),
      };

      const { data: updated, error: updateErr } = await adminClient
        .from('platform_plans')
        .update(updatePayload)
        .eq('id', input.id)
        .select()
        .single();

      if (updateErr) throw updateErr;

      // Record snapshot in version table if new version created
      if (isPriceChanged) {
        await adminClient.from('platform_plan_versions').insert({
          plan_id: input.id,
          version: nextVersion,
          monthly_price: input.monthly_price,
          yearly_price: input.yearly_price,
          currency: input.currency || 'USD',
          max_agents: input.max_agents,
          max_tickets_per_month: input.max_tickets_per_month,
          max_ai_bot_replies_per_month: input.max_ai_bot_replies_per_month,
          max_channels_connected: input.max_channels_connected,
          max_articles: input.max_articles,
          max_automations: input.max_automations,
          max_storage_mb: input.max_storage_mb,
          max_api_requests_per_month: input.max_api_requests_per_month,
          ai_enabled: updatePayload.ai_enabled,
          ai_monthly_reply_limit: updatePayload.ai_monthly_reply_limit,
          features: input.features,
        });
      }

      await recordSuperAdminAudit({
        admin: agent,
        action: 'plan_updated',
        details: { plan_id: input.id, name: cleanName, version: nextVersion, isPriceChanged },
      });

      return { success: true, plan: updated as PlatformPlan };
    } else {
      // Create new plan
      if (input.is_default) {
        await adminClient.from('platform_plans').update({ is_default: false }).eq('is_default', true);
      }

      const insertPayload: Record<string, any> = {
        name: cleanName,
        slug: cleanSlug,
        description: input.description.trim(),
        monthly_price: input.monthly_price,
        yearly_price: input.yearly_price,
        currency: input.currency || 'USD',
        trial_days: Math.max(0, input.trial_days || 0),
        visibility: input.visibility,
        custom_workspace_id: input.visibility === 'custom' ? input.custom_workspace_id || null : null,
        is_popular: Boolean(input.is_popular),
        is_default: Boolean(input.is_default),
        sort_order: input.sort_order ?? 10,
        version: 1,
        max_agents: input.max_agents,
        max_tickets_per_month: input.max_tickets_per_month,
        max_ai_bot_replies_per_month: input.max_ai_bot_replies_per_month,
        max_channels_connected: input.max_channels_connected,
        max_articles: input.max_articles,
        max_automations: input.max_automations,
        max_storage_mb: input.max_storage_mb,
        max_api_requests_per_month: input.max_api_requests_per_month,
        ai_enabled: input.ai_enabled ?? true,
        ai_monthly_reply_limit: input.ai_monthly_reply_limit ?? null,
        features: input.features,
      };

      const { data: created, error: createErr } = await adminClient
        .from('platform_plans')
        .insert(insertPayload)
        .select()
        .single();

      if (createErr) throw createErr;

      // Insert version 1
      await adminClient.from('platform_plan_versions').insert({
        plan_id: created.id,
        version: 1,
        monthly_price: input.monthly_price,
        yearly_price: input.yearly_price,
        currency: input.currency || 'USD',
        max_agents: input.max_agents,
        max_tickets_per_month: input.max_tickets_per_month,
        max_ai_bot_replies_per_month: input.max_ai_bot_replies_per_month,
        max_channels_connected: input.max_channels_connected,
        max_articles: input.max_articles,
        max_automations: input.max_automations,
        max_storage_mb: input.max_storage_mb,
        max_api_requests_per_month: input.max_api_requests_per_month,
        ai_enabled: insertPayload.ai_enabled,
        ai_monthly_reply_limit: insertPayload.ai_monthly_reply_limit,
        features: input.features,
      });

      await recordSuperAdminAudit({
        admin: agent,
        action: 'plan_created',
        details: { plan_id: created.id, name: cleanName, slug: cleanSlug },
      });

      return { success: true, plan: created as PlatformPlan };
    }
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to save plan.' };
  }
}

/**
 * 4. Duplicate an existing plan
 */
export async function duplicatePlanAction(planId: string): Promise<{ success: boolean; plan?: PlatformPlan; error?: string }> {
  const { agent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  try {
    const { data: src, error: srcErr } = await adminClient
      .from('platform_plans')
      .select('*')
      .eq('id', planId)
      .single();

    if (srcErr || !src) throw userError('Source plan not found.');

    const copySlug = `${src.slug}-copy-${Date.now().toString().slice(-4)}`;
    const copyName = `${src.name} (Copy)`;

    const { data: created, error: createErr } = await adminClient
      .from('platform_plans')
      .insert({
        name: copyName,
        slug: copySlug,
        description: src.description,
        monthly_price: src.monthly_price,
        yearly_price: src.yearly_price,
        currency: src.currency,
        trial_days: src.trial_days,
        visibility: 'hidden', // Draft/hidden by default
        is_popular: false,
        is_archived: false,
        is_default: false,
        sort_order: (src.sort_order || 0) + 1,
        version: 1,
        max_agents: src.max_agents,
        max_tickets_per_month: src.max_tickets_per_month,
        max_ai_bot_replies_per_month: src.max_ai_bot_replies_per_month,
        max_channels_connected: src.max_channels_connected,
        max_articles: src.max_articles,
        max_automations: src.max_automations,
        max_storage_mb: src.max_storage_mb,
        max_api_requests_per_month: src.max_api_requests_per_month,
        features: src.features,
      })
      .select()
      .single();

    if (createErr) throw createErr;

    await recordSuperAdminAudit({
      admin: agent,
      action: 'plan_duplicated',
      details: { source_plan_id: planId, new_plan_id: created.id },
    });

    return { success: true, plan: created as PlatformPlan };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to duplicate plan.' };
  }
}

/**
 * 5. Archive / Unarchive a plan
 */
export async function archivePlanAction(
  planId: string,
  isArchived: boolean
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  try {
    const { error } = await adminClient
      .from('platform_plans')
      .update({ is_archived: isArchived, updated_at: new Date().toISOString() })
      .eq('id', planId);

    if (error) throw error;

    await recordSuperAdminAudit({
      admin: agent,
      action: isArchived ? 'plan_archived' : 'plan_unarchived',
      details: { plan_id: planId },
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to archive plan.' };
  }
}

/**
 * 6. Reorder plans display order
 */
export async function reorderPlansAction(
  orderedIds: string[]
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  try {
    const updates = orderedIds.map((id, index) =>
      adminClient.from('platform_plans').update({ sort_order: index + 1 }).eq('id', id)
    );
    await Promise.all(updates);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'plans_reordered',
      details: { count: orderedIds.length },
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to reorder plans.' };
  }
}

/**
 * 7. Coupons: List, Save, Delete, Validate
 */
export async function getPlatformCouponsAction(): Promise<PlatformCoupon[]> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { data, error } = await adminClient
    .from('platform_coupons')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    throw userError(`Failed to load coupons: ${error.message}`);
  }

  return (data || []) as PlatformCoupon[];
}

export async function saveCouponAction(input: {
  id?: string;
  code: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  currency?: string;
  valid_from?: string;
  valid_until?: string | null;
  max_redemptions?: number | null;
  allowed_plan_ids?: string[] | null;
  is_active?: boolean;
}): Promise<{ success: boolean; coupon?: PlatformCoupon; error?: string }> {
  const { agent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  try {
    const cleanCode = input.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!cleanCode) return { success: false, error: 'Coupon code is required.' };
    if (input.discount_value <= 0) return { success: false, error: 'Discount value must be greater than 0.' };
    if (input.discount_type === 'percentage' && input.discount_value > 100) {
      return { success: false, error: 'Percentage discount cannot exceed 100%.' };
    }

    if (input.id) {
      const { data, error } = await adminClient
        .from('platform_coupons')
        .update({
          code: cleanCode,
          discount_type: input.discount_type,
          discount_value: input.discount_value,
          currency: input.currency || 'USD',
          valid_until: input.valid_until || null,
          max_redemptions: input.max_redemptions || null,
          allowed_plan_ids: input.allowed_plan_ids || null,
          is_active: input.is_active ?? true,
        })
        .eq('id', input.id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, coupon: data as PlatformCoupon };
    } else {
      const { data, error } = await adminClient
        .from('platform_coupons')
        .insert({
          code: cleanCode,
          discount_type: input.discount_type,
          discount_value: input.discount_value,
          currency: input.currency || 'USD',
          valid_until: input.valid_until || null,
          max_redemptions: input.max_redemptions || null,
          allowed_plan_ids: input.allowed_plan_ids || null,
          is_active: input.is_active ?? true,
        })
        .select()
        .single();

      if (error) throw error;

      await recordSuperAdminAudit({
        admin: agent,
        action: 'coupon_created',
        details: { code: cleanCode, discount_type: input.discount_type, discount_value: input.discount_value },
      });

      return { success: true, coupon: data as PlatformCoupon };
    }
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to save coupon.' };
  }
}

export async function deleteCouponAction(
  couponId: string
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  try {
    const { error } = await adminClient.from('platform_coupons').delete().eq('id', couponId);
    if (error) throw error;

    await recordSuperAdminAudit({
      admin: agent,
      action: 'coupon_deleted',
      details: { coupon_id: couponId },
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to delete coupon.' };
  }
}

export async function validateCouponAction(
  code: string,
  planId?: string
): Promise<{
  valid: boolean;
  coupon?: PlatformCoupon;
  discountSummary?: string;
  error?: string;
}> {
  const adminClient = serviceClient();
  const cleanCode = code.trim().toUpperCase();

  const { data: coupon, error } = await adminClient
    .from('platform_coupons')
    .select('*')
    .eq('code', cleanCode)
    .maybeSingle();

  if (error || !coupon) {
    return { valid: false, error: 'Coupon code not found.' };
  }

  if (!coupon.is_active) {
    return { valid: false, error: 'This coupon is no longer active.' };
  }

  const now = new Date();
  if (coupon.valid_until && new Date(coupon.valid_until) < now) {
    return { valid: false, error: 'This coupon has expired.' };
  }

  if (coupon.max_redemptions && coupon.redemptions_count >= coupon.max_redemptions) {
    return { valid: false, error: 'This coupon has reached its maximum redemptions.' };
  }

  if (planId && coupon.allowed_plan_ids && coupon.allowed_plan_ids.length > 0) {
    if (!coupon.allowed_plan_ids.includes(planId)) {
      return { valid: false, error: 'This coupon is not valid for the selected plan.' };
    }
  }

  const discountSummary =
    coupon.discount_type === 'percentage'
      ? `${coupon.discount_value}% discount`
      : `$${coupon.discount_value} discount`;

  return {
    valid: true,
    coupon: coupon as PlatformCoupon,
    discountSummary,
  };
}

/**
 * 8. Subscriptions Management (Super Admin & Workspace)
 */
export async function getWorkspaceSubscriptionAction(
  workspaceId: string
): Promise<{
  subscription: WorkspaceSubscription | null;
  plan: PlatformPlan | null;
  plansList: PlatformPlan[];
}> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const [
    { data: sub },
    { data: plans },
  ] = await Promise.all([
    adminClient.from('workspace_subscriptions').select('*, plan:platform_plans(*)').eq('workspace_id', workspaceId).maybeSingle(),
    adminClient.from('platform_plans').select('*').order('sort_order', { ascending: true }),
  ]);

  return {
    subscription: (sub as WorkspaceSubscription) || null,
    plan: sub?.plan ? (sub.plan as PlatformPlan) : null,
    plansList: (plans || []) as PlatformPlan[],
  };
}

export async function updateWorkspaceSubscriptionAction(input: {
  workspaceId: string;
  planId: string;
  status?: SubscriptionStatus;
  billingPeriod?: BillingPeriod;
  extendTrialDays?: number;
  customLimits?: Partial<Record<PlanLimitKey, number | null>>;
  customFeatures?: Partial<Record<PlanFeatureKey, boolean>>;
  adminNote?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  try {
    // Verify target plan exists
    const { data: targetPlan } = await adminClient
      .from('platform_plans')
      .select('*')
      .eq('id', input.planId)
      .single();

    if (!targetPlan) {
      return { success: false, error: 'Target plan does not exist.' };
    }

    const { data: currentSub } = await adminClient
      .from('workspace_subscriptions')
      .select('*')
      .eq('workspace_id', input.workspaceId)
      .maybeSingle();

    const now = new Date();
    let trialEndsAt: string | null = currentSub?.trial_ends_at || null;

    if (input.extendTrialDays && input.extendTrialDays > 0) {
      const baseDate = trialEndsAt ? new Date(trialEndsAt) : now;
      const targetDate = baseDate > now ? baseDate : now;
      targetDate.setDate(targetDate.getDate() + input.extendTrialDays);
      trialEndsAt = targetDate.toISOString();
    }

    const payload: Record<string, any> = {
      workspace_id: input.workspaceId,
      plan_id: input.planId,
      plan_version: targetPlan.version,
      status: input.status || currentSub?.status || 'active',
      billing_period: input.billingPeriod || currentSub?.billing_period || 'monthly',
      trial_ends_at: trialEndsAt,
      custom_limits: input.customLimits ?? (currentSub?.custom_limits || {}),
      custom_features: input.customFeatures ?? (currentSub?.custom_features || {}),
      admin_note: input.adminNote ?? currentSub?.admin_note ?? null,
      updated_at: now.toISOString(),
    };

    if (currentSub) {
      await adminClient.from('workspace_subscriptions').update(payload).eq('id', currentSub.id);
    } else {
      payload.current_period_start = now.toISOString();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      payload.current_period_end = periodEnd.toISOString();
      await adminClient.from('workspace_subscriptions').insert(payload);
    }

    // Keep workspace table's legacy plan column in sync
    await adminClient
      .from('workspaces')
      .update({ plan: targetPlan.slug })
      .eq('id', input.workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'workspace_subscription_updated',
      workspaceId: input.workspaceId,
      details: {
        plan_id: input.planId,
        plan_slug: targetPlan.slug,
        status: payload.status,
        extend_trial_days: input.extendTrialDays,
      },
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to update subscription.' };
  }
}

/**
 * 9. Workspace Settings > Billing Overview
 */
export async function getWorkspaceBillingAndUsageAction(
  workspaceId: string
): Promise<WorkspaceBillingOverview> {
  const { agent } = await assertAdminUser(workspaceId);
  const canManageBilling = agent.role === 'owner';

  const effective = await getWorkspaceEffectivePlan(workspaceId);

  // Compute metrics for all 8 limits
  const limits: WorkspaceUsageMetric[] = await Promise.all(
    PLAN_LIMITS.map(async (def) => {
      const currentUsage = await getWorkspaceCurrentUsage(workspaceId, def.id);
      const limitVal = effective.effectiveLimits[def.id];
      const isUnlimited = limitVal === null || limitVal === undefined;
      const percentage = isUnlimited || !limitVal ? 0 : Math.min(100, Math.round((currentUsage / limitVal) * 100));
      const isNearLimit = percentage >= 80;

      return {
        key: def.id,
        name: def.name,
        unit: def.unit,
        currentUsage,
        limit: limitVal,
        isUnlimited,
        isNearLimit,
        percentage,
      };
    })
  );

  // Map features list
  const features: WorkspaceFeatureItem[] = PLAN_FEATURES.map((feat) => ({
    key: feat.id,
    name: feat.name,
    description: feat.description,
    category: feat.category,
    enabled: Boolean(effective.effectiveFeatures[feat.id]),
  }));

  const sub = effective.subscription
    ? { ...effective.subscription, status: effective.status }
    : {
        id: 'sub-legacy',
        workspace_id: workspaceId,
        plan_id: effective.plan.id,
        plan_version: effective.plan.version,
        status: effective.status,
        billing_period: 'yearly' as BillingPeriod,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        trial_ends_at: null,
        canceled_at: null,
        custom_limits: {},
        custom_features: {},
        admin_note: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

  return {
    subscription: sub,
    plan: effective.plan,
    limits,
    features,
    trialDaysRemaining: effective.trialDaysRemaining,
    isTrialExpired: effective.isTrialExpired,
    canManageBilling,
  };
}

/**
 * 10. Apply Coupon to Workspace Subscription
 */
export async function applyCouponToWorkspaceAction(
  workspaceId: string,
  couponCode: string
): Promise<{ success: boolean; discountSummary?: string; error?: string }> {
  await assertAdminUser(workspaceId);
  const adminClient = serviceClient();

  const valRes = await validateCouponAction(couponCode);
  if (!valRes.valid || !valRes.coupon) {
    return { success: false, error: valRes.error || 'Invalid coupon.' };
  }

  const coupon = valRes.coupon;

  // Increment redemption count
  await adminClient
    .from('platform_coupons')
    .update({ redemptions_count: (coupon.redemptions_count || 0) + 1 })
    .eq('id', coupon.id);

  // Record in subscription admin note
  const { data: sub } = await adminClient
    .from('workspace_subscriptions')
    .select('admin_note')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  const noteAddition = `[Coupon Applied: ${coupon.code} (${valRes.discountSummary})]`;
  const newNote = sub?.admin_note ? `${sub.admin_note} ${noteAddition}` : noteAddition;

  await adminClient
    .from('workspace_subscriptions')
    .update({ admin_note: newNote, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId);

  return { success: true, discountSummary: valRes.discountSummary };
}
