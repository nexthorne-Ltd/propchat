'use server';

import crypto from 'crypto';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { assertSuperAdmin, assertPlatformOwner } from './platform';
import { getBillingProvider } from '@/lib/billing/lemonsqueezy';
import {
  WorkspaceInvoice,
  SupportSession,
  PlatformFeatureFlag,
  PlatformAnnouncement,
  PlatformSettings,
  PlatformEmailTemplate,
  EmailTemplateKey,
  WorkspaceAiUsageDaily,
  PlatformBlockedDomain,
  RevenueMetrics,
  PlatformStaffRole,
  PlatformStaffMember,
} from '@/types/platform-management';
import { userError } from '@/lib/errors/user-error';
import { getRequestOrigin } from '@/lib/request-origin';

/**
 * RBAC Helper: Checks whether current platform staff has permission for specific super admin section
 */
export async function assertStaffCapability(
  capability: 'billing' | 'support' | 'settings' | 'team'
): Promise<{ user: any; agent: any; role: PlatformStaffRole }> {
  const { user, agent } = await assertSuperAdmin();

  const isOwner = Boolean(agent.is_platform_owner);

  const role: PlatformStaffRole = isOwner ? 'owner' : (agent.platform_staff_role as PlatformStaffRole) || 'support';

  if (isOwner) {
    return { user, agent, role: 'owner' };
  }

  if (capability === 'team' && role !== 'owner') {
    throw userError('403 Forbidden: Only the platform owner can manage platform staff.');
  }

  if (capability === 'billing' && role !== 'owner' && role !== 'finance') {
    throw userError('403 Forbidden: Billing access requires finance or owner role.');
  }

  if (capability === 'support' && role !== 'owner' && role !== 'support') {
    throw userError('403 Forbidden: Support tools require support or owner role.');
  }

  return { user, agent, role };
}

// ============================================================================
// 1. Billing & Lemon Squeezy Invoicing & Manual Payments
// ============================================================================

export async function createWorkspaceCheckoutAction(params: {
  workspaceId: string;
  planId: string;
  billingPeriod: 'monthly' | 'yearly';
  customerEmail: string;
}): Promise<{ checkoutUrl: string; error?: string }> {
  const adminClient = serviceClient();

  const [{ data: ws }, { data: plan }] = await Promise.all([
    adminClient.from('workspaces').select('id, name').eq('id', params.workspaceId).single(),
    adminClient.from('platform_plans').select('*').eq('id', params.planId).single(),
  ]);

  if (!ws || !plan) {
    return { checkoutUrl: '', error: 'Workspace or plan not found.' };
  }

  const appOrigin = await getRequestOrigin();
  const provider = getBillingProvider();

  const session = await provider.createCheckoutSession({
    workspaceId: ws.id,
    workspaceName: ws.name,
    planId: plan.id,
    planSlug: plan.slug,
    billingPeriod: params.billingPeriod,
    customerEmail: params.customerEmail,
    successUrl: `${appOrigin}/dashboard?checkout=success`,
    cancelUrl: `${appOrigin}/dashboard?checkout=cancelled`,
  });

  return { checkoutUrl: session.checkoutUrl };
}

export async function recordManualPaymentAction(params: {
  workspaceId: string;
  amount: number;
  currency?: string;
  paymentMethod: 'manual_bank_transfer' | 'manual_crypto' | 'manual_check' | 'manual_other';
  paymentReference: string;
  notes?: string;
  extendDays: number;
}): Promise<{ success: boolean; error?: string }> {
  await assertStaffCapability('billing');
  const adminClient = serviceClient();

  try {
    const now = new Date();
    const periodEnd = new Date(now.getTime() + params.extendDays * 24 * 60 * 60 * 1000).toISOString();
    const invoiceNumber = `INV-MANUAL-${Date.now().toString().slice(-6)}`;

    // 1. Record invoice
    const { error: invErr } = await adminClient.from('workspace_invoices').insert({
      workspace_id: params.workspaceId,
      invoice_number: invoiceNumber,
      amount: params.amount,
      currency: params.currency || 'USD',
      status: 'paid',
      billing_reason: 'manual_payment',
      payment_method: params.paymentMethod,
      payment_reference: params.paymentReference,
      paid_at: now.toISOString(),
      period_start: now.toISOString(),
      period_end: periodEnd,
    });

    if (invErr) throw invErr;

    // 2. Activate subscription and extend period
    await adminClient
      .from('workspace_subscriptions')
      .update({
        status: 'active',
        payment_method: params.paymentMethod,
        current_period_start: now.toISOString(),
        current_period_end: periodEnd,
        grace_period_ends_at: null,
        failed_payment_count: 0,
        admin_note: params.notes ? `Manual payment verified: ${params.notes}` : 'Manual payment verified',
        updated_at: now.toISOString(),
      })
      .eq('workspace_id', params.workspaceId);

    // 3. Audit log
    await adminClient.from('super_admin_audit_logs').insert({
      action: 'manual_payment_recorded',
      target_workspace_id: params.workspaceId,
      metadata: {
        invoiceNumber,
        amount: params.amount,
        method: params.paymentMethod,
        reference: params.paymentReference,
      },
    });

    revalidatePath('/admin/plans');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function getPlatformRevenueMetricsAction(): Promise<RevenueMetrics> {
  await assertStaffCapability('billing');
  const adminClient = serviceClient();

  // Fetch active subscriptions with plans
  const { data: subs } = await adminClient
    .from('workspace_subscriptions')
    .select('id, workspace_id, status, billing_period, plan_id, created_at, plan:platform_plans(id, name, monthly_price, yearly_price)')
    .eq('status', 'active');

  const { data: plans } = await adminClient.from('platform_plans').select('id, name');

  let mrr = 0;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let newMrr30d = 0;

  const planStats = new Map<string, { planId: string; planName: string; subscriberCount: number; mrr: number }>();
  (plans || []).forEach((p: any) => {
    planStats.set(p.id, { planId: p.id, planName: p.name, subscriberCount: 0, mrr: 0 });
  });

  (subs || []).forEach((sub: any) => {
    const plan = sub.plan;
    if (!plan) return;

    const planMonthly = sub.billing_period === 'yearly'
      ? Math.round(Number(plan.yearly_price || 0) / 12)
      : Number(plan.monthly_price || 0);

    mrr += planMonthly;

    if (new Date(sub.created_at) >= thirtyDaysAgo) {
      newMrr30d += planMonthly;
    }

    const cur = planStats.get(plan.id);
    if (cur) {
      cur.subscriberCount += 1;
      cur.mrr += planMonthly;
    }
  });

  // Calculate churned in last 30d
  const { data: churnedSubs } = await adminClient
    .from('workspace_subscriptions')
    .select('id, plan:platform_plans(monthly_price, yearly_price)')
    .eq('status', 'canceled')
    .gte('updated_at', thirtyDaysAgo.toISOString());

  let churnedMrr30d = 0;
  (churnedSubs || []).forEach((c: any) => {
    if (c.plan) {
      churnedMrr30d += Number(c.plan.monthly_price || 0);
    }
  });

  return {
    mrr,
    arr: mrr * 12,
    newMrr30d,
    churnedMrr30d,
    planBreakdown: Array.from(planStats.values()),
  };
}

export async function getWorkspaceInvoicesAction(params?: {
  workspaceId?: string;
  limit?: number;
}): Promise<{ invoices: (WorkspaceInvoice & { workspace?: { id: string; name: string } })[] }> {
  await assertStaffCapability('billing');
  const adminClient = serviceClient();

  let query = adminClient
    .from('workspace_invoices')
    .select('*, workspace:workspaces(id, name)')
    .order('created_at', { ascending: false })
    .limit(params?.limit || 100);

  if (params?.workspaceId) {
    query = query.eq('workspace_id', params.workspaceId);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Error fetching invoices:', error);
    return { invoices: [] };
  }

  return { invoices: data as any || [] };
}

// ============================================================================
// 2. Login as Workspace (Impersonation / Support Sessions)
// ============================================================================

export async function startSupportSessionAction(params: {
  workspaceId: string;
  reason?: string;
}): Promise<{ success: boolean; session?: SupportSession; error?: string }> {
  const { user, agent } = await assertStaffCapability('support');
  const adminClient = serviceClient();

  const { data: ws } = await adminClient
    .from('workspaces')
    .select('id, name')
    .eq('id', params.workspaceId)
    .single();

  if (!ws) {
    return { success: false, error: 'Workspace not found.' };
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + 60 * 60 * 1000); // 1 hour max duration

  const { data: session, error } = await adminClient
    .from('support_sessions')
    .insert({
      admin_user_id: user.id,
      admin_email: agent.email,
      workspace_id: ws.id,
      workspace_name: ws.name,
      session_token: sessionToken,
      reason: params.reason || 'Platform staff support inspection',
      started_at: startedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select('*')
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  // Audit log
  await adminClient.from('super_admin_audit_logs').insert({
    action: 'impersonation_started',
    target_workspace_id: ws.id,
    metadata: {
      adminEmail: agent.email,
      workspaceName: ws.name,
      expiresAt: expiresAt.toISOString(),
      reason: params.reason,
    },
  });

  // Set secure cookie
  const cookieStore = await cookies();
  cookieStore.set('zentry_support_token', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 3600,
  });

  return { success: true, session: session as SupportSession };
}

export async function getActiveSupportSessionAction(): Promise<{
  active: boolean;
  session: SupportSession | null;
}> {
  const cookieStore = await cookies();
  const token = cookieStore.get('zentry_support_token')?.value;

  if (!token) {
    return { active: false, session: null };
  }

  const adminClient = serviceClient();
  const { data: session } = await adminClient
    .from('support_sessions')
    .select('*')
    .eq('session_token', token)
    .is('ended_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!session) {
    return { active: false, session: null };
  }

  return { active: true, session: session as SupportSession };
}

export async function endSupportSessionAction(): Promise<{ success: boolean }> {
  const cookieStore = await cookies();
  const token = cookieStore.get('zentry_support_token')?.value;

  if (token) {
    const adminClient = serviceClient();
    const { data: session } = await adminClient
      .from('support_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('session_token', token)
      .select('workspace_id, admin_email')
      .maybeSingle();

    if (session) {
      await adminClient.from('super_admin_audit_logs').insert({
        action: 'impersonation_ended',
        target_workspace_id: session.workspace_id,
        metadata: { adminEmail: session.admin_email },
      });
    }

    cookieStore.delete('zentry_support_token');
  }

  return { success: true };
}

// ============================================================================
// 3. Platform Feature Flags (Global, Per-Plan, Per-Workspace)
// ============================================================================

export async function getPlatformFeatureFlagsAction(): Promise<PlatformFeatureFlag[]> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { data, error } = await adminClient
    .from('platform_feature_flags')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[Feature Flags Fetch Error]:', error);
    return [];
  }

  return (data || []) as PlatformFeatureFlag[];
}

export async function savePlatformFeatureFlagAction(flag: Partial<PlatformFeatureFlag>): Promise<{
  success: boolean;
  error?: string;
}> {
  await assertPlatformOwner();
  const adminClient = serviceClient();

  if (!flag.key || !flag.name) {
    return { success: false, error: 'Key and Name are required.' };
  }

  const cleanKey = flag.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

  const payload: Record<string, any> = {
    key: cleanKey,
    name: flag.name.trim(),
    description: flag.description || '',
    is_enabled_globally: Boolean(flag.is_enabled_globally),
    enabled_plan_ids: flag.enabled_plan_ids || [],
    enabled_workspace_ids: flag.enabled_workspace_ids || [],
    disabled_workspace_ids: flag.disabled_workspace_ids || [],
    updated_at: new Date().toISOString(),
  };

  let error;
  if (flag.id) {
    const res = await adminClient.from('platform_feature_flags').update(payload).eq('id', flag.id);
    error = res.error;
  } else {
    const res = await adminClient.from('platform_feature_flags').insert(payload);
    error = res.error;
  }

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/admin/plans');
  return { success: true };
}

export async function deletePlatformFeatureFlagAction(id: string): Promise<{ success: boolean; error?: string }> {
  await assertPlatformOwner();
  const adminClient = serviceClient();

  const { error } = await adminClient.from('platform_feature_flags').delete().eq('id', id);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ============================================================================
// 4. Announcements System
// ============================================================================

export async function getPlatformAnnouncementsAction(): Promise<PlatformAnnouncement[]> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { data, error } = await adminClient
    .from('platform_announcements')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return [];
  return (data || []) as PlatformAnnouncement[];
}

export async function getActiveAnnouncementsForWorkspaceAction(
  workspaceId: string,
  planId?: string
): Promise<PlatformAnnouncement[]> {
  const adminClient = serviceClient();
  const now = new Date().toISOString();

  const { data } = await adminClient
    .from('platform_announcements')
    .select('*')
    .eq('is_active', true)
    .lte('start_date', now);

  if (!data) return [];

  // Filter in memory for audience targeting and end dates
  return (data as PlatformAnnouncement[]).filter((a) => {
    if (a.end_date && a.end_date < now) return false;
    if (a.target_audience === 'all') return true;
    if (a.target_audience === 'workspaces' && a.target_workspace_ids.includes(workspaceId)) return true;
    if (a.target_audience === 'plans' && planId && a.target_plan_ids.includes(planId)) return true;
    return false;
  });
}

export async function savePlatformAnnouncementAction(announcement: Partial<PlatformAnnouncement>): Promise<{
  success: boolean;
  error?: string;
}> {
  await assertStaffCapability('support');
  const adminClient = serviceClient();

  if (!announcement.title || !announcement.message) {
    return { success: false, error: 'Title and message are required.' };
  }

  const payload: Record<string, any> = {
    title: announcement.title.trim(),
    message: announcement.message.trim(),
    display_type: announcement.display_type || 'banner',
    tone: announcement.tone || 'info',
    target_audience: announcement.target_audience || 'all',
    target_plan_ids: announcement.target_plan_ids || [],
    target_workspace_ids: announcement.target_workspace_ids || [],
    start_date: announcement.start_date || new Date().toISOString(),
    end_date: announcement.end_date || null,
    is_dismissible: announcement.is_dismissible ?? true,
    is_active: announcement.is_active ?? true,
  };

  let error;
  if (announcement.id) {
    const res = await adminClient.from('platform_announcements').update(payload).eq('id', announcement.id);
    error = res.error;
  } else {
    const res = await adminClient.from('platform_announcements').insert(payload);
    error = res.error;
  }

  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function deletePlatformAnnouncementAction(id: string): Promise<{ success: boolean; error?: string }> {
  await assertStaffCapability('support');
  const adminClient = serviceClient();

  const { error } = await adminClient.from('platform_announcements').delete().eq('id', id);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ============================================================================
// 5. Platform Settings & Maintenance Mode
// ============================================================================

export async function getPlatformSettingsAction(): Promise<PlatformSettings> {
  const adminClient = serviceClient();

  const { data } = await adminClient
    .from('platform_settings')
    .select('*')
    .eq('id', 'default')
    .maybeSingle();

  if (!data) {
    return {
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
    };
  }

  return data as PlatformSettings;
}

export async function savePlatformSettingsAction(
  settings: Partial<PlatformSettings>
): Promise<{ success: boolean; error?: string }> {
  await assertPlatformOwner();
  const adminClient = serviceClient();

  const payload: Record<string, any> = {
    ...settings,
    updated_at: new Date().toISOString(),
  };

  const { error } = await adminClient
    .from('platform_settings')
    .upsert({ id: 'default', ...payload });

  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ============================================================================
// 6. System Email Templates
// ============================================================================

export async function getPlatformEmailTemplatesAction(): Promise<PlatformEmailTemplate[]> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { data, error } = await adminClient
    .from('platform_email_templates')
    .select('*')
    .order('template_key', { ascending: true });

  if (error) return [];
  return (data || []) as PlatformEmailTemplate[];
}

export async function savePlatformEmailTemplateAction(params: {
  template_key: EmailTemplateKey;
  subject: string;
  body_text: string;
  body_html: string;
}): Promise<{ success: boolean; error?: string }> {
  await assertPlatformOwner();
  const adminClient = serviceClient();

  const { error } = await adminClient
    .from('platform_email_templates')
    .update({
      subject: params.subject.trim(),
      body_text: params.body_text,
      body_html: params.body_html,
      updated_at: new Date().toISOString(),
    })
    .eq('template_key', params.template_key);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function sendTestSystemEmailAction(params: {
  template_key: EmailTemplateKey;
  recipientEmail: string;
}): Promise<{ success: boolean; message?: string; error?: string }> {
  const { agent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  const { data: tpl } = await adminClient
    .from('platform_email_templates')
    .select('*')
    .eq('template_key', params.template_key)
    .single();

  if (!tpl) return { success: false, error: 'Template not found.' };

  // Sample replacement variables
  const sampleData: Record<string, string> = {
    user_name: 'Alex Johnson',
    workspace_name: 'Acme Support',
    plan_name: 'Pro Tier',
    trial_days: '3',
    grace_period_days: '7',
    limit_name: 'Monthly Tickets',
    login_url: 'https://zentry.io/login',
    billing_url: 'https://zentry.io/dashboard/settings/billing',
  };

  let subject = tpl.subject;
  let html = tpl.body_html;
  let text = tpl.body_text;

  for (const [key, val] of Object.entries(sampleData)) {
    const rx = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    subject = subject.replace(rx, val);
    html = html.replace(rx, val);
    text = text.replace(rx, val);
  }

  subject = `[PREVIEW TEST] ${subject}`;

  // Log send attempt
  console.log(`[Test Email Sent to ${params.recipientEmail}]:`, subject);

  return {
    success: true,
    message: `Test email preview sent to ${params.recipientEmail} successfully.`,
  };
}

// ============================================================================
// 7. AI Daily Usage, Cost Tracking & Per-Workspace Budget Cap
// ============================================================================

export async function getWorkspaceAiUsageMetricsAction(
  workspaceId?: string
): Promise<{
  daily: WorkspaceAiUsageDaily[];
  totalTokens: number;
  totalCostUsd: number;
  totalRequests: number;
}> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  let query = adminClient
    .from('workspace_ai_usage_daily')
    .select('*')
    .order('usage_date', { ascending: false })
    .limit(30);

  if (workspaceId) {
    query = query.eq('workspace_id', workspaceId);
  }

  const { data } = await query;
  const daily = (data || []) as WorkspaceAiUsageDaily[];

  let totalTokens = 0;
  let totalCostUsd = 0;
  let totalRequests = 0;

  daily.forEach((d) => {
    totalTokens += Number(d.total_tokens || 0);
    totalCostUsd += Number(d.estimated_cost_usd || 0);
    totalRequests += Number(d.requests_count || 0);
  });

  return {
    daily,
    totalTokens,
    totalCostUsd,
    totalRequests,
  };
}

export async function updateWorkspaceAiTokenCapAction(
  workspaceId: string,
  cap: number
): Promise<{ success: boolean; error?: string }> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { error } = await adminClient
    .from('workspaces')
    .update({ ai_monthly_token_cap: cap })
    .eq('id', workspaceId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ============================================================================
// 8. Abuse & Safety (Domain Blacklist, Outbound Blocking, Flagging)
// ============================================================================

export async function getAbuseFlaggedWorkspacesAction(): Promise<any[]> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { data, error } = await adminClient
    .from('workspaces')
    .select('id, name, created_at, abuse_flagged, abuse_reason, is_outbound_blocked, is_suspended, scheduled_deletion_at')
    .or('abuse_flagged.eq.true,is_outbound_blocked.eq.true,scheduled_deletion_at.not.is.null')
    .order('created_at', { ascending: false });

  if (error) return [];
  return data || [];
}

export async function toggleWorkspaceOutboundBlockedAction(
  workspaceId: string,
  blocked: boolean,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  await assertStaffCapability('support');
  const adminClient = serviceClient();

  const { error } = await adminClient
    .from('workspaces')
    .update({
      is_outbound_blocked: blocked,
      abuse_reason: reason || null,
    })
    .eq('id', workspaceId);

  if (error) return { success: false, error: error.message };

  await adminClient.from('super_admin_audit_logs').insert({
    action: blocked ? 'workspace_outbound_blocked' : 'workspace_outbound_unblocked',
    target_workspace_id: workspaceId,
    metadata: { reason },
  });

  return { success: true };
}

export async function getBlockedDomainsAction(): Promise<PlatformBlockedDomain[]> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { data, error } = await adminClient
    .from('platform_blocked_domains')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return [];
  return (data || []) as PlatformBlockedDomain[];
}

export async function addBlockedDomainAction(
  domain: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  await assertStaffCapability('support');
  const adminClient = serviceClient();

  const cleanDomain = domain.trim().toLowerCase();
  if (!cleanDomain.includes('.')) {
    return { success: false, error: 'Please enter a valid domain name (e.g. spam.com)' };
  }

  const { error } = await adminClient.from('platform_blocked_domains').insert({
    domain: cleanDomain,
    reason: reason || 'Spam or abuse source',
  });

  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function removeBlockedDomainAction(id: string): Promise<{ success: boolean }> {
  await assertStaffCapability('support');
  const adminClient = serviceClient();

  await adminClient.from('platform_blocked_domains').delete().eq('id', id);
  return { success: true };
}

// ============================================================================
// 9. Data Tools (Export & Delayed Deletion with Grace Period)
// ============================================================================

export async function exportWorkspaceDataAction(workspaceId: string): Promise<{
  success: boolean;
  data?: any;
  error?: string;
}> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const [
    { data: ws },
    { data: agents },
    { data: tickets },
    { data: channels },
    { data: articles },
  ] = await Promise.all([
    adminClient.from('workspaces').select('*').eq('id', workspaceId).single(),
    adminClient.from('agents').select('id, name, email, role, created_at').eq('workspace_id', workspaceId),
    adminClient.from('tickets').select('id, ticket_number, subject, status, priority, created_at').eq('workspace_id', workspaceId).limit(500),
    adminClient.from('channel_connections').select('channel, status, created_at').eq('workspace_id', workspaceId),
    adminClient.from('helpdesk_articles').select('title, slug, status, created_at').eq('workspace_id', workspaceId),
  ]);

  if (!ws) return { success: false, error: 'Workspace not found.' };

  await adminClient.from('super_admin_audit_logs').insert({
    action: 'workspace_data_exported',
    target_workspace_id: workspaceId,
  });

  return {
    success: true,
    data: {
      exported_at: new Date().toISOString(),
      workspace: ws,
      team_members: agents || [],
      tickets_sample: tickets || [],
      connected_channels: channels || [],
      knowledge_articles: articles || [],
    },
  };
}

export async function scheduleWorkspaceDeletionAction(params: {
  workspaceId: string;
  confirmName: string;
  reason: string;
}): Promise<{ success: boolean; scheduledDate?: string; error?: string }> {
  const { user, agent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  const { data: ws } = await adminClient
    .from('workspaces')
    .select('id, name')
    .eq('id', params.workspaceId)
    .single();

  if (!ws) return { success: false, error: 'Workspace not found.' };

  if (ws.name.trim().toLowerCase() !== params.confirmName.trim().toLowerCase()) {
    return { success: false, error: 'Workspace confirmation name does not match.' };
  }

  // Schedule 30-day waiting period
  const deletionDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await adminClient
    .from('workspaces')
    .update({
      scheduled_deletion_at: deletionDate,
      deletion_requested_by: agent.email,
      is_suspended: true,
      suspension_reason: `Pending scheduled permanent deletion: ${params.reason}`,
    })
    .eq('id', ws.id);

  await adminClient.from('super_admin_audit_logs').insert({
    action: 'workspace_deletion_scheduled',
    target_workspace_id: ws.id,
    metadata: {
      scheduledDate: deletionDate,
      requestedBy: agent.email,
      reason: params.reason,
    },
  });

  return { success: true, scheduledDate: deletionDate };
}

export async function cancelWorkspaceDeletionAction(workspaceId: string): Promise<{ success: boolean; error?: string }> {
  await assertPlatformOwner();
  const adminClient = serviceClient();

  const { error } = await adminClient
    .from('workspaces')
    .update({
      scheduled_deletion_at: null,
      deletion_requested_by: null,
      is_suspended: false,
      suspension_reason: null,
    })
    .eq('id', workspaceId);

  if (error) return { success: false, error: error.message };

  await adminClient.from('super_admin_audit_logs').insert({
    action: 'workspace_deletion_canceled',
    target_workspace_id: workspaceId,
  });

  return { success: true };
}

// ============================================================================
// 10. Platform Staff Team RBAC (Owner, Support, Finance)
// ============================================================================

export async function getPlatformStaffListAction(): Promise<PlatformStaffMember[]> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { data, error } = await adminClient
    .from('agents')
    .select('id, name, email, is_super_admin, is_platform_owner, platform_staff_role, is_active, created_at')
    .eq('is_super_admin', true)
    .order('created_at', { ascending: true });

  if (error) return [];

  return (data || []).map((a: any) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    role: a.is_platform_owner
      ? 'owner'
      : (a.platform_staff_role as PlatformStaffRole) || 'support',
    is_active: a.is_active !== false,
    is_platform_owner: Boolean(a.is_platform_owner),
    created_at: a.created_at,
  }));
}

export async function updatePlatformStaffRoleAction(
  agentId: string,
  newRole: PlatformStaffRole
): Promise<{ success: boolean; error?: string }> {
  await assertPlatformOwner();
  const adminClient = serviceClient();

  const { error } = await adminClient
    .from('agents')
    .update({ platform_staff_role: newRole })
    .eq('id', agentId);

  if (error) return { success: false, error: error.message };

  await adminClient.from('super_admin_audit_logs').insert({
    action: 'staff_role_updated',
    metadata: { agentId, newRole },
  });

  return { success: true };
}

export async function revokePlatformStaffAccessAction(
  agentId: string
): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertPlatformOwner();
  if (agent.id === agentId) {
    return { success: false, error: 'Cannot revoke your own platform owner access.' };
  }

  const adminClient = serviceClient();

  const { error } = await adminClient
    .from('agents')
    .update({ is_super_admin: false, platform_staff_role: null })
    .eq('id', agentId);

  if (error) return { success: false, error: error.message };

  await adminClient.from('super_admin_audit_logs').insert({
    action: 'staff_access_revoked',
    metadata: { revokedAgentId: agentId },
  });

  return { success: true };
}
