'use server';

import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import crypto from 'node:crypto';
import {
  Workspace,
  Agent,
  SuperAdminAuditLog,
  SMTPSettingsConfig,
  PlatformOverviewMetrics,
  PlatformUserItem,
  SystemHealthReport,
  SuperAdminWorkspaceNote,
  PlatformSuperAdminInvitation,
  PlatformAccessRole,
  PlatformAccessMember,
  AdminInviteItem,
} from '@/types/database';
import { generateUniqueWorkspaceSlug } from '@/lib/slug';
import {
  testSmtpConnection,
  sendSmtpEmail,
  isValidEmail,
  generateAdminInviteEmailHtml,
  smtpTestEmail,
  generateAdminAccessGrantedEmailHtml,
} from '@/lib/email/smtp';
import { addDomain } from '@/lib/vercel-domains';
import { cleanDomain, getPlatformOrigin } from '@/lib/domain';
import { getRequestOrigin } from '@/lib/request-origin';
import { userError } from '@/lib/errors/user-error';
import { findAuthUserByEmail } from '@/lib/auth/verification-code';

export type {
  PlatformUserItem,
  PlatformOverviewMetrics,
  SystemHealthReport,
  SuperAdminWorkspaceNote,
  PlatformSuperAdminInvitation,
};

export interface CompanyPlanLimits {
  max_seats: number;
  max_monthly_conversations: number;
  max_ai_replies: number;
}

export interface CompanyMetricItem {
  id: string;
  name: string;
  website_url: string | null;
  brand_color: string;
  logo_url: string | null;
  widget_position: string;
  greeting_title: string | null;
  greeting_message: string | null;
  business_hours: any;
  auto_assignment: any;
  ai_settings?: any;
  ai_enabled: boolean;
  help_center_tab_label: string;
  show_help_tab: boolean;
  created_at: string;
  owner_id: string;
  owner_email: string | null;
  is_suspended: boolean;
  suspended_at: string | null;
  suspension_reason: string | null;
  deleted_at: string | null;
  plan: string;
  plan_limits: CompanyPlanLimits;
  merged_into_workspace_id: string | null;
  conversations_count: number;
  open_conversations_count: number;
  closed_conversations_count: number;
  messages_count: number;
  visitors_count: number;
  active_visitors_count: number;
  agents_count: number;
  articles_count: number;
  published_articles_count: number;
  total_article_views: number;
  widget_installed: boolean;
  last_activity_at: string | null;
  health_flags?: string[];
  csat_score?: number | null;
  csat_count?: number;
  unanswered_older_24h_count?: number;
  knowledge_gaps_count?: number;
  tickets_30d_count?: number;
  connected_channels?: string[];
  status?: 'active' | 'suspended';
}

export interface PlatformWorkspaceItem {
  id: string;
  name: string;
  website_url: string | null;
  status: 'active' | 'suspended';
  is_suspended: boolean;
  suspended_at: string | null;
  suspension_reason: string | null;
  deleted_at: string | null;
  plan: string;
  brand_color: string;
  logo_url: string | null;
  agents_count: number;
  tickets_30d_count: number;
  connected_channels: string[];
  last_activity_at: string | null;
  created_at: string;
  owner_email: string | null;
}

export interface PlatformOverviewData {
  range_days: number;
  total_workspaces: number;
  active_workspaces: number;
  suspended_workspaces: number;
  total_tickets: number;
  tickets_30d: number;
  total_members: number;
  avg_first_reply_seconds: number | null;
  resolution_rate_percent: number;
  bot_resolved_count: number;
  bot_handover_count: number;
  tickets_per_day: Array<{
    date: string;
    formatted_date: string;
    tickets: number;
    solved: number;
  }>;
  top_articles: Array<{
    id: string;
    title: string;
    slug: string;
    workspace_id: string;
    workspace_name: string;
    views_count: number;
    helpful_count: number;
  }>;
}

export interface WorkspaceDetailData {
  workspace: {
    id: string;
    name: string;
    website_url: string | null;
    brand_color: string;
    status: 'active' | 'suspended';
    is_suspended: boolean;
    suspended_at: string | null;
    suspension_reason: string | null;
    plan: string;
    owner_email: string | null;
    created_at: string;
    connected_channels: string[];
    tickets_30d_count: number;
    total_tickets: number;
    agents_count: number;
  };
  tickets_per_day: Array<{
    date: string;
    formatted_date: string;
    tickets: number;
    solved: number;
  }>;
  avg_first_reply_seconds: number | null;
  resolution_rate_percent: number;
  bot_resolved_count: number;
  bot_handover_count: number;
  top_articles: Array<{
    id: string;
    title: string;
    slug: string;
    status: string;
    views_count: number;
    helpful_count: number;
    created_at: string;
  }>;
  members: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    avatar_url: string | null;
    created_at: string;
    is_active: boolean;
    max_open_tickets: number | null;
  }>;
}

export interface PlatformAnalyticsTimeSeriesPoint {
  date: string;
  formatted_date: string;
  new_companies: number;
  conversations: number;
  messages: number;
  visitors: number;
  ai_replies: number;
  estimated_ai_cost: number;
}

export interface PlatformWeeklyCompanyPoint {
  week_start: string;
  week_label: string;
  new_companies: number;
}

export interface PlatformTopCompany {
  id: string;
  name: string;
  website_url: string | null;
  brand_color: string;
  plan: string;
  conversations_count: number;
  messages_count: number;
  visitors_count: number;
  share_percent: number;
}

export interface PlatformAnalyticsData {
  range_days: number;
  start_date: string;
  end_date: string;
  time_series: PlatformAnalyticsTimeSeriesPoint[];
  weekly_companies: PlatformWeeklyCompanyPoint[];
  active_companies_7d_count: number;
  total_companies_count: number;
  active_companies_7d_percent: number;
  top_10_companies: PlatformTopCompany[];
  totals: {
    total_conversations: number;
    total_messages: number;
    total_visitors: number;
    total_ai_replies: number;
    total_new_companies: number;
  };
  total_estimated_ai_cost: number;
}

export interface CompanyAnalyticsData {
  workspace_id: string;
  workspace_name: string;
  range_days: number;
  conversations_per_day: Array<{
    date: string;
    formatted_date: string;
    conversations: number;
    messages: number;
    ai_replies: number;
    agent_replies: number;
  }>;
  total_conversations: number;
  open_conversations_count: number;
  resolved_conversations_count: number;
  resolution_rate_percent: number;
  avg_first_response_time_seconds: number | null;
  avg_resolution_time_seconds: number | null;
  csat_score: number | null;
  csat_ratings_count: number;
  csat_positive_percent: number | null;
  ai_only_chats_count: number;
  ai_only_chats_percent: number;
  ai_handover_chats_count: number;
  ai_handover_percent: number;
  unanswered_older_24h_count: number;
  unanswered_older_24h_list: Array<{
    id: string;
    created_at: string;
    waiting_hours: number;
    visitor_name: string;
    channel: string;
  }>;
  knowledge_gaps_count: number;
  knowledge_gaps_sample: Array<{
    id: string;
    question: string;
    times_asked: number;
    last_asked_at: string;
  }>;
  health_flags: string[];
  widget_installed: boolean;
  agent_online_7d: boolean;
  published_articles_count: number;
}

export interface OrphanAgent {
  id: string;
  name: string;
  email: string;
  role: string;
  is_super_admin: boolean;
  created_at: string;
  workspace_id: string | null;
  issue_reason: string;
}

export interface OrphanConversation {
  id: string;
  visitor_id: string;
  status: string;
  channel: string;
  created_at: string;
  updated_at: string;
  workspace_id: string | null;
  issue_reason: string;
}

export interface OrphanMessage {
  id: string;
  conversation_id: string;
  sender_type: string;
  created_at: string;
  content_preview: string;
  issue_reason: string;
}

export interface OrphanVisitor {
  id: string;
  name: string | null;
  email: string | null;
  current_url: string | null;
  location: string | null;
  last_seen: string;
  created_at: string;
  workspace_id: string | null;
  issue_reason: string;
}

export interface PlatformDataIssues {
  total_orphan_count: number;
  orphan_agents: OrphanAgent[];
  orphan_conversations: OrphanConversation[];
  orphan_messages: OrphanMessage[];
  orphan_visitors: OrphanVisitor[];
}

export interface PlatformCompaniesData {
  total_companies: number;
  total_conversations: number;
  total_messages: number;
  total_visitors: number;
  total_agents: number;
  total_articles: number;
  active_companies_7d?: number;
  active_companies_7d_percent?: number;
  companies: CompanyMetricItem[];
  data_issues?: PlatformDataIssues;
}

/**
 * Server-side guard: Ensures caller is an authenticated platform super admin.
 * Checks platform_access table as the single source of truth.
 */
export async function assertSuperAdmin(): Promise<{ user: any; agent: Agent; accessRole: 'owner' | 'admin' }> {
  // Every admin click runs this. getClaims verifies the session token's
  // signature locally instead of a round trip to Supabase Auth, and the two
  // lookups below run together rather than one after the other.
  const supabase = await createClient();
  // getUser stays as the fallback for clients without getClaims (test mocks).
  const { data: claimData, error } =
    typeof supabase.auth.getClaims === 'function'
      ? await supabase.auth.getClaims()
      : await supabase.auth.getUser().then(({ data, error: e }) => ({
          data: data?.user ? { claims: { sub: data.user.id, email: data.user.email, user_metadata: data.user.user_metadata } } : null,
          error: e,
        }));
  const claims = claimData?.claims as { sub?: string; email?: string; user_metadata?: unknown } | undefined;
  if (error || !claims?.sub) {
    throw userError('401 Unauthorized: Authentication required.');
  }
  const user = {
    id: claims.sub as string,
    email: (claims.email as string | undefined) ?? '',
    user_metadata: (claims.user_metadata as Record<string, unknown> | undefined) ?? {},
  };

  // platform_access is the single source of truth.
  const adminClient = serviceClient();
  const [{ data: access, error: accessError }, { data: agent }] = await Promise.all([
    adminClient.from('platform_access').select('*').eq('user_id', user.id).maybeSingle(),
    adminClient.from('agents').select('*').eq('id', user.id).maybeSingle(),
  ]);

  if (accessError || !access || !['owner', 'admin'].includes(access.role)) {
    throw userError('403 Forbidden: Platform super admin privileges required.');
  }

  const currentAgent: Agent = agent || ({
    id: user.id,
    name: user.user_metadata?.name || user.email?.split('@')[0] || 'Admin',
    email: user.email || '',
    role: 'owner',
    status: 'online',
    is_active: true,
  } as Agent);

  currentAgent.is_super_admin = true;
  currentAgent.is_platform_owner = access.role === 'owner';
  currentAgent.platform_staff_role = access.role === 'owner' ? 'owner' : (agent?.platform_staff_role || 'support');

  return { user, agent: currentAgent, accessRole: access.role as 'owner' | 'admin' };
}

/**
 * Server-side guard: Ensures caller is the authenticated ZenTry platform owner.
 * Only the owner can manage platform access.
 */
export async function assertPlatformOwner(): Promise<{ user: any; agent: Agent; accessRole: 'owner' }> {
  const { user, agent, accessRole } = await assertSuperAdmin();

  if (accessRole !== 'owner') {
    throw userError('403 Forbidden: Only the platform owner can manage admin access.');
  }

  return { user, agent, accessRole: 'owner' };
}

/**
 * Inserts an immutable audit log record for super admin actions
 */
export async function recordSuperAdminAudit(params: {
  admin: Agent;
  action: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
  details?: Record<string, any>;
}) {
  try {
    const supabase = await createClient();
    await supabase.from('super_admin_audit_logs').insert({
      admin_id: params.admin.id,
      admin_email: params.admin.email,
      admin_name: params.admin.name || null,
      action: params.action,
      workspace_id: params.workspaceId || null,
      workspace_name: params.workspaceName || null,
      details: params.details || {},
    });
  } catch (err) {
    console.error('Failed to write super admin audit log:', err);
  }
}

/**
 * Retrieves platform-wide summary of all registered companies and their aggregated data
 */
export async function getPlatformCompaniesAction(): Promise<PlatformCompaniesData> {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('fn_get_platform_companies_summary');

  if (error || !data) {
    throw userError(`Failed to load platform companies: ${error?.message || 'No data'}`);
  }

  const result = data as PlatformCompaniesData;
  try {
    const adminClient = serviceClient();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [
      { data: tickets },
      { data: channelConns },
    ] = await Promise.all([
      adminClient.from('tickets').select('id, workspace_id, created_at').gte('created_at', thirtyDaysAgo),
      adminClient.from('channel_connections').select('workspace_id, channel, status').neq('status', 'disconnected'),
    ]);

    const ticketMap = new Map<string, number>();
    for (const t of tickets || []) {
      ticketMap.set(t.workspace_id, (ticketMap.get(t.workspace_id) || 0) + 1);
    }

    const channelMap = new Map<string, Set<string>>();
    for (const c of channelConns || []) {
      if (!channelMap.has(c.workspace_id)) channelMap.set(c.workspace_id, new Set());
      channelMap.get(c.workspace_id)!.add(c.channel);
    }

    result.companies = (result.companies || []).map((c) => {
      const channels = Array.from(channelMap.get(c.id) || []);
      if (c.widget_installed && !channels.includes('chat')) channels.push('chat');
      return {
        ...c,
        tickets_30d_count: c.tickets_30d_count ?? ticketMap.get(c.id) ?? 0,
        connected_channels: c.connected_channels ?? channels,
        status: c.is_suspended ? ('suspended' as const) : ('active' as const),
      };
    });
  } catch {
    // Return base result if auxiliary query fails
  }

  return result;
}

/**
 * Retrieves time-series and aggregate platform analytics for the platform owner
 */
export async function getPlatformAnalyticsAction(days: number = 30): Promise<PlatformAnalyticsData> {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('fn_get_platform_analytics', {
    p_days: days,
  });

  if (error) {
    throw userError(`Failed to load platform analytics: ${error.message}`);
  }

  return data as PlatformAnalyticsData;
}

/**
 * Retrieves deep performance analytics and health diagnostics for a specific company
 */
export async function getCompanyAnalyticsAction(
  workspaceId: string,
  days: number = 30
): Promise<CompanyAnalyticsData> {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('fn_get_company_analytics', {
    p_workspace_id: workspaceId,
    p_days: days,
  });

  if (error) {
    throw userError(`Failed to load company analytics: ${error.message}`);
  }

  return data as CompanyAnalyticsData;
}

/**
 * Platform Owner Action: Retrieve workspaces list with name, site, status,
 * agents count, tickets in the last 30 days, connected channels, and last activity.
 */
export async function getPlatformWorkspacesAction(): Promise<PlatformWorkspaceItem[]> {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('fn_get_platform_workspaces');
  if (!error && Array.isArray(data)) {
    return data as PlatformWorkspaceItem[];
  }

  // Fallback to direct relational queries using serviceClient
  const adminClient = serviceClient();
  const [
    { data: workspaces },
    { data: agents },
    { data: tickets },
    { data: channelConns },
    { data: visitors },
  ] = await Promise.all([
    adminClient.from('workspaces').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    adminClient.from('agents').select('id, workspace_id, role, email'),
    adminClient.from('tickets').select('id, workspace_id, created_at, updated_at'),
    adminClient.from('channel_connections').select('workspace_id, channel, status'),
    adminClient.from('visitors').select('workspace_id, last_seen, last_seen_at'),
  ]);

  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  return (workspaces || []).map((ws: any) => {
    const wsAgents = (agents || []).filter((a: any) => a.workspace_id === ws.id);
    const wsTickets = (tickets || []).filter((t: any) => t.workspace_id === ws.id);
    const tickets30d = wsTickets.filter((t: any) => new Date(t.created_at).getTime() >= thirtyDaysAgo);
    const wsConns = (channelConns || []).filter((c: any) => c.workspace_id === ws.id && c.status !== 'disconnected');
    const wsVisitors = (visitors || []).filter((v: any) => v.workspace_id === ws.id);

    const channels = Array.from(new Set(wsConns.map((c: any) => c.channel as string)));
    if (wsVisitors.length > 0 && !channels.includes('chat')) {
      channels.push('chat');
    }

    const timestamps = [
      new Date(ws.created_at).getTime(),
      ...wsTickets.map((t: any) => new Date(t.updated_at || t.created_at).getTime()),
      ...wsVisitors.map((v: any) => new Date(v.last_seen || v.last_seen_at || 0).getTime()),
    ].filter((t) => !isNaN(t));

    const maxTime = timestamps.length > 0 ? Math.max(...timestamps) : new Date(ws.created_at).getTime();
    const owner = wsAgents.find((a: any) => a.role === 'owner');

    return {
      id: ws.id,
      name: ws.name,
      website_url: ws.website_url || ws.custom_domain || null,
      status: ws.is_suspended ? ('suspended' as const) : ('active' as const),
      is_suspended: Boolean(ws.is_suspended),
      suspended_at: ws.suspended_at || null,
      suspension_reason: ws.suspension_reason || null,
      deleted_at: ws.deleted_at || null,
      plan: ws.plan || 'free',
      brand_color: ws.brand_color || '#2563eb',
      logo_url: ws.logo_url || null,
      agents_count: wsAgents.length,
      tickets_30d_count: tickets30d.length,
      connected_channels: channels,
      last_activity_at: new Date(maxTime).toISOString(),
      created_at: ws.created_at,
      owner_email: owner?.email || null,
    };
  });
}

/**
 * Platform Owner Action: Retrieve platform overview totals across all workspaces
 * with the same metrics (tickets per day, FRT, resolution rate, bot vs human, top articles, members).
 */
export async function getPlatformOverviewAction(days: number = 30): Promise<PlatformOverviewData> {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('fn_get_platform_overview', { p_days: days });
  if (!error && data) {
    return data as PlatformOverviewData;
  }

  // Fallback calculation using serviceClient
  const adminClient = serviceClient();
  const rangeMs = days * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const [
    { data: workspaces },
    { data: agents },
    { data: tickets },
    { data: articles },
    { data: messages },
  ] = await Promise.all([
    adminClient.from('workspaces').select('id, name, is_suspended, deleted_at').is('deleted_at', null),
    adminClient.from('agents').select('id, workspace_id').not('workspace_id', 'is', null),
    adminClient.from('tickets').select('id, workspace_id, status, created_at, solved_at, closed_at, updated_at, conversation_id'),
    adminClient.from('articles').select('id, title, slug, workspace_id, views_count, helpful_count, status').eq('status', 'published').order('views_count', { ascending: false }).limit(10),
    adminClient.from('messages').select('id, conversation_id, sender_type, created_at'),
  ]);

  const activeWs = (workspaces || []).filter((w: any) => !w.is_suspended);
  const suspendedWs = (workspaces || []).filter((w: any) => w.is_suspended);
  const allTickets = tickets || [];
  const tickets30d = allTickets.filter((t: any) => new Date(t.created_at).getTime() >= thirtyDaysAgo);
  const solvedCount = allTickets.filter((t: any) => ['solved', 'closed'].includes(t.status)).length;
  const resolutionRate = allTickets.length > 0 ? Number(((solvedCount / allTickets.length) * 100).toFixed(1)) : 0;

  // Tickets per day chart
  const dateMap = new Map<string, { tickets: number; solved: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    dateMap.set(key, { tickets: 0, solved: 0 });
  }

  for (const t of allTickets) {
    const cKey = new Date(t.created_at).toISOString().slice(0, 10);
    if (dateMap.has(cKey)) {
      dateMap.get(cKey)!.tickets += 1;
    }
    if (['solved', 'closed'].includes(t.status)) {
      const sDate = t.solved_at || t.closed_at || t.updated_at;
      if (sDate) {
        const sKey = new Date(sDate).toISOString().slice(0, 10);
        if (dateMap.has(sKey)) {
          dateMap.get(sKey)!.solved += 1;
        }
      }
    }
  }

  const ticketsPerDay = Array.from(dateMap.entries()).map(([date, counts]) => {
    const d = new Date(date);
    const formatted_date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return {
      date,
      formatted_date,
      tickets: counts.tickets,
      solved: counts.solved,
    };
  });

  // Calculate FRT
  const msgByConv = new Map<string, any[]>();
  for (const m of messages || []) {
    if (!msgByConv.has(m.conversation_id)) msgByConv.set(m.conversation_id, []);
    msgByConv.get(m.conversation_id)!.push(m);
  }

  const frtList: number[] = [];
  for (const t of allTickets) {
    if (t.conversation_id && msgByConv.has(t.conversation_id)) {
      const convMsgs = msgByConv.get(t.conversation_id)!;
      const replies = convMsgs.filter((m: any) => ['agent', 'ai'].includes(m.sender_type) && new Date(m.created_at) >= new Date(t.created_at));
      if (replies.length > 0) {
        const first = Math.min(...replies.map((m: any) => new Date(m.created_at).getTime()));
        const diffSec = Math.round((first - new Date(t.created_at).getTime()) / 1000);
        if (diffSec >= 0) frtList.push(diffSec);
      }
    }
  }
  const avgFrt = frtList.length > 0 ? Math.round(frtList.reduce((a, b) => a + b, 0) / frtList.length) : null;

  // Bot resolved vs handover
  let botResolved = 0;
  let botHandover = 0;
  for (const [convId, cMsgs] of msgByConv.entries()) {
    const hasAi = cMsgs.some((m: any) => m.sender_type === 'ai');
    const hasAgent = cMsgs.some((m: any) => m.sender_type === 'agent');
    if (hasAi && !hasAgent) botResolved++;
    if (hasAi && hasAgent) botHandover++;
  }

  // Top articles with workspace names
  const wsMap = new Map((workspaces || []).map((w: any) => [w.id, w.name]));
  const topArticles = (articles || []).map((a: any) => ({
    id: a.id,
    title: a.title,
    slug: a.slug,
    workspace_id: a.workspace_id,
    workspace_name: wsMap.get(a.workspace_id) || 'Support',
    views_count: a.views_count || 0,
    helpful_count: a.helpful_count || 0,
  }));

  return {
    range_days: days,
    total_workspaces: (workspaces || []).length,
    active_workspaces: activeWs.length,
    suspended_workspaces: suspendedWs.length,
    total_tickets: allTickets.length,
    tickets_30d: tickets30d.length,
    total_members: (agents || []).length,
    avg_first_reply_seconds: avgFrt,
    resolution_rate_percent: resolutionRate,
    bot_resolved_count: botResolved,
    bot_handover_count: botHandover,
    tickets_per_day: ticketsPerDay,
    top_articles: topArticles,
  };
}

/**
 * Platform Owner Action: Retrieve deep workspace detail page metrics
 * (tickets per day, average FRT, resolution rate, bot vs human, top articles, members).
 */
export async function getWorkspaceDetailAction(
  workspaceId: string,
  days: number = 30
): Promise<WorkspaceDetailData> {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('fn_get_workspace_owner_detail', {
    p_workspace_id: workspaceId,
    p_days: days,
  });
  if (!error && data) {
    return data as WorkspaceDetailData;
  }

  // Fallback calculation using serviceClient
  const adminClient = serviceClient();
  const [
    { data: ws, error: wsError },
    { data: members },
    { data: tickets },
    { data: articles },
    { data: channelConns },
    { data: visitors },
    { data: messages },
  ] = await Promise.all([
    adminClient.from('workspaces').select('*').eq('id', workspaceId).single(),
    adminClient.from('agents').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: true }),
    adminClient.from('tickets').select('*').eq('workspace_id', workspaceId),
    adminClient.from('articles').select('*').eq('workspace_id', workspaceId).order('views_count', { ascending: false }).limit(10),
    adminClient.from('channel_connections').select('channel, status').eq('workspace_id', workspaceId).neq('status', 'disconnected'),
    adminClient.from('visitors').select('id').eq('workspace_id', workspaceId).limit(1),
    adminClient.from('messages').select('id, conversation_id, sender_type, created_at'),
  ]);

  if (wsError || !ws) {
    throw userError('Workspace not found.');
  }

  const allTickets = tickets || [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const tickets30d = allTickets.filter((t: any) => new Date(t.created_at).getTime() >= thirtyDaysAgo);
  const solvedCount = allTickets.filter((t: any) => ['solved', 'closed'].includes(t.status)).length;
  const resolutionRate = allTickets.length > 0 ? Number(((solvedCount / allTickets.length) * 100).toFixed(1)) : 0;

  // Tickets per day chart
  const dateMap = new Map<string, { tickets: number; solved: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    dateMap.set(key, { tickets: 0, solved: 0 });
  }

  for (const t of allTickets) {
    const cKey = new Date(t.created_at).toISOString().slice(0, 10);
    if (dateMap.has(cKey)) {
      dateMap.get(cKey)!.tickets += 1;
    }
    if (['solved', 'closed'].includes(t.status)) {
      const sDate = t.solved_at || t.closed_at || t.updated_at;
      if (sDate) {
        const sKey = new Date(sDate).toISOString().slice(0, 10);
        if (dateMap.has(sKey)) {
          dateMap.get(sKey)!.solved += 1;
        }
      }
    }
  }

  const ticketsPerDay = Array.from(dateMap.entries()).map(([date, counts]) => {
    const d = new Date(date);
    const formatted_date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return {
      date,
      formatted_date,
      tickets: counts.tickets,
      solved: counts.solved,
    };
  });

  // Calculate FRT for this workspace
  const msgByConv = new Map<string, any[]>();
  for (const m of messages || []) {
    if (!msgByConv.has(m.conversation_id)) msgByConv.set(m.conversation_id, []);
    msgByConv.get(m.conversation_id)!.push(m);
  }

  const frtList: number[] = [];
  for (const t of allTickets) {
    if (t.conversation_id && msgByConv.has(t.conversation_id)) {
      const convMsgs = msgByConv.get(t.conversation_id)!;
      const replies = convMsgs.filter((m: any) => ['agent', 'ai'].includes(m.sender_type) && new Date(m.created_at) >= new Date(t.created_at));
      if (replies.length > 0) {
        const first = Math.min(...replies.map((m: any) => new Date(m.created_at).getTime()));
        const diffSec = Math.round((first - new Date(t.created_at).getTime()) / 1000);
        if (diffSec >= 0) frtList.push(diffSec);
      }
    }
  }
  const avgFrt = frtList.length > 0 ? Math.round(frtList.reduce((a, b) => a + b, 0) / frtList.length) : null;

  // Bot resolved vs handover
  let botResolved = 0;
  let botHandover = 0;
  for (const t of allTickets) {
    if (t.conversation_id && msgByConv.has(t.conversation_id)) {
      const convMsgs = msgByConv.get(t.conversation_id)!;
      const hasAi = convMsgs.some((m: any) => m.sender_type === 'ai');
      const hasAgent = convMsgs.some((m: any) => m.sender_type === 'agent');
      if (hasAi && !hasAgent) botResolved++;
      if (hasAi && hasAgent) botHandover++;
    }
  }

  // Channels
  const channels = Array.from(new Set((channelConns || []).map((c: any) => c.channel as string)));
  if ((visitors || []).length > 0 && !channels.includes('chat')) {
    channels.push('chat');
  }

  const owner = (members || []).find((m: any) => m.role === 'owner');

  return {
    workspace: {
      id: ws.id,
      name: ws.name,
      website_url: ws.website_url || ws.custom_domain || null,
      brand_color: ws.brand_color || '#2563eb',
      status: ws.is_suspended ? ('suspended' as const) : ('active' as const),
      is_suspended: Boolean(ws.is_suspended),
      suspended_at: ws.suspended_at || null,
      suspension_reason: ws.suspension_reason || null,
      plan: ws.plan || 'free',
      owner_email: owner?.email || null,
      created_at: ws.created_at,
      connected_channels: channels,
      tickets_30d_count: tickets30d.length,
      total_tickets: allTickets.length,
      agents_count: (members || []).length,
    },
    tickets_per_day: ticketsPerDay,
    avg_first_reply_seconds: avgFrt,
    resolution_rate_percent: resolutionRate,
    bot_resolved_count: botResolved,
    bot_handover_count: botHandover,
    top_articles: (articles || []).map((a: any) => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      status: a.status,
      views_count: a.views_count || 0,
      helpful_count: a.helpful_count || 0,
      created_at: a.created_at,
    })),
    members: (members || []).map((m: any) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      status: m.status,
      avatar_url: m.avatar_url || null,
      created_at: m.created_at,
      is_active: m.is_active !== false,
      max_open_tickets: m.max_open_tickets || null,
    })),
  };
}

/**
 * Super Admin Action: Suspend a workspace
 * Blocks widget and agent logins while preserving data, with audit log.
 */
export async function suspendWorkspaceAction(workspaceId: string, reason?: string) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data: ws, error: fetchErr } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('id', workspaceId)
    .single();

  if (fetchErr || !ws) {
    throw userError('Workspace not found.');
  }

  const suspensionReason = reason?.trim() || 'Suspended by Platform Super Admin';

  const { error } = await supabase
    .from('workspaces')
    .update({
      is_suspended: true,
      suspended_at: new Date().toISOString(),
      suspension_reason: suspensionReason,
    })
    .eq('id', workspaceId);

  if (error) {
    throw userError(`Failed to suspend workspace: ${error.message}`);
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'suspend_workspace',
    workspaceId,
    workspaceName: ws.name,
    details: { reason: suspensionReason },
  });

  return { success: true };
}

/**
 * Super Admin Action: Reactivate a suspended workspace
 * Restores access, with audit log.
 */
export async function reactivateWorkspaceAction(workspaceId: string) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data: ws, error: fetchErr } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('id', workspaceId)
    .single();

  if (fetchErr || !ws) {
    throw userError('Workspace not found.');
  }

  const { error } = await supabase
    .from('workspaces')
    .update({
      is_suspended: false,
      suspended_at: null,
      suspension_reason: null,
    })
    .eq('id', workspaceId);

  if (error) {
    throw userError(`Failed to reactivate workspace: ${error.message}`);
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'reactivate_workspace',
    workspaceId,
    workspaceName: ws.name,
    details: {},
  });

  return { success: true };
}

/**
 * Loads deep drill-down details for a specific company
 */
export async function getCompanyDrilldownAction(workspaceId: string) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const [
    { data: workspace },
    { data: agents },
    { data: recentConversations },
    { data: recentVisitors },
    { count: visitorsCount },
    { count: activeVisitorsCount },
    { data: articles },
  ] = await Promise.all([
    supabase.from('workspaces').select('*').eq('id', workspaceId).maybeSingle(),
    supabase.from('agents').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }),
    supabase
      .from('conversations')
      .select('id, visitor_id, status, created_at, updated_at, channel, visitor:visitors(name, email, location)')
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false })
      .limit(20),
    supabase
      .from('visitors')
      .select('id, name, email, current_url, current_page_url, location, ip_location_city, ip_location_country, last_seen, last_seen_at, is_online, visit_count, first_seen, first_seen_at')
      .eq('workspace_id', workspaceId)
      .order('last_seen', { ascending: false })
      .limit(20),
    supabase
      .from('visitors')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    supabase
      .from('visitors')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gt('last_seen', new Date(Date.now() - 30 * 60 * 1000).toISOString()),
    supabase
      .from('articles')
      .select('id, title, status, views_count, helpful_count, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  // 1. Sort conversations by last activity (updated_at || created_at), newest first
  const sortedConversations = [...(recentConversations || [])].sort((a: any, b: any) => {
    const timeA = new Date(a.updated_at || a.created_at || 0).getTime();
    const timeB = new Date(b.updated_at || b.created_at || 0).getTime();
    return timeB - timeA;
  });

  // 2. Format and sort visitors from the same workspace visitor source
  const sortedVisitors = [...(recentVisitors || [])]
    .map((v: any) => ({
      ...v,
      current_url: v.current_url || v.current_page_url || '/',
      location: v.location || [v.ip_location_city, v.ip_location_country].filter(Boolean).join(', ') || null,
      last_seen: v.last_seen || v.last_seen_at || v.first_seen || v.first_seen_at,
      is_browsing_now:
        (Date.now() - new Date(v.last_seen || v.last_seen_at || 0).getTime()) <= 30 * 60 * 1000,
    }))
    .sort((a: any, b: any) => {
      const timeA = new Date(a.last_seen || 0).getTime();
      const timeB = new Date(b.last_seen || 0).getTime();
      return timeB - timeA;
    });

  await recordSuperAdminAudit({
    admin: agent,
    action: 'view_company_drilldown',
    workspaceId,
    workspaceName: workspace?.name || null,
    details: {
      agents_count: agents?.length || 0,
      recent_conversations_count: sortedConversations.length,
      visitors_count: visitorsCount || 0,
      active_visitors_count: activeVisitorsCount || 0,
    },
  });

  return {
    workspace: workspace as Workspace | null,
    agents: (agents || []) as Agent[],
    recentConversations: sortedConversations,
    recentVisitors: sortedVisitors,
    visitorsCount: visitorsCount || 0,
    activeVisitorsCount: activeVisitorsCount || 0,
    articles: articles || [],
  };
}

/**
 * Helper: Finds an existing agent by email or creates/invites an agent account
 */
async function findOrCreateOwnerAgent(
  ownerEmail: string,
  workspaceId?: string,
  name?: string
): Promise<{ id: string; email: string }> {
  const adminClient = serviceClient();
  const normalizedEmail = ownerEmail.trim().toLowerCase();

  // 1. Check if agent already exists
  const { data: existingAgent } = await adminClient
    .from('agents')
    .select('id, email, workspace_id, role')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existingAgent) {
    if (workspaceId) {
      await adminClient
        .from('agents')
        .update({
          role: 'owner',
          workspace_id: workspaceId,
        })
        .eq('id', existingAgent.id);
    }
    return { id: existingAgent.id, email: existingAgent.email };
  }

  // 2. Try inviting or creating in Supabase Auth
  let targetUserId: string | null = null;
  const displayName = name || normalizedEmail.split('@')[0];

  try {
    const { data: inviteData } = await adminClient.auth.admin.inviteUserByEmail(
      normalizedEmail,
      {
        data: {
          name: displayName,
          workspace_id: workspaceId,
          role: 'owner',
        },
      }
    );
    if (inviteData?.user?.id) {
      targetUserId = inviteData.user.id;
    }
  } catch (err) {
    // invite fallback
  }

  if (!targetUserId) {
    try {
      const { data: createData } = await adminClient.auth.admin.createUser({
        email: normalizedEmail,
        email_confirm: true,
        user_metadata: {
          name: displayName,
          workspace_id: workspaceId,
          role: 'owner',
        },
      });
      if (createData?.user?.id) {
        targetUserId = createData.user.id;
      }
    } catch (err) {
      // ignore
    }
  }

  if (!targetUserId) {
    targetUserId = crypto.randomUUID();
  }

  // 3. Upsert agent profile
  await adminClient.from('agents').upsert(
    {
      id: targetUserId,
      email: normalizedEmail,
      name: displayName,
      role: 'owner',
      status: 'offline',
      workspace_id: workspaceId || null,
    },
    { onConflict: 'id' }
  );

  return { id: targetUserId, email: normalizedEmail };
}

/**
 * Registers a brand new company/workspace from the platform admin panel
 * Requires an owner email, creates/invites owner agent, sets initial plan and limits.
 */
export async function createCompanyAction(data: {
  name: string;
  owner_email: string;
  website_url?: string;
  brand_color?: string;
  greeting_title?: string;
  greeting_message?: string;
  plan?: string;
  plan_limits?: {
    max_seats?: number;
    max_monthly_conversations?: number;
    max_ai_replies?: number;
  };
}) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  if (!data.name?.trim()) {
    throw userError('Company name is required.');
  }
  if (!data.owner_email?.trim()) {
    throw userError('Owner email is required to create a new company.');
  }

  const normalizedOwnerEmail = data.owner_email.trim().toLowerCase();

  // Find or create owner user
  const owner = await findOrCreateOwnerAgent(normalizedOwnerEmail, undefined, data.name.trim() + ' Admin');

  const slug = await generateUniqueWorkspaceSlug(supabase, data.name.trim());

  const defaultLimits: CompanyPlanLimits = {
    max_seats: data.plan_limits?.max_seats ?? 5,
    max_monthly_conversations: data.plan_limits?.max_monthly_conversations ?? 1000,
    max_ai_replies: data.plan_limits?.max_ai_replies ?? 500,
  };

  const { data: newWs, error } = await supabase
    .from('workspaces')
    .insert({
      name: data.name.trim(),
      website_url: data.website_url?.trim() || null,
      brand_color: data.brand_color || '#2563eb',
      greeting_title: data.greeting_title?.trim() || 'Welcome to Support! 👋',
      greeting_message: data.greeting_message?.trim() || 'How can our team help you today?',
      owner_id: owner.id,
      slug,
      slug_changes_count: 0,
      slug_changed_at: null,
      widget_position: 'right',
      help_center_tab_label: 'Help Center',
      show_help_tab: true,
      help_center_tab_icon: '📖',
      plan: data.plan || 'free',
      plan_limits: defaultLimits,
    })
    .select()
    .single();

  if (error) {
    throw userError(`Failed to create company workspace: ${error.message}`);
  }

  // Ensure owner agent points to this new workspace
  const adminClient = serviceClient();
  await adminClient.from('agents').update({ workspace_id: newWs.id }).eq('id', owner.id);

  await recordSuperAdminAudit({
    admin: agent,
    action: 'create_company',
    workspaceId: newWs.id,
    workspaceName: newWs.name,
    details: {
      owner_email: normalizedOwnerEmail,
      owner_id: owner.id,
      website_url: newWs.website_url,
      brand_color: newWs.brand_color,
      plan: newWs.plan,
    },
  });

  return { success: true, workspace: newWs as Workspace, owner_email: normalizedOwnerEmail };
}

/**
 * Super Admin Action: Suspend a company workspace
 * Immediately blocks the widget and agent logins while preserving all data.
 */
export async function suspendCompanyAction(workspaceId: string, reason?: string) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data: ws, error: fetchErr } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('id', workspaceId)
    .single();

  if (fetchErr || !ws) {
    throw userError('Workspace not found.');
  }

  const suspensionReason = reason?.trim() || 'Suspended by Super Admin';

  const { error } = await supabase
    .from('workspaces')
    .update({
      is_suspended: true,
      suspended_at: new Date().toISOString(),
      suspension_reason: suspensionReason,
    })
    .eq('id', workspaceId);

  if (error) {
    throw userError(`Failed to suspend company: ${error.message}`);
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'suspend_company',
    workspaceId,
    workspaceName: ws.name,
    details: { reason: suspensionReason },
  });

  return { success: true };
}

/**
 * Super Admin Action: Reactivate a suspended company workspace
 */
export async function reactivateCompanyAction(workspaceId: string) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data: ws, error: fetchErr } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('id', workspaceId)
    .single();

  if (fetchErr || !ws) {
    throw userError('Workspace not found.');
  }

  const { error } = await supabase
    .from('workspaces')
    .update({
      is_suspended: false,
      suspended_at: null,
      suspension_reason: null,
    })
    .eq('id', workspaceId);

  if (error) {
    throw userError(`Failed to reactivate company: ${error.message}`);
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'reactivate_company',
    workspaceId,
    workspaceName: ws.name,
    details: {},
  });

  return { success: true };
}

/**
 * Super Admin Action: Soft-delete a company workspace (retained for 30 days)
 */
export async function softDeleteCompanyAction(workspaceId: string) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data: ws, error: fetchErr } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('id', workspaceId)
    .single();

  if (fetchErr || !ws) {
    throw userError('Workspace not found.');
  }

  const { error } = await supabase
    .from('workspaces')
    .update({
      deleted_at: new Date().toISOString(),
      is_suspended: true,
      suspension_reason: 'Soft deleted (30-day recovery window)',
    })
    .eq('id', workspaceId);

  if (error) {
    throw userError(`Failed to delete company: ${error.message}`);
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'soft_delete_company',
    workspaceId,
    workspaceName: ws.name,
    details: { retention_days: 30 },
  });

  return { success: true };
}

/**
 * Super Admin Action: Restore a soft-deleted company workspace
 */
export async function restoreCompanyAction(workspaceId: string) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data: ws, error: fetchErr } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('id', workspaceId)
    .single();

  if (fetchErr || !ws) {
    throw userError('Workspace not found.');
  }

  const { error } = await supabase
    .from('workspaces')
    .update({
      deleted_at: null,
      is_suspended: false,
      suspension_reason: null,
    })
    .eq('id', workspaceId);

  if (error) {
    throw userError(`Failed to restore company: ${error.message}`);
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'restore_company',
    workspaceId,
    workspaceName: ws.name,
    details: {},
  });

  return { success: true };
}

/**
 * Super Admin Action: Assign or change company owner by email
 */
export async function assignWorkspaceOwnerAction(workspaceId: string, ownerEmail: string) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  if (!ownerEmail || !ownerEmail.trim()) {
    throw userError('Owner email is required.');
  }

  const { data: ws, error: fetchErr } = await supabase
    .from('workspaces')
    .select('id, name, owner_id')
    .eq('id', workspaceId)
    .single();

  if (fetchErr || !ws) {
    throw userError('Workspace not found.');
  }

  const normalizedEmail = ownerEmail.trim().toLowerCase();
  const owner = await findOrCreateOwnerAgent(normalizedEmail, workspaceId, ws.name + ' Owner');

  const { error: updateErr } = await supabase
    .from('workspaces')
    .update({ owner_id: owner.id })
    .eq('id', workspaceId);

  if (updateErr) {
    throw userError(`Failed to update workspace owner: ${updateErr.message}`);
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'assign_workspace_owner',
    workspaceId,
    workspaceName: ws.name,
    details: {
      previous_owner_id: ws.owner_id,
      new_owner_id: owner.id,
      new_owner_email: normalizedEmail,
    },
  });

  return { success: true, owner_email: normalizedEmail, owner_id: owner.id };
}

/**
 * Super Admin Action: Edit company name, domain, plan and limits
 */
export async function updateCompanySettingsAction(
  workspaceId: string,
  data: {
    name: string;
    website_url?: string | null;
    plan: string;
    plan_limits: CompanyPlanLimits;
  }
) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  if (!data.name?.trim()) {
    throw userError('Company name is required.');
  }

  const { data: ws, error: fetchErr } = await supabase
    .from('workspaces')
    .select('id, name, plan, plan_limits')
    .eq('id', workspaceId)
    .single();

  if (fetchErr || !ws) {
    throw userError('Workspace not found.');
  }

  const updatePayload = {
    name: data.name.trim(),
    website_url: data.website_url ? data.website_url.trim() : null,
    plan: data.plan || 'free',
    plan_limits: {
      max_seats: Math.max(1, Number(data.plan_limits?.max_seats || 5)),
      max_monthly_conversations: Math.max(0, Number(data.plan_limits?.max_monthly_conversations || 1000)),
      max_ai_replies: Math.max(0, Number(data.plan_limits?.max_ai_replies || 500)),
    },
  };

  const { data: updated, error: updateErr } = await supabase
    .from('workspaces')
    .update(updatePayload)
    .eq('id', workspaceId)
    .select()
    .single();

  if (updateErr) {
    throw userError(`Failed to update company settings: ${updateErr.message}`);
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'update_company_settings',
    workspaceId,
    workspaceName: updated.name,
    details: {
      previous_plan: ws.plan,
      new_plan: updated.plan,
      plan_limits: updated.plan_limits,
    },
  });

  return { success: true, workspace: updated as Workspace };
}

/**
 * Super Admin Action: Merge two duplicate workspaces
 */
export async function mergeWorkspacesAction(params: {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
}) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  if (params.sourceWorkspaceId === params.targetWorkspaceId) {
    throw userError('Cannot merge a workspace into itself.');
  }

  const [{ data: sourceWs }, { data: targetWs }] = await Promise.all([
    supabase.from('workspaces').select('id, name').eq('id', params.sourceWorkspaceId).maybeSingle(),
    supabase.from('workspaces').select('id, name').eq('id', params.targetWorkspaceId).maybeSingle(),
  ]);

  if (!sourceWs) throw userError('Source workspace not found.');
  if (!targetWs) throw userError('Target workspace not found.');

  const { data: result, error } = await supabase.rpc('fn_merge_workspaces', {
    p_source_id: params.sourceWorkspaceId,
    p_target_id: params.targetWorkspaceId,
  });

  if (error) {
    throw userError(`Failed to merge workspaces: ${error.message}`);
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'merge_workspaces',
    workspaceId: params.targetWorkspaceId,
    workspaceName: targetWs.name,
    details: {
      source_workspace_id: params.sourceWorkspaceId,
      source_workspace_name: sourceWs.name,
      target_workspace_id: params.targetWorkspaceId,
      target_workspace_name: targetWs.name,
      merge_stats: result,
    },
  });

  return {
    success: true,
    result,
  };
}

/**
 * Super Admin Action: Switch into another company's workspace
 * Writes an audit log record and stores viewing state in an HTTP-only cookie.
 */
export async function switchWorkspaceAction(params: {
  workspaceId: string;
  workspaceName?: string;
}) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data: workspace, error } = await supabase
    .from('workspaces')
    .select('*')
    .eq('id', params.workspaceId)
    .single();

  if (error || !workspace) {
    throw userError('Workspace not found or inaccessible.');
  }

  // Record audit log
  await recordSuperAdminAudit({
    admin: agent,
    action: 'switch_workspace',
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    details: {
      previous_workspace_id: agent.workspace_id || null,
      switched_at: new Date().toISOString(),
    },
  });

  // Set cookie for dashboard viewing
  const cookieStore = await cookies();
  cookieStore.set('super_admin_viewing_workspace_id', workspace.id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24, // 24 hours
  });

  return {
    success: true,
    workspace: workspace as Workspace,
  };
}

/**
 * Super Admin Action: Exit viewing another workspace and revert to native view
 */
export async function exitSuperAdminWorkspaceViewAction() {
  const { agent } = await assertSuperAdmin();
  const cookieStore = await cookies();
  const prevViewingId = cookieStore.get('super_admin_viewing_workspace_id')?.value;

  cookieStore.delete('super_admin_viewing_workspace_id');

  if (prevViewingId) {
    await recordSuperAdminAudit({
      admin: agent,
      action: 'exit_switched_workspace',
      workspaceId: prevViewingId,
      details: {
        exited_at: new Date().toISOString(),
      },
    });
  }

  return { success: true };
}

/**
 * Super Admin Action: Get super admin audit logs
 */
export async function getSuperAdminAuditLogsAction(options: {
  limit?: number;
  offset?: number;
  actionFilter?: string;
} = {}): Promise<{ logs: SuperAdminAuditLog[]; totalCount: number }> {
  await assertSuperAdmin();
  const supabase = await createClient();

  const limit = options.limit || 50;
  const offset = options.offset || 0;

  let query = supabase
    .from('super_admin_audit_logs')
    .select('*', { count: 'exact' });

  if (options.actionFilter && options.actionFilter !== 'all') {
    query = query.eq('action', options.actionFilter);
  }

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw userError(`Failed to load super admin audit logs: ${error.message}`);
  }

  return {
    logs: (data || []) as SuperAdminAuditLog[],
    totalCount: count || 0,
  };
}

/**
 * Super Admin Action: Get master platform settings (ZenTry platform email & config)
 */
export async function getPlatformSettingsAction(): Promise<{
  platform_name: string;
  platform_url: string;
  support_email: string;
  smtp_settings: SMTPSettingsConfig | null;
}> {
  await assertSuperAdmin();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('platform_settings')
    .select('*')
    .eq('id', 'default')
    .maybeSingle();

  if (error) {
    throw userError(`Failed to load platform settings: ${error.message}`);
  }

  return {
    platform_name: data?.platform_name || 'ZenTry',
    platform_url: data?.platform_url || 'https://zen-try.site',
    support_email: data?.support_email || 'support@zen-try.site',
    smtp_settings: data?.smtp_settings || null,
  };
}

/**
 * Super Admin Action: Update master platform SMTP settings (ZenTry company email)
 */
export async function updatePlatformSMTPSettingsAction(smtp: SMTPSettingsConfig) {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const effectiveFrom = (smtp.from_email && isValidEmail(smtp.from_email))
    ? smtp.from_email.trim()
    : (smtp.user || '').trim();

  const normalizedConfig: SMTPSettingsConfig = {
    ...smtp,
    host: (smtp.host || 'smtp.hostinger.com').trim(),
    port: Number(smtp.port) || 465,
    user: (smtp.user || '').trim(),
    pass: smtp.pass,
    from_name: (smtp.from_name || 'ZenTry').trim(),
    from_email: effectiveFrom,
    secure: Number(smtp.port) === 465,
  };

  const { error } = await supabase
    .from('platform_settings')
    .upsert({
      id: 'default',
      platform_name: 'ZenTry',
      platform_url: 'https://zen-try.site',
      support_email: effectiveFrom || 'support@zen-try.site',
      smtp_settings: normalizedConfig,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

  if (error) {
    throw userError(`Failed to save platform SMTP settings: ${error.message}`);
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'update_platform_smtp',
    details: {
      host: normalizedConfig.host,
      port: normalizedConfig.port,
      user: normalizedConfig.user,
      from_name: normalizedConfig.from_name,
      from_email: normalizedConfig.from_email,
      enabled: normalizedConfig.enabled,
    },
  });

  return { success: true };
}

/**
 * Super Admin Action: Test master platform SMTP credentials and send real test email
 */
export async function testPlatformSMTPSettingsAction(
  config: SMTPSettingsConfig,
  sendTestTo?: string
): Promise<{ success: boolean; message?: string }> {
  await assertSuperAdmin();

  if (!config || !config.host || !config.port || !config.user || !config.pass) {
    return {
      success: false,
      message: 'Missing required SMTP fields (Host, Port, User, Password)',
    };
  }

  const effectiveFrom = (config.from_email && isValidEmail(config.from_email))
    ? config.from_email.trim()
    : config.user.trim();

  const normalizedConfig: SMTPSettingsConfig = {
    ...config,
    host: config.host.trim(),
    port: Number(config.port) || 465,
    user: config.user.trim(),
    pass: config.pass,
    from_name: (config.from_name || 'ZenTry Master').trim(),
    from_email: effectiveFrom,
    secure: Number(config.port) === 465,
  };

  const testResult = await testSmtpConnection(normalizedConfig);
  if (!testResult.success) {
    return {
      success: false,
      message: testResult.message || 'Could not connect to SMTP server',
    };
  }

  if (sendTestTo && isValidEmail(sendTestTo)) {
    const test = smtpTestEmail({
      brandName: normalizedConfig.from_name || 'Zen-try',
      host: normalizedConfig.host,
      port: Number(normalizedConfig.port),
      from: normalizedConfig.from_email,
      user: normalizedConfig.user,
    });
    const emailResult = await sendSmtpEmail(normalizedConfig, {
      to: sendTestTo.trim(),
      subject: test.subject,
      html: test.html,
      text: test.text,
    });

    if (!emailResult.success) {
      return {
        success: false,
        message: emailResult.error || 'Failed to send test email',
      };
    }
  }

  return { success: true, message: 'ZenTry platform SMTP connected and verified successfully!' };
}

/**
 * Super Admin Action: Re-sync custom domains with Vercel project (Requirement 7)
 * Calls addDomain for every custom domain saved in the database missing from Vercel project.
 */
export async function resyncCustomDomainsAction(): Promise<{
  success: boolean;
  total: number;
  synced: number;
  results: Array<{
    workspaceId: string;
    workspaceName: string;
    domain: string;
    status: string;
    error?: string;
  }>;
}> {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, name, custom_domain, custom_domain_status')
    .not('custom_domain', 'is', null)
    .neq('custom_domain', '');

  if (error || !workspaces) {
    throw userError(`Failed to load custom domains: ${error?.message}`);
  }

  const results: Array<{
    workspaceId: string;
    workspaceName: string;
    domain: string;
    status: string;
    error?: string;
  }> = [];

  let synced = 0;

  for (const ws of workspaces) {
    if (!ws.custom_domain) continue;
    const domain = cleanDomain(ws.custom_domain);
    if (!domain) continue;

    try {
      const vercelRes = await addDomain(domain);
      synced++;
      results.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        domain,
        status: vercelRes.alreadyExists ? 'already_attached' : 'added',
      });
    } catch (err: any) {
      results.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        domain,
        status: 'error',
        error: err.message || 'Failed to add domain to Vercel',
      });
    }
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'resync_domains_with_vercel',
    details: {
      total: workspaces.length,
      synced,
      results,
    },
  });

  return {
    success: true,
    total: workspaces.length,
    synced,
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   POLISHED SUPER ADMIN SUITE ACTIONS (PHASE 2)
   Strictly guarded with assertSuperAdmin() and audit logged.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 1. Overview Key Numbers & Trends
 */
export async function getPlatformOverviewMetricsAction(): Promise<PlatformOverviewMetrics> {
  const { agent } = await assertSuperAdmin();
  const supabase = await createClient();

  // Try RPC first
  try {
    const { data: rpcData, error: rpcError } = await supabase.rpc('fn_get_platform_overview_metrics');
    if (!rpcError && rpcData && typeof rpcData === 'object' && 'total_workspaces' in rpcData) {
      return rpcData as PlatformOverviewMetrics;
    }
  } catch {
    // Fallback below
  }

  // Graceful fallback querying service role directly
  const adminClient = serviceClient();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    { count: totalWorkspaces },
    { count: activeWorkspaces },
    { count: suspendedWorkspaces },
    { count: totalAgents },
    { count: activeAgents },
    { count: ticketsToday },
    { count: ticketsMonth },
    { count: totalMessages },
    { data: newestWorkspacesData },
    { data: recentTickets },
    { data: suspendedList },
    { data: failedQueue },
  ] = await Promise.all([
    adminClient.from('workspaces').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    adminClient.from('workspaces').select('id', { count: 'exact', head: true }).is('deleted_at', null).or('is_suspended.is.null,is_suspended.eq.false'),
    adminClient.from('workspaces').select('id', { count: 'exact', head: true }).is('deleted_at', null).eq('is_suspended', true),
    adminClient.from('agents').select('id', { count: 'exact', head: true }),
    adminClient.from('agents').select('id', { count: 'exact', head: true }).or('is_active.is.null,is_active.eq.true').in('status', ['online', 'away']),
    adminClient.from('tickets').select('id', { count: 'exact', head: true }).gte('created_at', startOfDay.toISOString()),
    adminClient.from('tickets').select('id', { count: 'exact', head: true }).gte('created_at', startOfMonth.toISOString()),
    // An exact count scans the whole (largest) table on every page view.
    adminClient.from('messages').select('id', { count: 'estimated', head: true }),
    adminClient.from('workspaces').select('id, name, brand_color, created_at, is_suspended, plan, owner_id').is('deleted_at', null).order('created_at', { ascending: false }).limit(5),
    adminClient.from('tickets').select('created_at, status').gte('created_at', thirtyDaysAgo.toISOString()),
    adminClient.from('workspaces').select('id, name, suspended_at').is('deleted_at', null).eq('is_suspended', true).limit(5),
    adminClient.from('channel_outbound_queue').select('id, workspace_id, channel, created_at').or('status.eq.failed,attempts.gte.3').order('created_at', { ascending: false }).limit(5),
  ]);

  // Compute bot resolution rate if conversations table has autopilot rows
  let botResolutionRate: number | null = null;
  let botResolvedCount = 0;
  let botHandoverCount = 0;
  try {
    // Two counts, not every autopilot conversation on the platform.
    const [resolved, handedOver] = await Promise.all([
      adminClient.from('conversations').select('id', { count: 'exact', head: true }).eq('ai_mode', 'autopilot').in('status', ['closed', 'solved']),
      adminClient.from('conversations').select('id', { count: 'exact', head: true }).eq('ai_mode', 'autopilot').not('assigned_agent_id', 'is', null),
    ]);
    botResolvedCount = resolved.count ?? 0;
    botHandoverCount = handedOver.count ?? 0;
    {
      if (botResolvedCount + botHandoverCount > 0) {
        botResolutionRate = Math.round((botResolvedCount / (botResolvedCount + botHandoverCount)) * 100);
      }
    }
  } catch {
    // leave as null ("Not available yet")
  }

  // 30-day ticket daily trend
  const trendMap = new Map<string, { created: number; solved: number }>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    trendMap.set(key, { created: 0, solved: 0 });
  }

  for (const t of recentTickets || []) {
    const key = t.created_at ? t.created_at.slice(0, 10) : '';
    if (trendMap.has(key)) {
      const entry = trendMap.get(key)!;
      entry.created++;
      if (t.status === 'solved' || t.status === 'closed') {
        entry.solved++;
      }
    }
  }

  const trendTickets = Array.from(trendMap.entries()).map(([date, counts]) => {
    const d = new Date(date + 'T00:00:00Z');
    const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return {
      date,
      formatted_date: formatted,
      created: counts.created,
      solved: counts.solved,
    };
  });

  // Owner emails for newest workspaces
  const ownerIds = (newestWorkspacesData || []).map((w) => w.owner_id).filter(Boolean);
  const ownerEmailMap = new Map<string, string>();
  if (ownerIds.length > 0) {
    try {
      const { data: users } = await adminClient.from('agents').select('id, email').in('id', ownerIds);
      for (const u of users || []) {
        if (u.email) ownerEmailMap.set(u.id, u.email);
      }
    } catch {}
  }

  const newestWorkspaces = (newestWorkspacesData || []).map((w) => ({
    id: w.id,
    name: w.name,
    brand_color: w.brand_color || '#2563eb',
    created_at: w.created_at,
    is_suspended: !!w.is_suspended,
    plan: w.plan || 'free',
    owner_email: ownerEmailMap.get(w.owner_id) || null,
  }));

  // Build alerts
  const alerts: PlatformOverviewMetrics['alerts'] = [];
  for (const s of suspendedList || []) {
    alerts.push({
      alert_type: 'workspace_suspended',
      severity: 'high',
      message: `Workspace "${s.name}" is suspended`,
      workspace_id: s.id,
      workspace_name: s.name,
      created_at: s.suspended_at || new Date().toISOString(),
    });
  }
  for (const q of failedQueue || []) {
    alerts.push({
      alert_type: 'channel_error',
      severity: 'medium',
      message: `Outbound queue failure on channel: ${q.channel}`,
      workspace_id: q.workspace_id,
      workspace_name: 'Workspace ' + q.workspace_id.slice(0, 8),
      created_at: q.created_at,
    });
  }

  return {
    total_workspaces: totalWorkspaces ?? 0,
    active_workspaces: activeWorkspaces ?? 0,
    suspended_workspaces: suspendedWorkspaces ?? 0,
    total_agents: totalAgents ?? 0,
    active_agents: activeAgents ?? 0,
    tickets_today: ticketsToday ?? 0,
    tickets_this_month: ticketsMonth ?? 0,
    total_messages: totalMessages ?? 0,
    bot_resolution_rate: botResolutionRate,
    bot_resolved_count: botResolvedCount,
    bot_handover_count: botHandoverCount,
    trend_tickets: trendTickets,
    newest_workspaces: newestWorkspaces,
    alerts,
  };
}

/**
 * 2. Workspaces Table with Search, Filter, Sort & Pagination
 */
export interface PlatformWorkspacesQuery {
  search?: string;
  status?: 'all' | 'active' | 'suspended';
  channel?: string;
  plan?: string;
  sort?: 'name' | 'created_at' | 'tickets_30d_count' | 'agents_count' | 'last_activity_at';
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface PlatformWorkspacesResponse {
  workspaces: PlatformWorkspaceItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function getPlatformWorkspacesTableAction(
  query: PlatformWorkspacesQuery = {}
): Promise<PlatformWorkspacesResponse> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const {
    search = '',
    status = 'all',
    channel = 'all',
    plan = 'all',
    sort = 'created_at',
    order = 'desc',
    page = 1,
    pageSize = 15,
  } = query;

  // Filter, sort, count and page in the database (fn_admin_workspaces_table,
  // migration 20261104090000). The in-memory version below stays as the
  // fallback until that migration has run.
  const size = Math.min(Math.max(1, pageSize), 200);
  const wanted = Math.max(1, page);
  const { data: rows, error: rpcError } = await adminClient.rpc('fn_admin_workspaces_table', {
    p_search: search,
    p_status: status,
    p_plan: plan,
    p_channel: channel,
    p_sort: sort,
    p_order: order,
    p_limit: size,
    p_offset: (wanted - 1) * size,
  });
  if (!rpcError && Array.isArray(rows)) {
    type Row = {
      id: string; name: string; website_url: string | null; is_suspended: boolean; suspended_at: string | null;
      suspension_reason: string | null; deleted_at: string | null; plan: string; brand_color: string; logo_url: string | null;
      owner_email: string | null; agents_count: number; tickets_30d_count: number; connected_channels: string[] | null;
      last_activity_at: string; created_at: string; total_count: number;
    };
    const list = rows as Row[];
    const totalCount = Number(list[0]?.total_count ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalCount / size));
    if (list.length === 0 && wanted > totalPages && totalCount > 0) {
      return getPlatformWorkspacesTableAction({ ...query, page: totalPages });
    }
    return {
      workspaces: list.map((w) => {
        const channels = [...(w.connected_channels || [])];
        if (!channels.includes('chat')) channels.push('chat');
        return {
          id: w.id,
          name: w.name,
          website_url: w.website_url,
          status: w.is_suspended ? 'suspended' : 'active',
          is_suspended: w.is_suspended,
          suspended_at: w.suspended_at,
          suspension_reason: w.suspension_reason,
          deleted_at: w.deleted_at,
          plan: w.plan,
          brand_color: w.brand_color,
          logo_url: w.logo_url,
          agents_count: w.agents_count,
          tickets_30d_count: w.tickets_30d_count,
          connected_channels: channels,
          last_activity_at: w.last_activity_at,
          created_at: w.created_at,
          owner_email: w.owner_email,
        } as PlatformWorkspaceItem;
      }),
      totalCount,
      page: Math.min(wanted, totalPages),
      pageSize: size,
      totalPages,
    };
  }
  if (rpcError) console.warn('[Admin] fn_admin_workspaces_table unavailable, using the in-memory fallback:', rpcError.message);

  // Fetch all workspaces and join stats
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [
    { data: workspacesRaw },
    { data: ticketsRaw },
    { data: agentsRaw },
    { data: channelConns },
  ] = await Promise.all([
    adminClient.from('workspaces').select('*').is('deleted_at', null),
    adminClient.from('tickets').select('workspace_id, created_at').gte('created_at', thirtyDaysAgo),
    adminClient.from('agents').select('id, workspace_id, email, is_active'),
    adminClient.from('channel_connections').select('workspace_id, channel, status').neq('status', 'disconnected'),
  ]);

  const ticketCounts = new Map<string, number>();
  for (const t of ticketsRaw || []) {
    if (t.workspace_id) ticketCounts.set(t.workspace_id, (ticketCounts.get(t.workspace_id) || 0) + 1);
  }

  const agentCounts = new Map<string, number>();
  const ownerMap = new Map<string, string>();
  for (const a of agentsRaw || []) {
    if (a.workspace_id) {
      agentCounts.set(a.workspace_id, (agentCounts.get(a.workspace_id) || 0) + 1);
    }
    if (a.email) {
      ownerMap.set(a.id, a.email);
    }
  }

  const channelMap = new Map<string, Set<string>>();
  for (const c of channelConns || []) {
    if (c.workspace_id) {
      if (!channelMap.has(c.workspace_id)) channelMap.set(c.workspace_id, new Set());
      channelMap.get(c.workspace_id)!.add(c.channel);
    }
  }

  let items: PlatformWorkspaceItem[] = (workspacesRaw || []).map((w) => {
    const channels = Array.from(channelMap.get(w.id) || []);
    if (!channels.includes('chat')) channels.push('chat');

    return {
      id: w.id,
      name: w.name,
      website_url: w.website_url || null,
      status: w.is_suspended ? 'suspended' : 'active',
      is_suspended: !!w.is_suspended,
      suspended_at: w.suspended_at || null,
      suspension_reason: w.suspension_reason || null,
      deleted_at: w.deleted_at || null,
      plan: w.plan || 'free',
      brand_color: w.brand_color || '#2563eb',
      logo_url: w.logo_url || null,
      agents_count: agentCounts.get(w.id) ?? 0,
      tickets_30d_count: ticketCounts.get(w.id) ?? 0,
      connected_channels: channels,
      last_activity_at: w.updated_at || w.created_at,
      created_at: w.created_at,
      owner_email: ownerMap.get(w.owner_id) || null,
    };
  });

  // Filter
  if (search.trim()) {
    const q = search.toLowerCase().trim();
    items = items.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        (w.website_url && w.website_url.toLowerCase().includes(q)) ||
        (w.owner_email && w.owner_email.toLowerCase().includes(q)) ||
        w.id.toLowerCase().includes(q)
    );
  }

  if (status !== 'all') {
    items = items.filter((w) => w.status === status);
  }

  if (plan !== 'all') {
    items = items.filter((w) => w.plan.toLowerCase() === plan.toLowerCase());
  }

  if (channel !== 'all') {
    items = items.filter((w) => w.connected_channels.includes(channel));
  }

  // Sort
  items.sort((a, b) => {
    let cmp = 0;
    if (sort === 'name') cmp = a.name.localeCompare(b.name);
    else if (sort === 'tickets_30d_count') cmp = a.tickets_30d_count - b.tickets_30d_count;
    else if (sort === 'agents_count') cmp = a.agents_count - b.agents_count;
    else if (sort === 'last_activity_at') cmp = (a.last_activity_at || '').localeCompare(b.last_activity_at || '');
    else cmp = a.created_at.localeCompare(b.created_at);

    return order === 'asc' ? cmp : -cmp;
  });

  const totalCount = items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const paginated = items.slice(startIdx, startIdx + pageSize);

  return {
    workspaces: paginated,
    totalCount,
    page: currentPage,
    pageSize,
    totalPages,
  };
}

/**
 * 3. Workspace Detail Action with Tabs Support & Notes
 */
export interface PolishedWorkspaceDetailData {
  workspace: PlatformWorkspaceItem;
  metrics: {
    tickets_30d_count: number;
    total_tickets: number;
    agents_count: number;
    avg_first_reply_seconds: number | null;
    resolution_rate_percent: number;
    bot_resolved_count: number;
    bot_handover_count: number;
  };
  tickets_per_day: Array<{
    date: string;
    formatted_date: string;
    tickets: number;
    solved: number;
  }>;
  top_articles: Array<{
    id: string;
    title: string;
    slug: string;
    views_count: number;
    helpful_count: number;
  }>;
  members: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    avatar_url: string | null;
    created_at: string;
    is_active: boolean;
    max_open_tickets: number | null;
  }>;
  channels: Array<{
    channel: string;
    status: 'connected' | 'error' | 'disconnected';
    details: string;
  }>;
  usage: {
    conversations_count: number;
    messages_count: number;
    articles_count: number;
    visitors_count: number;
  };
  recent_activity: Array<{
    id: string;
    type: 'ticket' | 'message';
    title: string;
    created_at: string;
    status: string;
  }>;
  notes: SuperAdminWorkspaceNote[];
}

export async function getPlatformWorkspaceDetailAction(
  workspaceId: string
): Promise<PolishedWorkspaceDetailData> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  const [
    { data: ws, error: wsError },
    { data: agents },
    { data: tickets },
    { data: articles },
    { data: convs },
    { data: channelConns },
  ] = await Promise.all([
    adminClient.from('workspaces').select('*').eq('id', workspaceId).maybeSingle(),
    adminClient.from('agents').select('*').eq('workspace_id', workspaceId).order('name'),
    adminClient.from('tickets').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(200),
    adminClient.from('articles').select('*').eq('workspace_id', workspaceId).order('views_count', { ascending: false }).limit(10),
    adminClient.from('conversations').select('id, status, ai_mode, assigned_agent_id, created_at').eq('workspace_id', workspaceId).limit(200),
    adminClient.from('channel_connections').select('*').eq('workspace_id', workspaceId),
  ]);

  if (wsError || !ws) {
    throw userError('Workspace not found or inaccessible.');
  }

  // Owner email
  let ownerEmail: string | null = null;
  if (ws.owner_id) {
    const ownerAgent = (agents || []).find((a) => a.id === ws.owner_id);
    ownerEmail = ownerAgent?.email || null;
  }

  // Tickets trend (30d)
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const trendMap = new Map<string, { tickets: number; solved: number }>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    trendMap.set(d.toISOString().slice(0, 10), { tickets: 0, solved: 0 });
  }

  let tickets30dCount = 0;
  let solvedTicketsCount = 0;
  for (const t of tickets || []) {
    const createdTime = new Date(t.created_at).getTime();
    if (createdTime >= thirtyDaysAgo) {
      tickets30dCount++;
      const key = t.created_at.slice(0, 10);
      if (trendMap.has(key)) {
        trendMap.get(key)!.tickets++;
        if (t.status === 'solved' || t.status === 'closed') {
          trendMap.get(key)!.solved++;
        }
      }
    }
    if (t.status === 'solved' || t.status === 'closed') {
      solvedTicketsCount++;
    }
  }

  const ticketsPerDay = Array.from(trendMap.entries()).map(([date, counts]) => {
    const d = new Date(date + 'T00:00:00Z');
    return {
      date,
      formatted_date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      tickets: counts.tickets,
      solved: counts.solved,
    };
  });

  const totalTickets = tickets?.length || 0;
  const resolutionRatePercent = totalTickets > 0 ? Math.round((solvedTicketsCount / totalTickets) * 100) : 0;

  // Bot resolution stats
  let botResolved = 0;
  let botHandover = 0;
  for (const c of convs || []) {
    if (c.ai_mode === 'autopilot') {
      if (c.status === 'closed' || c.status === 'solved') botResolved++;
      if (c.assigned_agent_id) botHandover++;
    }
  }

  // Channels
  const channelsList: PolishedWorkspaceDetailData['channels'] = [
    {
      channel: 'Web Chat Widget',
      status: 'connected',
      details: 'Embedded customer chat widget active',
    },
  ];
  for (const c of channelConns || []) {
    channelsList.push({
      channel: c.channel,
      status: c.status === 'connected' ? 'connected' : 'error',
      details: `Provider connection: ${c.channel}`,
    });
  }

  // Recent activity
  const recentActivity: PolishedWorkspaceDetailData['recent_activity'] = (tickets || []).slice(0, 10).map((t) => ({
    id: t.id,
    type: 'ticket',
    title: t.subject || `Ticket #${t.number || t.id.slice(0, 6)}`,
    created_at: t.created_at,
    status: t.status,
  }));

  // Notes
  let notes: SuperAdminWorkspaceNote[] = [];
  try {
    const { data: notesData } = await adminClient
      .from('super_admin_workspace_notes')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });
    notes = (notesData as SuperAdminWorkspaceNote[]) || [];
  } catch {
    // Table not migrated yet; gracefully empty
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'view_workspace_detail',
    workspaceId: ws.id,
    workspaceName: ws.name,
  });

  return {
    workspace: {
      id: ws.id,
      name: ws.name,
      website_url: ws.website_url || null,
      status: ws.is_suspended ? 'suspended' : 'active',
      is_suspended: !!ws.is_suspended,
      suspended_at: ws.suspended_at || null,
      suspension_reason: ws.suspension_reason || null,
      deleted_at: ws.deleted_at || null,
      plan: ws.plan || 'free',
      brand_color: ws.brand_color || '#2563eb',
      logo_url: ws.logo_url || null,
      agents_count: agents?.length || 0,
      tickets_30d_count: tickets30dCount,
      connected_channels: channelsList.map((c) => c.channel),
      last_activity_at: ws.updated_at || ws.created_at,
      created_at: ws.created_at,
      owner_email: ownerEmail,
    },
    metrics: {
      tickets_30d_count: tickets30dCount,
      total_tickets: totalTickets,
      agents_count: agents?.length || 0,
      avg_first_reply_seconds: null,
      resolution_rate_percent: resolutionRatePercent,
      bot_resolved_count: botResolved,
      bot_handover_count: botHandover,
    },
    tickets_per_day: ticketsPerDay,
    top_articles: (articles || []).map((a) => ({
      id: a.id,
      title: a.title,
      slug: a.slug || a.id,
      views_count: a.views_count || 0,
      helpful_count: a.helpful_count || 0,
    })),
    members: (agents || []).map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      role: a.role,
      status: a.status,
      avatar_url: a.avatar_url || null,
      created_at: a.created_at,
      is_active: a.is_active ?? true,
      max_open_tickets: a.max_open_tickets ?? null,
    })),
    channels: channelsList,
    usage: {
      conversations_count: convs?.length || 0,
      messages_count: 0,
      articles_count: articles?.length || 0,
      visitors_count: 0,
    },
    recent_activity: recentActivity,
    notes,
  };
}

/**
 * 4. Workspace Notes CRUD (Platform Owner Private Notes)
 */
export async function getWorkspaceNotesAction(workspaceId: string): Promise<SuperAdminWorkspaceNote[]> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data, error } = await adminClient
      .from('super_admin_workspace_notes')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });

    if (error) return [];
    return (data as SuperAdminWorkspaceNote[]) || [];
  } catch {
    return [];
  }
}

export async function saveWorkspaceNotesAction(
  workspaceId: string,
  content: string
): Promise<{ success: boolean; note?: SuperAdminWorkspaceNote; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  if (!content.trim()) {
    return { success: false, error: 'Note content cannot be empty.' };
  }

  try {
    const { data, error } = await adminClient
      .from('super_admin_workspace_notes')
      .insert({
        workspace_id: workspaceId,
        admin_id: agent.id,
        admin_email: agent.email,
        content: content.trim(),
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    await recordSuperAdminAudit({
      admin: agent,
      action: 'add_workspace_note',
      workspaceId,
      details: { length: content.length },
    });

    return { success: true, note: data as SuperAdminWorkspaceNote };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to save note.' };
  }
}

/**
 * 5. Users Section Action (All users across workspaces)
 */
export interface PlatformUsersQuery {
  search?: string;
  role?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export async function getPlatformUsersAction(query: PlatformUsersQuery = {}): Promise<{
  users: PlatformUserItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { search = '', role = 'all', status = 'all', page = 1, pageSize = 20 } = query;

  const [{ data: agentsRaw }, { data: workspacesRaw }] = await Promise.all([
    adminClient.from('agents').select('*').order('created_at', { ascending: false }),
    adminClient.from('workspaces').select('id, name'),
  ]);

  const wsNameMap = new Map<string, string>();
  for (const w of workspacesRaw || []) {
    wsNameMap.set(w.id, w.name);
  }

  let users: PlatformUserItem[] = (agentsRaw || []).map((a) => ({
    id: a.id,
    name: a.name || 'Unnamed Agent',
    email: a.email || 'No email',
    role: a.role || 'agent',
    status: a.status || 'offline',
    is_active: a.is_active ?? true,
    is_super_admin: !!a.is_super_admin,
    is_platform_owner: !!a.is_platform_owner,
    workspace_id: a.workspace_id || null,
    workspace_name: a.workspace_id ? wsNameMap.get(a.workspace_id) || 'Unknown Workspace' : 'None',
    created_at: a.created_at,
  }));

  if (search.trim()) {
    const q = search.toLowerCase().trim();
    users = users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.workspace_name && u.workspace_name.toLowerCase().includes(q))
    );
  }

  if (role !== 'all') {
    users = users.filter((u) => u.role.toLowerCase() === role.toLowerCase());
  }

  if (status !== 'all') {
    if (status === 'active') users = users.filter((u) => u.is_active);
    else if (status === 'deactivated') users = users.filter((u) => !u.is_active);
    else users = users.filter((u) => u.status.toLowerCase() === status.toLowerCase());
  }

  const totalCount = users.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const paginated = users.slice(startIdx, startIdx + pageSize);

  return {
    users: paginated,
    totalCount,
    page: currentPage,
    pageSize,
    totalPages,
  };
}

export async function deactivateUserAction(userId: string): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  if (userId === agent.id) {
    return { success: false, error: 'Cannot deactivate your own platform super admin account.' };
  }

  try {
    const { error } = await adminClient
      .from('agents')
      .update({ is_active: false, deactivated_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) throw error;

    await recordSuperAdminAudit({
      admin: agent,
      action: 'deactivate_user',
      details: { target_user_id: userId },
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to deactivate user.' };
  }
}

export async function reactivateUserAction(userId: string): Promise<{ success: boolean; error?: string }> {
  const { agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { error } = await adminClient
      .from('agents')
      .update({ is_active: true, deactivated_at: null })
      .eq('id', userId);

    if (error) throw error;

    await recordSuperAdminAudit({
      admin: agent,
      action: 'reactivate_user',
      details: { target_user_id: userId },
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to reactivate user.' };
  }
}

/**
 * 6. System Health Monitoring Action
 */
export async function getPlatformSystemHealthAction(): Promise<SystemHealthReport> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const [
    { data: workspaces },
    { data: failedChannels },
    { data: failedAutomation },
    { data: pendingVerifications },
  ] = await Promise.all([
    adminClient.from('workspaces').select('id, name'),
    adminClient.from('channel_outbound_queue').select('*').or('status.eq.failed,attempts.gte.3').order('created_at', { ascending: false }).limit(50),
    adminClient.from('automation_outbox').select('*').eq('status', 'failed').order('created_at', { ascending: false }).limit(50),
    adminClient.from('channel_connections').select('*').eq('channel', 'email').neq('status', 'connected').order('created_at', { ascending: false }).limit(50),
  ]);

  const wsMap = new Map<string, string>();
  for (const w of workspaces || []) {
    wsMap.set(w.id, w.name);
  }

  const channelFailures = (failedChannels || []).map((q) => ({
    id: q.id,
    workspace_id: q.workspace_id,
    workspace_name: wsMap.get(q.workspace_id) || 'Unknown Workspace',
    channel: q.channel,
    error: q.error || 'Outbound dispatch failed',
    attempts: q.attempts || 1,
    created_at: q.created_at,
  }));

  const backgroundErrors = (failedAutomation || []).map((a) => ({
    id: a.id,
    workspace_id: a.workspace_id,
    workspace_name: wsMap.get(a.workspace_id) || 'Unknown Workspace',
    action_type: a.action_type || 'automation',
    status: a.status || 'failed',
    error: a.error || 'Job failed',
    created_at: a.created_at,
  }));

  const emailIssues = (pendingVerifications || []).map((e) => ({
    id: e.id,
    workspace_id: e.workspace_id,
    workspace_name: wsMap.get(e.workspace_id) || 'Unknown Workspace',
    error_type: (e as { last_error?: string | null }).last_error || 'Pending verification',
    created_at: e.created_at,
  }));

  return {
    channel_failures: channelFailures,
    email_issues: emailIssues,
    background_errors: backgroundErrors,
    checked_at: new Date().toISOString(),
  };
}

/**
 * 7. Global Search Action across Workspaces and Users
 */
export async function getPlatformGlobalSearchAction(query: string): Promise<{
  workspaces: Array<{ id: string; name: string; brand_color: string; plan: string; status: string }>;
  users: Array<{ id: string; name: string; email: string; role: string; workspace_name: string | null }>;
}> {
  await assertSuperAdmin();
  if (!query || query.trim().length < 2) {
    return { workspaces: [], users: [] };
  }

  const adminClient = serviceClient();
  const q = query.toLowerCase().trim();

  const [{ data: wsData }, { data: agentsData }] = await Promise.all([
    adminClient.from('workspaces').select('id, name, brand_color, plan, is_suspended').is('deleted_at', null).ilike('name', `%${q}%`).limit(8),
    adminClient.from('agents').select('id, name, email, role, workspace_id').or(`name.ilike.%${q}%,email.ilike.%${q}%`).limit(8),
  ]);

  const workspaces = (wsData || []).map((w) => ({
    id: w.id,
    name: w.name,
    brand_color: w.brand_color || '#2563eb',
    plan: w.plan || 'free',
    status: w.is_suspended ? 'suspended' : 'active',
  }));

  const users = (agentsData || []).map((a) => ({
    id: a.id,
    name: a.name || 'Agent',
    email: a.email || '',
    role: a.role || 'agent',
    workspace_name: a.workspace_id ? 'Workspace ' + a.workspace_id.slice(0, 6) : null,
  }));

  return { workspaces, users };
}

/**
 * 8. Retrieves all people with platform admin access from platform_access table
 * Visible to the platform owner only.
 */
export async function getPlatformAccessListAction(): Promise<{
  success: boolean;
  error?: string;
  members: PlatformAccessMember[];
}> {
  try {
    await assertPlatformOwner();
    const adminClient = serviceClient();

    // Query platform_access table (the single source of truth)
    const { data: accessRows, error: accessErr } = await adminClient
      .from('platform_access')
      .select('*')
      .order('granted_at', { ascending: true });

    if (accessErr) {
      console.error('[PlatformAccess] Failed to fetch access list:', accessErr);
      return { success: false, error: accessErr.message, members: [] };
    }

    // Fetch user details from auth.admin.listUsers() and agents table
    const { data: listData } = await adminClient.auth.admin.listUsers();
    const authUsers = listData?.users || [];
    const authUsersMap = new Map<string, any>(authUsers.map((u) => [u.id, u]));

    const { data: agentsData } = await adminClient
      .from('agents')
      .select('id, name, email');
    const agentsMap = new Map<string, any>((agentsData || []).map((a) => [a.id, a]));

    const members: PlatformAccessMember[] = (accessRows || []).map((row: any) => {
      const authUser = authUsersMap.get(row.user_id);
      const agentUser = agentsMap.get(row.user_id);
      const granterAuth = row.granted_by ? authUsersMap.get(row.granted_by) : null;

      const email = authUser?.email || agentUser?.email || 'unknown@domain.com';
      const name = agentUser?.name || authUser?.user_metadata?.name || email.split('@')[0];
      const granted_by_email = granterAuth?.email || (row.granted_by === row.user_id ? email : null);

      return {
        id: row.id,
        user_id: row.user_id,
        email,
        name,
        role: row.role as PlatformAccessRole,
        granted_by: row.granted_by,
        granted_by_email,
        granted_at: row.granted_at,
      };
    });

    return { success: true, members };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Access denied.', members: [] };
  }
}

/**
 * Backwards compatibility alias for components/views
 */
export async function getPlatformSuperAdminsListAction(): Promise<{
  admins: Agent[];
  invitations: PlatformSuperAdminInvitation[];
  isCurrentCallerOwner: boolean;
}> {
  const { agent } = await assertSuperAdmin();
  const res = await getPlatformAccessListAction();
  const admins: Agent[] = (res.members || []).map((m) => ({
    id: m.user_id,
    name: m.name,
    email: m.email,
    avatar_url: null,
    role: 'owner',
    status: 'online',
    is_super_admin: true,
    is_platform_owner: m.role === 'owner',
    created_at: m.granted_at,
  }));

  return {
    admins,
    invitations: [],
    isCurrentCallerOwner: Boolean(agent.is_platform_owner),
  };
}

/**
 * Internal helper to dispatch system/admin notification emails using platform_settings
 */
async function dispatchPlatformNotificationEmail(options: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  try {
    const adminClient = serviceClient();
    const { data: settings } = await adminClient
      .from('platform_settings')
      .select('smtp_settings, platform_name')
      .eq('id', 'default')
      .maybeSingle();

    const smtp = settings?.smtp_settings as SMTPSettingsConfig | null | undefined;
    if (smtp && smtp.enabled && smtp.user && smtp.pass) {
      await sendSmtpEmail(smtp, {
        to: options.to,
        subject: options.subject,
        html: options.html,
      });
    } else {
      console.warn('[Platform Email] SMTP not configured/active in platform_settings. Email not sent to:', options.to);
    }
  } catch (err) {
    console.error('[Platform Email] Failed to send email to', options.to, err);
  }
}

/**
 * 9. Gives admin access or sends an invite link.
 * - If email has an existing Zentry account: grants access immediately and sends notification email.
 * - If no account exists: creates a pending invite in admin_invites and emails a secure invite link.
 */
export async function inviteOrGrantAdminAction(input: {
  email: string;
  role?: PlatformAccessRole;
}): Promise<{
  success: boolean;
  error?: string;
  grantedDirectly?: boolean;
  member?: PlatformAccessMember;
  invite?: AdminInviteItem;
}> {
  const { user: ownerUser, agent: ownerAgent } = await assertPlatformOwner();
  const normalizedEmail = (input.email || '').trim().toLowerCase();
  const targetRole: PlatformAccessRole = input.role === 'owner' ? 'owner' : 'admin';

  if (!isValidEmail(normalizedEmail)) {
    return { success: false, error: 'Please enter a valid email address.' };
  }

  const adminClient = serviceClient();

  // Find existing account in auth.users
  const existingAuthUser = await findAuthUserByEmail(adminClient, normalizedEmail);

  const { data: platformData } = await adminClient
    .from('platform_settings')
    .select('platform_name, platform_url')
    .eq('id', 'default')
    .maybeSingle();

  const origin = await getRequestOrigin();
  const appOrigin = origin || getPlatformOrigin() || platformData?.platform_url || 'https://zen-try.site';
  const platformName = platformData?.platform_name || 'ZenTry';

  // CASE A: User ALREADY HAS a Zentry account: grant admin access immediately
  if (existingAuthUser) {
    const { data: existingAccess } = await adminClient
      .from('platform_access')
      .select('*')
      .eq('user_id', existingAuthUser.id)
      .maybeSingle();

    if (existingAccess) {
      return {
        success: false,
        error: `"${normalizedEmail}" already has ${existingAccess.role} access to the platform.`,
      };
    }

    // Insert into platform_access table
    const { data: newRow, error: insertErr } = await adminClient
      .from('platform_access')
      .insert({
        user_id: existingAuthUser.id,
        role: targetRole,
        granted_by: ownerUser.id,
        granted_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (insertErr || !newRow) {
      console.error('[GrantAdminAccess] Insert error:', insertErr);
      return { success: false, error: insertErr?.message || 'Failed to grant admin access.' };
    }

    // Update public.agents table
    await adminClient
      .from('agents')
      .update({
        is_super_admin: true,
        is_platform_owner: targetRole === 'owner',
        platform_staff_role: targetRole === 'owner' ? 'owner' : 'support',
      })
      .eq('id', existingAuthUser.id);

    // Record audit log
    await recordSuperAdminAudit({
      admin: ownerAgent,
      action: 'platform_admin_access_granted',
      details: {
        granted_to_user_id: existingAuthUser.id,
        granted_to_email: normalizedEmail,
        role: targetRole,
      },
    });

    // Send notification email
    const emailHtml = generateAdminAccessGrantedEmailHtml({
      recipientEmail: normalizedEmail,
      role: targetRole,
      adminUrl: `${appOrigin}/admin`,
      ownerEmail: ownerUser.email,
      platformName,
    });
    await dispatchPlatformNotificationEmail({
      to: normalizedEmail,
      subject: `Admin access granted to ${platformName}`,
      html: emailHtml,
    });

    return {
      success: true,
      grantedDirectly: true,
      member: {
        id: newRow.id,
        user_id: existingAuthUser.id,
        email: normalizedEmail,
        name: existingAuthUser.user_metadata?.name || normalizedEmail.split('@')[0],
        role: targetRole,
        granted_by: ownerUser.id,
        granted_by_email: ownerUser.email,
        granted_at: newRow.granted_at,
      },
    };
  }

  // CASE B: User DOES NOT EXIST: create a pending invite and email secure link
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  // If there's an existing pending invite for this email, revoke it first
  await adminClient
    .from('admin_invites')
    .update({ status: 'revoked' })
    .eq('email', normalizedEmail)
    .eq('status', 'pending');

  const { data: inviteRow, error: inviteErr } = await adminClient
    .from('admin_invites')
    .insert({
      email: normalizedEmail,
      role: targetRole,
      token_hash: tokenHash,
      status: 'pending',
      invited_by: ownerUser.id,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (inviteErr || !inviteRow) {
    console.error('[InviteAdmin] Insert invite error:', inviteErr);
    return { success: false, error: inviteErr?.message || 'Failed to create admin invitation.' };
  }

  const inviteUrl = `${appOrigin}/admin/invite?token=${rawToken}`;

  // Record audit log
  await recordSuperAdminAudit({
    admin: ownerAgent,
    action: 'platform_admin_invite_sent',
    details: {
      invite_id: inviteRow.id,
      invited_email: normalizedEmail,
      role: targetRole,
      expires_at: expiresAt,
    },
  });

  // Send invitation email
  const inviteEmailHtml = generateAdminInviteEmailHtml({
    recipientEmail: normalizedEmail,
    role: targetRole,
    inviteUrl,
    ownerEmail: ownerUser.email,
    platformName,
  });
  await dispatchPlatformNotificationEmail({
    to: normalizedEmail,
    subject: `You're invited to ${platformName} Platform Admin`,
    html: inviteEmailHtml,
  });

  return {
    success: true,
    grantedDirectly: false,
    invite: {
      id: inviteRow.id,
      email: normalizedEmail,
      role: targetRole,
      status: 'pending',
      invited_by: ownerUser.id,
      invited_by_email: ownerUser.email,
      expires_at: expiresAt,
      accepted_at: null,
      created_at: inviteRow.created_at,
      invite_url: inviteUrl,
    },
  };
}

/**
 * Backwards-compatible wrapper for grantAdminAccessAction
 */
export async function grantAdminAccessAction(
  emailInput: string,
  roleInput?: PlatformAccessRole
): Promise<{
  success: boolean;
  error?: string;
  grantedDirectly?: boolean;
  member?: PlatformAccessMember;
  invite?: AdminInviteItem;
}> {
  return inviteOrGrantAdminAction({ email: emailInput, role: roleInput || 'admin' });
}

/**
 * Fetches all admin invites (pending, accepted, revoked, expired) for the platform owner
 */
export async function getAdminInvitesAction(): Promise<{
  success: boolean;
  error?: string;
  invites: AdminInviteItem[];
}> {
  try {
    await assertPlatformOwner();
    const adminClient = serviceClient();

    const { data: rawInvites, error: fetchErr } = await adminClient
      .from('admin_invites')
      .select('*')
      .order('created_at', { ascending: false });

    if (fetchErr) {
      console.error('[GetAdminInvites] Fetch error:', fetchErr);
      return { success: false, error: fetchErr.message, invites: [] };
    }

    const { data: listData } = await adminClient.auth.admin.listUsers();
    const usersMap = new Map((listData?.users || []).map((u) => [u.id, u.email]));

    const now = new Date();
    const expiredIds: string[] = [];

    const invites: AdminInviteItem[] = (rawInvites || []).map((inv: any) => {
      let status = inv.status;
      if (status === 'pending' && new Date(inv.expires_at) < now) {
        status = 'expired';
        expiredIds.push(inv.id);
      }
      return {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        status,
        invited_by: inv.invited_by,
        invited_by_email: usersMap.get(inv.invited_by) || null,
        expires_at: inv.expires_at,
        accepted_at: inv.accepted_at,
        created_at: inv.created_at,
      };
    });

    if (expiredIds.length > 0) {
      await adminClient
        .from('admin_invites')
        .update({ status: 'expired' })
        .in('id', expiredIds);
    }

    return { success: true, invites };
  } catch (err: any) {
    return { success: false, error: err.message || 'Access denied.', invites: [] };
  }
}

/**
 * Resends an existing admin invitation with a fresh 48-hour token
 */
export async function resendAdminInviteAction(inviteId: string): Promise<{
  success: boolean;
  error?: string;
  invite_url?: string;
}> {
  const { user: ownerUser, agent: ownerAgent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  const { data: invite, error: fetchErr } = await adminClient
    .from('admin_invites')
    .select('*')
    .eq('id', inviteId)
    .maybeSingle();

  if (fetchErr || !invite) {
    return { success: false, error: 'Invitation not found.' };
  }

  if (invite.status === 'accepted') {
    return { success: false, error: 'This invitation has already been accepted and cannot be resent.' };
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  const { error: updateErr } = await adminClient
    .from('admin_invites')
    .update({
      token_hash: tokenHash,
      status: 'pending',
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    })
    .eq('id', inviteId);

  if (updateErr) {
    return { success: false, error: updateErr.message || 'Failed to update invitation.' };
  }

  const { data: platformData } = await adminClient
    .from('platform_settings')
    .select('platform_name, platform_url')
    .eq('id', 'default')
    .maybeSingle();

  const origin = await getRequestOrigin();
  const appOrigin = origin || getPlatformOrigin() || platformData?.platform_url || 'https://zen-try.site';
  const platformName = platformData?.platform_name || 'ZenTry';
  const inviteUrl = `${appOrigin}/admin/invite?token=${rawToken}`;

  await recordSuperAdminAudit({
    admin: ownerAgent,
    action: 'platform_admin_invite_resent',
    details: {
      invite_id: invite.id,
      invited_email: invite.email,
      role: invite.role,
      expires_at: expiresAt,
    },
  });

  const inviteEmailHtml = generateAdminInviteEmailHtml({
    recipientEmail: invite.email,
    role: invite.role,
    inviteUrl,
    ownerEmail: ownerUser.email,
    platformName,
  });
  await dispatchPlatformNotificationEmail({
    to: invite.email,
    subject: `[Reminder] You're invited to ${platformName} Platform Admin`,
    html: inviteEmailHtml,
  });

  return { success: true, invite_url: inviteUrl };
}

/**
 * Revokes a pending admin invitation
 */
export async function revokeAdminInviteAction(inviteId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const { agent: ownerAgent } = await assertPlatformOwner();
  const adminClient = serviceClient();

  const { data: invite, error: fetchErr } = await adminClient
    .from('admin_invites')
    .select('*')
    .eq('id', inviteId)
    .maybeSingle();

  if (fetchErr || !invite) {
    return { success: false, error: 'Invitation not found.' };
  }

  if (invite.status === 'accepted') {
    return { success: false, error: 'Accepted invitations cannot be revoked.' };
  }

  const { error: updateErr } = await adminClient
    .from('admin_invites')
    .update({ status: 'revoked' })
    .eq('id', inviteId);

  if (updateErr) {
    return { success: false, error: updateErr.message };
  }

  await recordSuperAdminAudit({
    admin: ownerAgent,
    action: 'platform_admin_invite_revoked',
    details: {
      invite_id: invite.id,
      invited_email: invite.email,
    },
  });

  return { success: true };
}

/**
 * Validates an invite token (public server action for accept page)
 */
export async function validateAdminInviteTokenAction(rawToken: string): Promise<{
  valid: boolean;
  code?: 'invalid' | 'not_found' | 'revoked' | 'already_accepted' | 'expired';
  error?: string;
  email?: string;
  role?: PlatformAccessRole;
}> {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length < 16) {
    return {
      valid: false,
      code: 'invalid',
      error: 'Invalid invitation link. Please check the URL.',
    };
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
  const adminClient = serviceClient();

  const { data: invite, error: fetchErr } = await adminClient
    .from('admin_invites')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (fetchErr || !invite) {
    return {
      valid: false,
      code: 'not_found',
      error: 'This invitation was not found. Please verify the link or ask the platform owner for an invite.',
    };
  }

  if (invite.status === 'revoked') {
    return {
      valid: false,
      code: 'revoked',
      error: 'This invitation has been revoked by the platform owner.',
    };
  }

  if (invite.status === 'accepted') {
    return {
      valid: false,
      code: 'already_accepted',
      error: 'This invitation has already been accepted and used.',
    };
  }

  if (invite.status === 'expired' || new Date(invite.expires_at) < new Date()) {
    if (invite.status !== 'expired') {
      await adminClient.from('admin_invites').update({ status: 'expired' }).eq('id', invite.id);
    }
    return {
      valid: false,
      code: 'expired',
      error: 'This invitation has expired (invitations are valid for 48 hours). Please ask the platform owner to send a new invite.',
    };
  }

  return {
    valid: true,
    email: invite.email,
    role: invite.role as PlatformAccessRole,
  };
}

/**
 * Accepts an admin invitation and creates an admin-only account server-side.
 * Strictly uses the email and role from the validated token row (never trusts client input).
 */
export async function acceptAdminInviteAction(input: {
  token: string;
  name: string;
  password: string;
}): Promise<{
  success: boolean;
  error?: string;
  email?: string;
}> {
  const { token, name, password } = input;
  const cleanName = (name || '').trim();
  if (!cleanName || cleanName.length < 2) {
    return { success: false, error: 'Please enter your full name.' };
  }
  if (!password || password.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters long.' };
  }

  if (!token || typeof token !== 'string') {
    return { success: false, error: 'Missing or invalid invitation token.' };
  }

  const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
  const adminClient = serviceClient();

  const { data: invite, error: fetchErr } = await adminClient
    .from('admin_invites')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (fetchErr || !invite) {
    return { success: false, error: 'Invitation not found.' };
  }

  if (invite.status === 'revoked') {
    return { success: false, error: 'This invitation has been revoked.' };
  }
  if (invite.status === 'accepted') {
    return { success: false, error: 'This invitation has already been used.' };
  }
  if (invite.status === 'expired' || new Date(invite.expires_at) < new Date()) {
    return { success: false, error: 'This invitation has expired.' };
  }

  const targetEmail = invite.email.toLowerCase().trim();
  const targetRole = invite.role as PlatformAccessRole;

  // Find or create auth user using service role
  const existingUser = await findAuthUserByEmail(adminClient, targetEmail);

  let userId: string;

  if (!existingUser) {
    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email: targetEmail,
      password: password,
      email_confirm: true,
      user_metadata: { name: cleanName },
    });
    if (createErr || !created?.user) {
      console.error('[AcceptAdminInvite] Create auth user error:', createErr);
      return { success: false, error: createErr?.message || 'Failed to create admin user.' };
    }
    userId = created.user.id;
  } else {
    userId = existingUser.id;
    const { error: updateErr } = await adminClient.auth.admin.updateUserById(userId, {
      password: password,
      email_confirm: true,
      user_metadata: { name: cleanName },
    });
    if (updateErr) {
      console.error('[AcceptAdminInvite] Update auth user error:', updateErr);
      return { success: false, error: updateErr?.message || 'Failed to update user credentials.' };
    }
  }

  // Insert or update public.agents table: no workspace, no onboarding, admin-only
  const { error: agentErr } = await adminClient.from('agents').upsert(
    {
      id: userId,
      name: cleanName,
      email: targetEmail,
      workspace_id: null,
      role: 'admin',
      status: 'offline',
      is_active: true,
      is_super_admin: true,
      is_platform_owner: targetRole === 'owner',
      platform_staff_role: targetRole === 'owner' ? 'owner' : 'support',
    },
    { onConflict: 'id' }
  );

  if (agentErr) {
    console.error('[AcceptAdminInvite] Upsert agent error:', agentErr);
  }

  // Insert or upsert platform_access row
  const { error: accessErr } = await adminClient.from('platform_access').upsert(
    {
      user_id: userId,
      role: targetRole,
      granted_by: invite.invited_by,
      granted_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );

  if (accessErr) {
    console.error('[AcceptAdminInvite] Upsert platform_access error:', accessErr);
    return { success: false, error: accessErr?.message || 'Failed to assign platform access.' };
  }

  // Update invite status to accepted
  await adminClient
    .from('admin_invites')
    .update({
      status: 'accepted',
      accepted_at: new Date().toISOString(),
    })
    .eq('id', invite.id);

  // Audit log
  await adminClient.from('super_admin_audit_logs').insert({
    admin_id: userId,
    admin_email: targetEmail,
    admin_name: cleanName,
    action: 'platform_admin_invite_accepted',
    workspace_id: null,
    workspace_name: null,
    details: {
      invite_id: invite.id,
      role: targetRole,
    },
  });

  return { success: true, email: targetEmail };
}

/**
 * 10. Removes admin access for a user
 * The owner can never be removed or demoted.
 */
export async function revokeAdminAccessAction(targetUserId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const { agent: ownerAgent } = await assertPlatformOwner();

  if (!targetUserId) {
    return { success: false, error: 'User ID is required.' };
  }

  const adminClient = serviceClient();

  // Find target access row
  const { data: targetAccess } = await adminClient
    .from('platform_access')
    .select('*')
    .eq('user_id', targetUserId)
    .maybeSingle();

  if (!targetAccess) {
    return { success: false, error: 'Target user does not have platform access.' };
  }

  // Protect owner: The owner can never be removed
  if (targetAccess.role === 'owner') {
    return { success: false, error: 'The platform owner account cannot be removed or revoked.' };
  }

  // Delete from platform_access
  const { error: deleteErr } = await adminClient
    .from('platform_access')
    .delete()
    .eq('user_id', targetUserId);

  if (deleteErr) {
    console.error('[RevokeAdminAccess] Delete error:', deleteErr);
    return { success: false, error: deleteErr.message };
  }

  // Update public.agents
  await adminClient
    .from('agents')
    .update({
      is_super_admin: false,
      is_platform_owner: false,
      platform_staff_role: null,
    })
    .eq('id', targetUserId);

  // Record audit log
  await recordSuperAdminAudit({
    admin: ownerAgent,
    action: 'platform_admin_access_revoked',
    details: {
      revoked_user_id: targetUserId,
    },
  });

  return { success: true };
}

/**
 * Backwards compatibility aliases
 */
export const deleteSuperAdminAccessAction = async (adminAgentId: string) => {
  return revokeAdminAccessAction(adminAgentId);
};

export const revokeSuperAdminAccessAction = deleteSuperAdminAccessAction;



