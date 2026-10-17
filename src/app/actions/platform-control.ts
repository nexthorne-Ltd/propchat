'use server';

import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { assertSuperAdmin, recordSuperAdminAudit } from '@/app/actions/platform';
import {
  getEffectiveWorkspaceSettings,
  isWorkspaceSettingLocked,
  assertSettingNotLocked,
  ResolvedWorkspaceSettings,
} from '@/lib/settings/precedence';
import {
  PlanFeatureKey,
  PlanLimitKey,
  PLAN_FEATURES,
  PLAN_LIMITS,
} from '@/lib/plans/features';
import { getWorkspaceCurrentUsage } from '@/lib/plans/enforce';
import { PlatformPlan, WorkspaceSubscription, SubscriptionStatus, BillingPeriod } from '@/types/plans';
import { Agent, Workspace, WorkspaceSettingLock } from '@/types/database';
import { PlatformSettings } from '@/types/platform-management';
import { revalidatePath } from 'next/cache';

export interface AdminWorkspaceControlData {
  resolved: ResolvedWorkspaceSettings;
  plans: PlatformPlan[];
  members: Agent[];
  channels: any[];
  usage: Record<PlanLimitKey, { current: number; limit: number | null; percentage: number }>;
  invoices: any[];
  recentActivity: any[];
}

/**
 * 1. Fetches complete workspace control details for the Super Admin panel
 */
export async function getAdminWorkspaceControlAction(
  workspaceId: string
): Promise<AdminWorkspaceControlData> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  // 1. Fetch resolved settings (Precedence: Override -> Plan -> Global Default)
  const resolved = await getEffectiveWorkspaceSettings(workspaceId);

  // 2. Fetch plans, members, channels, invoices, and activity
  const [
    { data: plansData },
    { data: membersData },
    { data: channelsData },
    { data: invoicesData },
    { data: superAuditData },
    { data: wsAuditData },
  ] = await Promise.all([
    adminClient.from('platform_plans').select('*').order('sort_order', { ascending: true }),
    adminClient.from('agents').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: true }),
    adminClient.from('channel_connections').select('*').eq('workspace_id', workspaceId),
    adminClient.from('workspace_invoices').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(50),
    adminClient.from('super_admin_audit_logs').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(50),
    adminClient.from('workspace_audit_logs').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(50),
  ]);

  // 3. Calculate live usage against every limit
  const limitKeys = Object.keys(PLAN_LIMITS.reduce((acc, l) => ({ ...acc, [l.id]: true }), {})) as PlanLimitKey[];
  const usage = {} as AdminWorkspaceControlData['usage'];

  await Promise.all(
    limitKeys.map(async (key) => {
      const current = await getWorkspaceCurrentUsage(workspaceId, key);
      const limitVal = resolved.limits[key]?.value ?? null;
      const percentage = limitVal && limitVal > 0 ? Math.min(100, Math.round((current / limitVal) * 100)) : 0;
      usage[key] = { current, limit: limitVal, percentage };
    })
  );

  // Combine and sort activity
  const superLogs = (superAuditData || []).map((l: any) => ({
    id: l.id,
    type: 'super_admin',
    actor: l.admin_email || 'Super Admin',
    action: l.action,
    details: l.details || {},
    created_at: l.created_at,
  }));

  const wsLogs = (wsAuditData || []).map((l: any) => ({
    id: l.id,
    type: 'workspace',
    actor: l.actor_name || 'Team Member',
    action: l.action,
    details: l.details || {},
    created_at: l.created_at,
  }));

  const combinedActivity = [...superLogs, ...wsLogs].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return {
    resolved,
    plans: (plansData || []) as PlatformPlan[],
    members: (membersData || []) as Agent[],
    channels: channelsData || [],
    usage,
    invoices: invoicesData || [],
    recentActivity: combinedActivity,
  };
}

// ============================================================================
// TAB 1: Plan & Billing
// ============================================================================

export async function adminUpdateWorkspacePlanAction(params: {
  workspaceId: string;
  planId: string;
  status?: SubscriptionStatus;
  billingPeriod?: BillingPeriod;
  extendTrialDays?: number;
  adminNote?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: targetPlan } = await adminClient
      .from('platform_plans')
      .select('*')
      .eq('id', params.planId)
      .single();

    if (!targetPlan) return { success: false, error: 'Selected plan not found.' };

    const { data: currentSub } = await adminClient
      .from('workspace_subscriptions')
      .select('*')
      .eq('workspace_id', params.workspaceId)
      .maybeSingle();

    const now = new Date();
    let trialEndsAt = currentSub?.trial_ends_at || null;
    if (params.extendTrialDays && params.extendTrialDays > 0) {
      const baseDate = trialEndsAt ? new Date(trialEndsAt) : now;
      const targetDate = baseDate > now ? baseDate : now;
      targetDate.setDate(targetDate.getDate() + params.extendTrialDays);
      trialEndsAt = targetDate.toISOString();
    }

    const oldVal = {
      plan_id: currentSub?.plan_id,
      status: currentSub?.status,
      billing_period: currentSub?.billing_period,
      trial_ends_at: currentSub?.trial_ends_at,
    };

    const newVal = {
      plan_id: targetPlan.id,
      plan_version: targetPlan.version,
      status: params.status || currentSub?.status || 'active',
      billing_period: params.billingPeriod || currentSub?.billing_period || 'monthly',
      trial_ends_at: trialEndsAt,
      admin_note: params.adminNote ?? currentSub?.admin_note ?? null,
      updated_at: now.toISOString(),
    };

    if (currentSub) {
      await adminClient.from('workspace_subscriptions').update(newVal).eq('id', currentSub.id);
    } else {
      await adminClient.from('workspace_subscriptions').insert({
        workspace_id: params.workspaceId,
        current_period_start: now.toISOString(),
        current_period_end: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        ...newVal,
      });
    }

    // Update workspace legacy plan column
    await adminClient.from('workspaces').update({ plan: targetPlan.slug }).eq('id', params.workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_workspace_plan_updated',
      workspaceId: params.workspaceId,
      details: {
        setting: 'plan_and_billing',
        old_value: oldVal,
        new_value: newVal,
      },
    });

    revalidatePath(`/admin/workspaces/${params.workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function adminRecordManualPaymentAction(params: {
  workspaceId: string;
  amount: number;
  currency?: string;
  paymentMethod: 'manual_bank_transfer' | 'manual_crypto' | 'manual_check' | 'manual_other';
  paymentReference: string;
  notes?: string;
  extendDays: number;
}): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const now = new Date();
    const periodEnd = new Date(now.getTime() + params.extendDays * 24 * 60 * 60 * 1000).toISOString();
    const invoiceNumber = `INV-MANUAL-${Date.now().toString().slice(-6)}`;

    // Insert invoice
    await adminClient.from('workspace_invoices').insert({
      workspace_id: params.workspaceId,
      invoice_number: invoiceNumber,
      amount: params.amount,
      currency: params.currency || 'USD',
      status: 'paid',
      billing_reason: 'manual_payment',
      paid_at: now.toISOString(),
      period_start: now.toISOString(),
      period_end: periodEnd,
      metadata: {
        paymentMethod: params.paymentMethod,
        paymentReference: params.paymentReference,
        notes: params.notes,
        recordedBy: agent.email,
      },
    });

    // Update subscription
    await adminClient
      .from('workspace_subscriptions')
      .update({
        status: 'active',
        current_period_end: periodEnd,
        updated_at: now.toISOString(),
      })
      .eq('workspace_id', params.workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_manual_payment_recorded',
      workspaceId: params.workspaceId,
      details: {
        setting: 'payment',
        old_value: null,
        new_value: {
          invoice_number: invoiceNumber,
          amount: params.amount,
          extended_days: params.extendDays,
          reference: params.paymentReference,
        },
      },
    });

    revalidatePath(`/admin/workspaces/${params.workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function adminToggleWorkspaceSuspensionAction(params: {
  workspaceId: string;
  suspend: boolean;
  reason?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: ws } = await adminClient.from('workspaces').select('is_suspended, suspension_reason').eq('id', params.workspaceId).single();

    const payload = params.suspend
      ? { is_suspended: true, suspension_reason: params.reason || 'Administrative suspension', suspended_at: new Date().toISOString() }
      : { is_suspended: false, suspension_reason: null, suspended_at: null };

    await adminClient.from('workspaces').update(payload).eq('id', params.workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: params.suspend ? 'workspace_suspended' : 'workspace_reactivated',
      workspaceId: params.workspaceId,
      details: {
        setting: 'suspension',
        old_value: { is_suspended: ws?.is_suspended, reason: ws?.suspension_reason },
        new_value: payload,
      },
    });

    revalidatePath(`/admin/workspaces/${params.workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// TAB 2: Usage & Limits Overrides
// ============================================================================

export async function adminUpdateWorkspaceLimitsAction(
  workspaceId: string,
  customLimits: Partial<Record<PlanLimitKey, number | null>>
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: sub } = await adminClient
      .from('workspace_subscriptions')
      .select('custom_limits')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    const mergedLimits = {
      ...(sub?.custom_limits || {}),
      ...customLimits,
    };

    // Remove keys that are explicitly undefined
    for (const [k, v] of Object.entries(mergedLimits)) {
      if (v === undefined) delete mergedLimits[k];
    }

    if (sub) {
      await adminClient
        .from('workspace_subscriptions')
        .update({ custom_limits: mergedLimits, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId);
    } else {
      await adminClient.from('workspace_subscriptions').insert({
        workspace_id: workspaceId,
        custom_limits: mergedLimits,
        status: 'active',
      });
    }

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_workspace_limits_updated',
      workspaceId,
      details: {
        setting: 'usage_and_limits',
        old_value: sub?.custom_limits || {},
        new_value: mergedLimits,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// TAB 3: Features Overrides
// ============================================================================

export async function adminUpdateWorkspaceFeaturesAction(
  workspaceId: string,
  features: Partial<Record<PlanFeatureKey, boolean | null>>
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: sub } = await adminClient
      .from('workspace_subscriptions')
      .select('custom_features')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    const merged = { ...(sub?.custom_features || {}) };

    for (const [k, v] of Object.entries(features)) {
      if (v === null || v === undefined) {
        delete merged[k]; // Revert override to plan default
      } else {
        merged[k] = Boolean(v);
      }
    }

    if (sub) {
      await adminClient
        .from('workspace_subscriptions')
        .update({ custom_features: merged, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId);
    } else {
      await adminClient.from('workspace_subscriptions').insert({
        workspace_id: workspaceId,
        custom_features: merged,
        status: 'active',
      });
    }

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_workspace_features_updated',
      workspaceId,
      details: {
        setting: 'features',
        old_value: sub?.custom_features || {},
        new_value: merged,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// TAB 4: Team & Roles
// ============================================================================

export async function adminChangeMemberRoleAction(
  workspaceId: string,
  memberId: string,
  newRole: 'owner' | 'admin' | 'agent' | 'light_agent'
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: currentMember } = await adminClient
      .from('agents')
      .select('role, email')
      .eq('id', memberId)
      .eq('workspace_id', workspaceId)
      .single();

    if (!currentMember) return { success: false, error: 'Member not found in workspace.' };

    await adminClient
      .from('agents')
      .update({ role: newRole })
      .eq('id', memberId)
      .eq('workspace_id', workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_member_role_changed',
      workspaceId,
      details: {
        setting: 'team',
        member_id: memberId,
        member_email: currentMember.email,
        old_value: currentMember.role,
        new_value: newRole,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function adminToggleMemberActiveAction(
  workspaceId: string,
  memberId: string,
  isActive: boolean
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: currentMember } = await adminClient
      .from('agents')
      .select('is_active, email')
      .eq('id', memberId)
      .eq('workspace_id', workspaceId)
      .single();

    if (!currentMember) return { success: false, error: 'Member not found.' };

    const payload = isActive
      ? { is_active: true, deactivated_at: null }
      : { is_active: false, deactivated_at: new Date().toISOString() };

    await adminClient.from('agents').update(payload).eq('id', memberId).eq('workspace_id', workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: isActive ? 'admin_member_reactivated' : 'admin_member_deactivated',
      workspaceId,
      details: {
        setting: 'team',
        member_id: memberId,
        member_email: currentMember.email,
        old_value: currentMember.is_active,
        new_value: isActive,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function adminTransferWorkspaceOwnershipAction(
  workspaceId: string,
  newOwnerId: string
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: ws } = await adminClient.from('workspaces').select('owner_id').eq('id', workspaceId).single();
    const { data: newOwner } = await adminClient.from('agents').select('id, email').eq('id', newOwnerId).eq('workspace_id', workspaceId).single();

    if (!newOwner) return { success: false, error: 'Target owner must be an active member of the workspace.' };

    const oldOwnerId = ws?.owner_id;

    // 1. Update workspace owner_id
    await adminClient.from('workspaces').update({ owner_id: newOwnerId }).eq('id', workspaceId);

    // 2. Set new owner role to owner
    await adminClient.from('agents').update({ role: 'owner' }).eq('id', newOwnerId).eq('workspace_id', workspaceId);

    // 3. Demote previous owner to admin if present
    if (oldOwnerId && oldOwnerId !== newOwnerId) {
      await adminClient.from('agents').update({ role: 'admin' }).eq('id', oldOwnerId).eq('workspace_id', workspaceId);
    }

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_workspace_ownership_transferred',
      workspaceId,
      details: {
        setting: 'team_ownership',
        old_value: oldOwnerId,
        new_value: newOwnerId,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function adminForceLogoutSessionsAction(
  workspaceId: string,
  memberId?: string
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    // Audit log force logout request
    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_force_logout_sessions',
      workspaceId,
      details: {
        setting: 'security_sessions',
        target_member_id: memberId || 'all_workspace_members',
      },
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// TAB 5: Channels Controls
// ============================================================================

export async function adminToggleChannelDisabledAction(
  workspaceId: string,
  channel: string,
  disabled: boolean
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: ws } = await adminClient.from('workspaces').select('channel_disabled_overrides').eq('id', workspaceId).single();
    const current = (ws?.channel_disabled_overrides || {}) as Record<string, boolean>;
    const updated = { ...current, [channel]: disabled };

    await adminClient.from('workspaces').update({ channel_disabled_overrides: updated }).eq('id', workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: disabled ? 'admin_channel_disabled' : 'admin_channel_enabled',
      workspaceId,
      details: {
        setting: 'channels',
        channel,
        old_value: current[channel],
        new_value: disabled,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function adminToggleOutboundBlockedAction(
  workspaceId: string,
  blocked: boolean,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: ws } = await adminClient.from('workspaces').select('is_outbound_blocked').eq('id', workspaceId).single();

    await adminClient
      .from('workspaces')
      .update({
        is_outbound_blocked: blocked,
        abuse_reason: reason || null,
      })
      .eq('id', workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: blocked ? 'admin_outbound_blocked' : 'admin_outbound_unblocked',
      workspaceId,
      details: {
        setting: 'channels_outbound',
        old_value: ws?.is_outbound_blocked,
        new_value: blocked,
        reason,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// TAB 6: AI Bot Controls
// ============================================================================

export async function adminUpdateAiControlAction(
  workspaceId: string,
  params: {
    enabled?: boolean;
    model?: string;
    monthly_reply_cap?: number | null;
    monthly_cost_cap_usd?: number | null;
    system_prompt?: string | null;
  }
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: ws } = await adminClient
      .from('workspaces')
      .select('ai_settings, ai_monthly_reply_cap, ai_monthly_cost_cap_usd')
      .eq('id', workspaceId)
      .single();

    const prevAi = (ws?.ai_settings || {}) as any;
    const newAi = {
      ...prevAi,
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.system_prompt !== undefined ? { system_prompt: params.system_prompt } : {}),
    };

    const updatePayload: Record<string, any> = {
      ai_settings: newAi,
    };

    if (params.monthly_reply_cap !== undefined) {
      updatePayload.ai_monthly_reply_cap = params.monthly_reply_cap;
    }
    if (params.monthly_cost_cap_usd !== undefined) {
      updatePayload.ai_monthly_cost_cap_usd = params.monthly_cost_cap_usd;
    }

    await adminClient.from('workspaces').update(updatePayload).eq('id', workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_ai_control_updated',
      workspaceId,
      details: {
        setting: 'ai_bot',
        old_value: {
          ai_settings: ws?.ai_settings,
          reply_cap: ws?.ai_monthly_reply_cap,
          cost_cap: ws?.ai_monthly_cost_cap_usd,
        },
        new_value: updatePayload,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// TAB 7: Widget & Branding
// ============================================================================

export async function adminUpdateWidgetControlAction(
  workspaceId: string,
  params: {
    forcePoweredBy?: 'inherited' | 'force_on' | 'force_off';
    widgetDisabled?: boolean;
  }
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: ws } = await adminClient
      .from('workspaces')
      .select('force_powered_by, widget_disabled')
      .eq('id', workspaceId)
      .single();

    const payload: Record<string, any> = {};
    if (params.forcePoweredBy !== undefined) payload.force_powered_by = params.forcePoweredBy;
    if (params.widgetDisabled !== undefined) payload.widget_disabled = params.widgetDisabled;

    await adminClient.from('workspaces').update(payload).eq('id', workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_widget_control_updated',
      workspaceId,
      details: {
        setting: 'widget_branding',
        old_value: {
          force_powered_by: ws?.force_powered_by,
          widget_disabled: ws?.widget_disabled,
        },
        new_value: payload,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// TAB 8: Help Center Controls
// ============================================================================

export async function adminToggleHelpCenterPublishedAction(
  workspaceId: string,
  published: boolean
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: ws } = await adminClient.from('workspaces').select('help_center_enabled').eq('id', workspaceId).single();

    await adminClient.from('workspaces').update({ help_center_enabled: published }).eq('id', workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_help_center_publish_toggled',
      workspaceId,
      details: {
        setting: 'help_center_publish',
        old_value: ws?.help_center_enabled,
        new_value: published,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function adminApproveCustomDomainAction(
  workspaceId: string
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: ws } = await adminClient.from('workspaces').select('custom_domain, custom_domain_status').eq('id', workspaceId).single();
    if (!ws?.custom_domain) return { success: false, error: 'No custom domain configured.' };

    await adminClient.from('workspaces').update({
      custom_domain_status: 'verified',
      custom_domain_verified_at: new Date().toISOString(),
    }).eq('id', workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_custom_domain_approved',
      workspaceId,
      details: {
        setting: 'help_center_domain',
        domain: ws.custom_domain,
        old_value: ws.custom_domain_status,
        new_value: 'verified',
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function adminRemoveCustomDomainAction(
  workspaceId: string
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: ws } = await adminClient.from('workspaces').select('custom_domain').eq('id', workspaceId).single();

    await adminClient.from('workspaces').update({
      custom_domain: null,
      custom_domain_status: null,
      custom_domain_verified_at: null,
    }).eq('id', workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_custom_domain_removed',
      workspaceId,
      details: {
        setting: 'help_center_domain',
        old_value: ws?.custom_domain,
        new_value: null,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// TAB 9: Security & Data
// ============================================================================

export async function adminUpdateSecurityControlAction(
  workspaceId: string,
  params: {
    require2fa?: boolean;
    dataRetentionDays?: number | null;
  }
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: ws } = await adminClient.from('workspaces').select('require_2fa, data_retention_days').eq('id', workspaceId).single();

    const payload: Record<string, any> = {};
    if (params.require2fa !== undefined) payload.require_2fa = params.require2fa;
    if (params.dataRetentionDays !== undefined) payload.data_retention_days = params.dataRetentionDays;

    await adminClient.from('workspaces').update(payload).eq('id', workspaceId);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_security_control_updated',
      workspaceId,
      details: {
        setting: 'security_data',
        old_value: {
          require_2fa: ws?.require_2fa,
          data_retention_days: ws?.data_retention_days,
        },
        new_value: payload,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// Setting Locks Management (Requirement C)
// ============================================================================

export async function adminToggleSettingLockAction(
  workspaceId: string,
  settingKey: string,
  isLocked: boolean,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: existing } = await adminClient
      .from('workspace_setting_locks')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('setting_key', settingKey)
      .maybeSingle();

    if (existing) {
      await adminClient
        .from('workspace_setting_locks')
        .update({
          is_locked: isLocked,
          reason: reason || existing.reason,
          locked_by: agent.id,
          locked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      await adminClient.from('workspace_setting_locks').insert({
        workspace_id: workspaceId,
        setting_key: settingKey,
        is_locked: isLocked,
        reason: reason || 'Locked by Zentry platform administration',
        locked_by: agent.id,
        locked_at: new Date().toISOString(),
      });
    }

    await recordSuperAdminAudit({
      admin: agent,
      action: isLocked ? 'admin_setting_locked' : 'admin_setting_unlocked',
      workspaceId,
      details: {
        setting: 'locks',
        setting_key: settingKey,
        old_value: existing?.is_locked ?? false,
        new_value: isLocked,
        reason,
      },
    });

    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// Global Defaults (Requirement B)
// ============================================================================

export async function adminGetGlobalDefaultsAction(): Promise<{
  settings: PlatformSettings;
  plans: PlatformPlan[];
}> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const [
    { data: st },
    { data: plans },
  ] = await Promise.all([
    adminClient.from('platform_settings').select('*').eq('id', 'default').maybeSingle(),
    adminClient.from('platform_plans').select('*').order('sort_order', { ascending: true }),
  ]);

  return {
    settings: (st as PlatformSettings) || {
      id: 'default',
      default_plan_slug: 'starter',
      default_trial_days: 14,
      signup_mode: 'open',
      default_ai_model: 'claude-3-5-sonnet',
      default_ai_monthly_token_limit: 500000,
      email_sender_name: 'ZenTry Support',
      email_sender_address: 'support@zentry.io',
      email_brand_color: '#2E5BFF',
      email_logo_url: null,
      email_footer_text: '© 2026 ZenTry Inc. All rights reserved.',
      is_maintenance_mode: false,
      maintenance_message: 'ZenTry is currently undergoing maintenance.',
      maintenance_bypass_emails: ['zentry385@gmail.com'],
      updated_at: new Date().toISOString(),
    },
    plans: (plans || []) as PlatformPlan[],
  };
}

export async function adminSaveGlobalDefaultsAction(
  updates: Partial<PlatformSettings>
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: prev } = await adminClient.from('platform_settings').select('*').eq('id', 'default').maybeSingle();

    const payload = {
      ...updates,
      updated_at: new Date().toISOString(),
    };

    await adminClient.from('platform_settings').upsert({ id: 'default', ...payload });

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_global_defaults_updated',
      details: {
        setting: 'global_defaults',
        old_value: prev,
        new_value: payload,
      },
    });

    revalidatePath('/admin');
    revalidatePath('/admin/defaults');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// Bulk Actions on Workspaces List (Requirement E)
// ============================================================================

export async function adminBulkChangePlanAction(
  workspaceIds: string[],
  planId: string
): Promise<{ success: boolean; count: number; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: targetPlan } = await adminClient.from('platform_plans').select('*').eq('id', planId).single();
    if (!targetPlan) return { success: false, count: 0, error: 'Target plan not found.' };

    for (const wsId of workspaceIds) {
      await adminUpdateWorkspacePlanAction({ workspaceId: wsId, planId });
    }

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_bulk_change_plan',
      details: {
        setting: 'bulk_plan',
        workspace_ids: workspaceIds,
        new_plan_id: planId,
        new_plan_name: targetPlan.name,
      },
    });

    revalidatePath('/admin/workspaces');
    return { success: true, count: workspaceIds.length };
  } catch (err: any) {
    return { success: false, count: 0, error: err.message };
  }
}

export async function adminBulkSuspendAction(
  workspaceIds: string[],
  suspend: boolean,
  reason: string
): Promise<{ success: boolean; count: number; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const payload = suspend
      ? { is_suspended: true, suspension_reason: reason, suspended_at: new Date().toISOString() }
      : { is_suspended: false, suspension_reason: null, suspended_at: null };

    await adminClient.from('workspaces').update(payload).in('id', workspaceIds);

    await recordSuperAdminAudit({
      admin: agent,
      action: suspend ? 'admin_bulk_suspend' : 'admin_bulk_reactivate',
      details: {
        setting: 'bulk_suspension',
        workspace_ids: workspaceIds,
        reason,
      },
    });

    revalidatePath('/admin/workspaces');
    return { success: true, count: workspaceIds.length };
  } catch (err: any) {
    return { success: false, count: 0, error: err.message };
  }
}

export async function adminBulkToggleFeatureAction(
  workspaceIds: string[],
  featureKey: PlanFeatureKey,
  enabled: boolean
): Promise<{ success: boolean; count: number; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    for (const wsId of workspaceIds) {
      await adminUpdateWorkspaceFeaturesAction(wsId, { [featureKey]: enabled });
    }

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_bulk_toggle_feature',
      details: {
        setting: 'bulk_feature',
        workspace_ids: workspaceIds,
        feature: featureKey,
        enabled,
      },
    });

    revalidatePath('/admin/workspaces');
    return { success: true, count: workspaceIds.length };
  } catch (err: any) {
    return { success: false, count: 0, error: err.message };
  }
}

export async function adminBulkSendAnnouncementAction(
  workspaceIds: string[],
  announcement: {
    title: string;
    message: string;
    tone: 'info' | 'warning' | 'success' | 'urgent';
  }
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    await adminClient.from('platform_announcements').insert({
      title: announcement.title.trim(),
      message: announcement.message.trim(),
      tone: announcement.tone,
      display_type: 'banner',
      target_audience: 'workspaces',
      target_workspace_ids: workspaceIds,
      start_date: new Date().toISOString(),
      is_active: true,
      is_dismissible: true,
    });

    await recordSuperAdminAudit({
      admin: agent,
      action: 'admin_bulk_send_announcement',
      details: {
        setting: 'bulk_announcement',
        workspace_ids: workspaceIds,
        title: announcement.title,
      },
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
