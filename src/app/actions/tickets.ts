'use server';

/**
 * Ticketing server actions. Each one checks the caller belongs to the
 * workspace, then works through the caller's own session so row level
 * security applies as well, and still filters by workspace_id explicitly.
 *
 * The rules (numbering, status changes, follow-ups, the audit log) live in
 * the database (supabase/migrations/20261009110000_ticketing.sql); these
 * actions only ask for changes and report the database's answer.
 */

import { after } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { processAutomationOutbox } from '@/lib/automation/outbox';
import { getWorkspaceAccess } from '@/lib/team/access';
import { roleCan, type Capability, type Role } from '@/lib/team/permissions';
import { isValidEmail, sendSmtpEmail, teamMessageEmail } from '@/lib/email/smtp';
import { loadWorkspaceSmtp } from '@/lib/email/workspace-smtp';
import { sanitizeTicketPatch, type TicketPatch } from '@/lib/tickets/patch';
import { getAdapter } from '@/lib/channels/registry';
import { processOutboundQueue } from '@/lib/channels/outbound';
import { audienceOf } from '@/lib/channels/public';
import { renderTemplate } from '@/lib/channels/templates';
import { assertWorkspaceLimit, incrementWorkspaceUsage } from '@/lib/plans/enforce';
import {
  SETTABLE_STATUSES,
  SYSTEM_VIEWS,
  MANUAL_TICKET_CHANNELS,
  applyTicketFilters,
  normalizeFilters,
  normalizeSort,
  normalizeTag,
  sortColumn,
  viewFromRow,
  type FilterableQuery,
  type TicketFilters,
  type TicketSort,
  type ViewDefinition,
} from '@/lib/tickets/views';
import type {
  Message,
  Ticket,
  TicketChannel,
  TicketEvent,
  TicketGroup,
  TicketPriority,
  TicketStatus,
  TicketType,
  Visitor,
  VisitorPageHistory,
} from '@/types/database';
import { userError } from '@/lib/errors/user-error';

export type { TicketPatch };

// The project has no generated database types; the other actions use the same untyped client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supabase = Awaited<ReturnType<typeof createClient<any>>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;

/* ── Access ───────────────────────────────────────────────────────────── */

interface Caller {
  supabase: Supabase;
  agent: { id: string; name: string };
  role: Role;
  isAdmin: boolean;
}

/**
 * The caller must be an active member whose role allows `capability`
 * (src/lib/team/permissions.ts). The database checks the same again.
 */
async function assertTicketAccess(workspaceId: string, capability: Capability = 'view'): Promise<Caller> {
  const { supabase, agent, role } = await getWorkspaceAccess(workspaceId, capability);
  return {
    supabase: supabase as Supabase,
    agent: { id: agent.id, name: agent.name || 'Agent' },
    role,
    isAdmin: roleCan(role, 'manage_groups'),
  };
}

function dbError(error: { message?: string } | null | undefined, fallback: string): Error {
  return userError(error?.message || fallback);
}

/* ── Shapes returned to the UI ────────────────────────────────────────── */

export interface TicketListItem {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  channel: TicketChannel;
  tags: string[];
  assignee_id: string | null;
  group_id: string | null;
  requester: { id: string; name: string | null; email: string | null } | null;
  created_at: string;
  updated_at: string;
  solved_at: string | null;
  sla_state: 'running' | 'paused' | 'met' | null;
  sla_next_due_at: string | null;
  sla_next_warn_at: string | null;
  sla_next_metric: 'first_reply' | 'next_reply' | 'resolution' | null;
  sla_breached_at: string | null;
}

const LIST_COLUMNS =
  'id, number, subject, status, priority, type, channel, tags, assignee_id, group_id, created_at, updated_at, solved_at, csat_rating, csat_comment, csat_rated_at, sla_state, sla_next_due_at, sla_next_warn_at, sla_next_metric, sla_breached_at, requester:visitors(id, name, email)';

export interface TicketsBootstrap {
  me: { id: string; name: string; isAdmin: boolean; role: Role };
  /** Everyone in the workspace, deactivated people included so old tickets still show their name. */
  agents: {
    id: string;
    name: string;
    avatar_url: string | null;
    status: string;
    role: Role;
    is_active: boolean;
    max_open_tickets: number | null;
    /** New and Open tickets assigned to them right now (what capacity counts). */
    open_tickets: number;
  }[];
  groups: (TicketGroup & { member_ids: string[] })[];
  views: ViewDefinition[];
  counts: Record<string, number>;
}

/* ── Views and counts ─────────────────────────────────────────────────── */

async function savedViews(caller: Caller, workspaceId: string): Promise<ViewDefinition[]> {
  const { data } = await caller.supabase
    .from('ticket_views')
    .select('id, name, filters, sort, owner_id, position')
    .eq('workspace_id', workspaceId)
    .order('position')
    .order('created_at');
  return (data || []).map(viewFromRow);
}

function filteredTickets(caller: Caller, workspaceId: string, filters: TicketFilters, columns: string, head = false) {
  const base = caller.supabase
    .from('tickets')
    .select(columns, head ? { count: 'exact', head: true } : { count: 'exact' })
    .eq('workspace_id', workspaceId);
  // The Supabase builder satisfies FilterableQuery; its generics are too deep to name here.
  return applyTicketFilters(base as unknown as FilterableQuery<never>, filters, caller.agent.id) as unknown as typeof base;
}

async function countViews(caller: Caller, workspaceId: string, views: ViewDefinition[]): Promise<Record<string, number>> {
  const results = await Promise.all(
    views.map(async (v) => {
      const { count } = await filteredTickets(caller, workspaceId, v.filters, 'id', true);
      return [v.id, count ?? 0] as const;
    })
  );
  return Object.fromEntries(results);
}

export async function getTicketsBootstrapAction(workspaceId: string): Promise<TicketsBootstrap> {
  const caller = await assertTicketAccess(workspaceId);
  const [{ data: agents }, { data: groups }, { data: members }, { data: openRows }, saved] = await Promise.all([
    caller.supabase
      .from('agents')
      .select('id, name, avatar_url, status, role, is_active, max_open_tickets')
      .eq('workspace_id', workspaceId)
      .order('name'),
    caller.supabase.from('ticket_groups').select('*').eq('workspace_id', workspaceId).order('name'),
    caller.supabase.from('ticket_group_members').select('group_id, agent_id').eq('workspace_id', workspaceId),
    caller.supabase.from('tickets').select('assignee_id').eq('workspace_id', workspaceId).in('status', ['new', 'open']).not('assignee_id', 'is', null),
    savedViews(caller, workspaceId),
  ]);
  const views = [...SYSTEM_VIEWS, ...saved];
  const memberRows = (members as { group_id: string; agent_id: string }[] | null) || [];
  const openCounts = new Map<string, number>();
  for (const t of (openRows as { assignee_id: string }[] | null) || []) openCounts.set(t.assignee_id, (openCounts.get(t.assignee_id) || 0) + 1);
  return {
    me: { id: caller.agent.id, name: caller.agent.name, isAdmin: caller.isAdmin, role: caller.role },
    agents: ((agents as Omit<TicketsBootstrap['agents'][number], 'open_tickets'>[] | null) || []).map((a) => ({
      ...a,
      is_active: a.is_active !== false,
      open_tickets: openCounts.get(a.id) || 0,
    })),
    groups: ((groups as TicketGroup[] | null) || []).map((g) => ({
      ...g,
      member_ids: memberRows.filter((m) => m.group_id === g.id).map((m) => m.agent_id),
    })),
    views,
    counts: await countViews(caller, workspaceId, views),
  };
}

export async function getViewCountsAction(workspaceId: string): Promise<Record<string, number>> {
  const caller = await assertTicketAccess(workspaceId);
  return countViews(caller, workspaceId, [...SYSTEM_VIEWS, ...(await savedViews(caller, workspaceId))]);
}

export async function listTicketsAction(
  workspaceId: string,
  request: { viewId?: string; filters?: unknown; sort?: unknown; page?: number }
): Promise<{ tickets: TicketListItem[]; total: number; view: ViewDefinition | null }> {
  const caller = await assertTicketAccess(workspaceId);

  let view: ViewDefinition | null = null;
  if (request.viewId) {
    view =
      SYSTEM_VIEWS.find((v) => v.id === request.viewId) ||
      (await savedViews(caller, workspaceId)).find((v) => v.id === request.viewId) ||
      null;
    if (!view) throw userError('That view no longer exists.');
  }
  const filters = request.filters !== undefined ? normalizeFilters(request.filters) : view?.filters ?? {};
  const sort: TicketSort = request.sort !== undefined ? normalizeSort(request.sort) : view?.sort ?? normalizeSort(null);
  const page = Math.max(0, Math.floor(request.page ?? 0));

  const { data, count, error } = await filteredTickets(caller, workspaceId, filters, LIST_COLUMNS)
    .order(sortColumn(sort), { ascending: sort.direction === 'asc', nullsFirst: false })
    .order('number', { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (error) throw dbError(error, 'Could not load tickets.');
  return { tickets: (data as unknown as TicketListItem[]) || [], total: count ?? 0, view };
}

export async function saveTicketViewAction(
  workspaceId: string,
  input: { id?: string; name: string; filters: unknown; sort: unknown; shared: boolean }
): Promise<ViewDefinition> {
  const caller = await assertTicketAccess(workspaceId);
  const name = (input.name || '').trim().slice(0, 80);
  if (!name) throw userError('Give the view a name.');
  if (input.shared && !caller.isAdmin) throw userError('Only admins can share views with the whole team.');

  const row = {
    workspace_id: workspaceId,
    name,
    filters: normalizeFilters(input.filters),
    sort: normalizeSort(input.sort),
    owner_id: input.shared ? null : caller.agent.id,
    updated_at: new Date().toISOString(),
  };
  const query = input.id
    ? caller.supabase.from('ticket_views').update(row).eq('id', input.id).eq('workspace_id', workspaceId)
    : caller.supabase.from('ticket_views').insert(row);
  const { data, error } = await query.select('id, name, filters, sort, owner_id').single();
  if (error || !data) throw dbError(error, 'Could not save the view.');
  return viewFromRow(data);
}

export async function deleteTicketViewAction(workspaceId: string, viewId: string): Promise<void> {
  const caller = await assertTicketAccess(workspaceId);
  const { error } = await caller.supabase.from('ticket_views').delete().eq('id', viewId).eq('workspace_id', workspaceId);
  if (error) throw dbError(error, 'Could not delete the view.');
}

/* ── One ticket ───────────────────────────────────────────────────────── */

export interface TicketDetail {
  ticket: Ticket;
  messages: Pick<
    Message,
    | 'id'
    | 'conversation_id'
    | 'sender_type'
    | 'sender_id'
    | 'content'
    | 'attachment_url'
    | 'created_at'
    | 'is_internal'
    | 'metadata'
    | 'channel_status'
    | 'channel_error'
  >[];
  events: TicketEvent[];
  /** For tickets from an outside channel: what the composer needs to know before a reply is sent. */
  channelState: TicketChannelState | null;
  requester: Pick<
    Visitor,
    | 'id'
    | 'name'
    | 'email'
    | 'location'
    | 'ip_location_city'
    | 'ip_location_country'
    | 'browser'
    | 'os'
    | 'device'
    | 'current_page_url'
    | 'current_page_title'
    | 'referrer_source'
    | 'current_page_entered_at'
    | 'time_on_page_seconds'
    | 'is_online'
    | 'last_seen_at'
    | 'first_seen_at'
    | 'timezone'
    | 'language'
  > | null;
  /** Recent browsing trail of the requester */
  requesterPageHistory?: VisitorPageHistory[];
  previousTickets: Pick<Ticket, 'id' | 'number' | 'subject' | 'status' | 'created_at'>[];
  /** Follow-ups of this ticket, tickets merged into it, and what it follows up or was merged into. */
  related: Pick<Ticket, 'id' | 'number' | 'subject' | 'status' | 'follow_up_of_id' | 'merged_into_id'>[];
  /** Names for every agent and visitor that appears in the thread or log. */
  people: Record<string, string>;
  /** The SLA policy applied to this ticket and each of its timers. */
  sla: TicketSla;
}

export interface TicketSla {
  policyName: string | null;
  timers: {
    metric: 'first_reply' | 'next_reply' | 'resolution';
    status: 'running' | 'paused' | 'met' | 'cancelled';
    target_minutes: number;
    business_hours: boolean;
    due_at: string | null;
    warn_at: string | null;
    breached_at: string | null;
    met_at: string | null;
  }[];
}

export interface TicketChannelState {
  channel: string;
  label: string;
  /** When the customer last wrote on the channel; the service window counts from here. */
  lastInboundAt: string | null;
  /** Hours free-form replies are allowed after that; null when the channel has no window. */
  windowHours: number | null;
  /** Hours a person may still reply when the connection has Meta's Human Agent feature (Instagram); null otherwise. */
  humanAgentHours: number | null;
  templates: boolean;
  connectionStatus: 'connected' | 'needs_attention' | 'disconnected';
  connectionName: string | null;
  /**
   * Who can read a reply: 'public' when this ticket is about a public post,
   * reply or comment (X, Threads, LinkedIn, TikTok), 'private' for a direct
   * message or any other channel.
   */
  audience: 'public' | 'private';
  /** The channel also has public replies (X), so a private reply deserves saying so. */
  offersPublic: boolean;
  /** The platform's reply length limit, for the counter; null when it has none we know of. */
  maxReplyLength: number | null;
  /** For a public ticket: the item a reply will be posted under. */
  publicTarget: { kind: 'mention' | 'reply' | 'comment'; handle: string | null; permalink: string | null; excerpt: string } | null;
}

/**
 * The channel adapter that carries this ticket's replies, if any. An adapter
 * handles a ticket only when its conversation really arrived on that channel:
 * an email ticket an agent logged by hand (conversation channel "web") keeps
 * replying through the workspace SMTP.
 */
async function adapterFor(supabase: Supabase, workspaceId: string, ticket: { channel: string; conversation_id: string | null }) {
  const adapter = getAdapter(ticket.channel);
  if (!adapter || !ticket.conversation_id) return null;
  if (adapter.id !== 'email') return adapter;
  const { data } = await supabase.from('conversations').select('channel').eq('id', ticket.conversation_id).eq('workspace_id', workspaceId).maybeSingle();
  return data?.channel === 'email' ? adapter : null;
}

async function channelStateFor(supabase: Supabase, workspaceId: string, ticket: Ticket): Promise<TicketChannelState | null> {
  const adapter = await adapterFor(supabase, workspaceId, ticket);
  if (!adapter || !ticket.conversation_id) return null;
  const [{ data: conv }, { data: conn }] = await Promise.all([
    supabase.from('conversations').select('channel_last_inbound_at, channel_user_id').eq('id', ticket.conversation_id).eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('channel_connections').select('status, display_name, settings').eq('workspace_id', workspaceId).eq('channel', adapter.id).maybeSingle(),
  ]);
  const audience = audienceOf(conv?.channel_user_id);
  let publicTarget: TicketChannelState['publicTarget'] = null;
  if (audience === 'public') {
    // The reply goes under the newest public item the customer posted.
    const { data: recent } = await supabase
      .from('messages')
      .select('content, metadata')
      .eq('conversation_id', ticket.conversation_id)
      .eq('sender_type', 'visitor')
      .order('created_at', { ascending: false })
      .limit(10);
    for (const m of (recent as { content: string | null; metadata: Record<string, unknown> | null }[] | null) || []) {
      const item = m.metadata?.channel_public as { kind?: 'mention' | 'reply' | 'comment'; handle?: string; permalink?: string } | undefined;
      if (item?.kind) {
        publicTarget = { kind: item.kind, handle: item.handle ?? null, permalink: item.permalink ?? null, excerpt: (m.content || '').slice(0, 160) };
        break;
      }
    }
  }
  return {
    audience,
    offersPublic: adapter.capabilities.publicReplies === true,
    maxReplyLength: adapter.capabilities.maxReplyLength ?? null,
    publicTarget,
    channel: adapter.id,
    label: adapter.label,
    lastInboundAt: conv?.channel_last_inbound_at ?? null,
    windowHours: adapter.capabilities.serviceWindowHours,
    humanAgentHours: conn?.settings?.human_agent === true ? adapter.capabilities.humanAgentWindowHours ?? null : null,
    templates: adapter.capabilities.templates,
    connectionStatus: conn?.status ?? 'disconnected',
    connectionName: conn?.display_name ?? null,
  };
}

export async function getTicketAction(workspaceId: string, ticketId: string): Promise<TicketDetail> {
  const caller = await assertTicketAccess(workspaceId);
  const { supabase } = caller;
  const { data: ticket, error } = await supabase
    .from('tickets')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', ticketId)
    .maybeSingle();
  if (error || !ticket) throw dbError(error, 'Ticket not found.');
  const t = ticket as Ticket;

  const linkIds = [t.follow_up_of_id, t.merged_into_id].filter(Boolean) as string[];
  const [
    { data: messages },
    { data: events },
    { data: requester },
    { data: pageHistory },
    { data: previous },
    { data: related },
    { data: slaTimers },
    { data: slaPolicy },
  ] = await Promise.all([
    supabase
      .from('messages')
      .select('id, conversation_id, sender_type, sender_id, content, attachment_url, created_at, is_internal, metadata, channel_status, channel_error')
      .eq('ticket_id', t.id)
      .order('created_at', { ascending: true })
      .limit(1000),
    supabase.from('ticket_events').select('*').eq('ticket_id', t.id).eq('workspace_id', workspaceId).order('id', { ascending: true }),
    t.requester_id
      ? supabase
          .from('visitors')
          .select(
            'id, name, email, location, ip_location_city, ip_location_country, browser, os, device, current_page_url, current_page_title, referrer_source, current_page_entered_at, time_on_page_seconds, is_online, last_seen_at, first_seen_at, timezone, language'
          )
          .eq('id', t.requester_id)
          .eq('workspace_id', workspaceId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    t.requester_id
      ? supabase
          .from('visitor_page_history')
          .select('*')
          .eq('visitor_id', t.requester_id)
          .order('visited_at', { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),
    t.requester_id
      ? supabase
          .from('tickets')
          .select('id, number, subject, status, created_at')
          .eq('workspace_id', workspaceId)
          .eq('requester_id', t.requester_id)
          .neq('id', t.id)
          .order('created_at', { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),
    supabase
      .from('tickets')
      .select('id, number, subject, status, follow_up_of_id, merged_into_id')
      .eq('workspace_id', workspaceId)
      .or([`follow_up_of_id.eq.${t.id}`, `merged_into_id.eq.${t.id}`, ...linkIds.map((id) => `id.eq.${id}`)].join(',')),
    supabase
      .from('ticket_sla_timers')
      .select('metric, status, target_minutes, business_hours, due_at, warn_at, breached_at, met_at')
      .eq('ticket_id', t.id)
      .eq('workspace_id', workspaceId),
    t.sla_policy_id
      ? supabase.from('sla_policies').select('name').eq('id', t.sla_policy_id).eq('workspace_id', workspaceId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const agentIds = new Set<string>();
  for (const m of messages || []) if (m.sender_type === 'agent' && m.sender_id) agentIds.add(m.sender_id);
  for (const e of events || []) {
    if (e.actor_type === 'agent' && e.actor_id) agentIds.add(e.actor_id);
    if (e.field === 'assignee_id') {
      if (e.old_value) agentIds.add(e.old_value);
      if (e.new_value) agentIds.add(e.new_value);
    }
  }
  if (t.assignee_id) agentIds.add(t.assignee_id);
  const { data: agentRows } = agentIds.size
    ? await supabase.from('agents').select('id, name').in('id', Array.from(agentIds))
    : { data: [] as { id: string; name: string }[] };

  const people: Record<string, string> = {};
  for (const a of agentRows || []) people[a.id] = a.name;
  if (requester) people[requester.id] = requester.name || requester.email || 'Customer';

  return {
    ticket: t,
    messages: (messages as TicketDetail['messages']) || [],
    events: (events as TicketEvent[]) || [],
    channelState: await channelStateFor(supabase, workspaceId, t),
    requester: (requester as TicketDetail['requester']) || null,
    requesterPageHistory: (pageHistory as VisitorPageHistory[]) || [],
    previousTickets: (previous as TicketDetail['previousTickets']) || [],
    related: (related as TicketDetail['related']) || [],
    people,
    sla: {
      policyName: (slaPolicy as { name: string } | null)?.name ?? null,
      timers: ((slaTimers as TicketSla['timers'] | null) || []).filter((x) => x.status !== 'cancelled'),
    },
  };
}

/** An assignee and group must belong to this workspace. */
async function assertReferences(caller: Caller, workspaceId: string, patch: TicketPatch) {
  if (patch.assignee_id) {
    const { data } = await caller.supabase
      .from('agents')
      .select('id')
      .eq('id', patch.assignee_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!data) throw userError('That agent is not in this workspace.');
  }
  if (patch.group_id) {
    const { data } = await caller.supabase
      .from('ticket_groups')
      .select('id')
      .eq('id', patch.group_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!data) throw userError('That group is not in this workspace.');
  }
}

export async function updateTicketAction(workspaceId: string, ticketId: string, patch: TicketPatch): Promise<Ticket> {
  const caller = await assertTicketAccess(workspaceId, 'edit_ticket');
  const clean = sanitizeTicketPatch(patch);
  if (!Object.keys(clean).length) throw userError('Nothing to change.');
  await assertReferences(caller, workspaceId, clean);
  const { data, error } = await caller.supabase
    .from('tickets')
    .update(clean)
    .eq('workspace_id', workspaceId)
    .eq('id', ticketId)
    .select('*')
    .maybeSingle();
  if (error || !data) throw dbError(error, 'Ticket not found.');
  sendQueuedAutomationMail(workspaceId);
  return data as Ticket;
}

/**
 * Rules queue emails and webhooks in the database; send them now instead of
 * at the next hourly run. After the response, so the agent is not kept waiting.
 */
function sendQueuedAutomationMail(workspaceId: string) {
  after(() => processAutomationOutbox({ workspaceId, limit: 10 }).catch((e) => console.error('[Automation Outbox Error]:', e)));
}

/* ── Replies and notes ────────────────────────────────────────────────── */

export async function replyToTicketAction(
  workspaceId: string,
  ticketId: string,
  input: { body: string; internal: boolean; submitAs?: TicketStatus }
): Promise<ReplyOutcome> {
  // Internal notes are open to light agents; customer replies and status changes are not.
  const caller = await assertTicketAccess(workspaceId, input.internal ? 'add_note' : 'reply');
  if (input.submitAs && !roleCan(caller.role, 'edit_ticket')) {
    throw userError('Forbidden: your role cannot change a ticket’s status.');
  }
  const body = (input.body || '').trim();
  if (!body) throw userError('Write something first.');
  if (body.length > 20_000) throw userError('That reply is too long.');

  const { data: ticket } = await caller.supabase
    .from('tickets')
    .select('id, number, subject, status, conversation_id, channel, requester_id')
    .eq('workspace_id', workspaceId)
    .eq('id', ticketId)
    .maybeSingle();
  if (!ticket) throw userError('Ticket not found.');
  if (ticket.status === 'closed') throw userError(`Ticket #${ticket.number} is closed. Create a follow-up instead.`);

  // After a merge the customer may be writing in another conversation; reply
  // where they last wrote so the widget they have open receives it.
  const { data: lastCustomer } = await caller.supabase
    .from('messages')
    .select('conversation_id')
    .eq('ticket_id', ticketId)
    .eq('sender_type', 'visitor')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const conversationId = lastCustomer?.conversation_id || ticket.conversation_id;
  if (!conversationId) throw userError('This ticket has no conversation to reply in.');

  const { data: inserted, error } = await caller.supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      ticket_id: ticketId,
      sender_type: 'agent',
      sender_id: caller.agent.id,
      content: body,
      is_internal: input.internal,
    })
    .select('id')
    .single();
  if (error || !inserted) throw dbError(error, 'Could not send the reply.');

  if (input.submitAs && SETTABLE_STATUSES.includes(input.submitAs) && input.submitAs !== ticket.status) {
    const { error: statusError } = await caller.supabase
      .from('tickets')
      .update({ status: input.submitAs })
      .eq('workspace_id', workspaceId)
      .eq('id', ticketId);
    if (statusError) throw dbError(statusError, 'Reply sent, but the status could not be changed.');
  }
  sendQueuedAutomationMail(workspaceId);

  // WhatsApp and other channels: the database queued the reply; send it now
  // so the agent sees at once whether it went out.
  if (!input.internal && (await adapterFor(caller.supabase, workspaceId, ticket))) {
    return { emailed: false, channel: await sendQueued(caller.supabase, inserted.id) };
  }

  // Chat replies reach the widget in real time. Email and web-form tickets
  // have no live channel, so the reply is emailed through the workspace SMTP.
  if (input.internal || ticket.channel === 'chat' || !ticket.requester_id) return { emailed: false };
  const [{ data: requester }, { data: ws }] = await Promise.all([
    caller.supabase.from('visitors').select('email, name').eq('id', ticket.requester_id).maybeSingle(),
    caller.supabase.from('workspaces').select('name, brand_color, logo_url').eq('id', workspaceId).maybeSingle(),
  ]);
  // The password is server-only (workspace_secrets); the caller's access was checked above.
  const smtp = await loadWorkspaceSmtp(workspaceId);
  if (!requester?.email || !isValidEmail(requester.email)) return { emailed: false, emailError: 'The requester has no email address.' };
  if (!smtp) {
    return { emailed: false, emailError: 'Saved, but not emailed: SMTP is not set up for this workspace.' };
  }
  const brandName = ws?.name || smtp.from_name || 'Support';
  const email = teamMessageEmail({
    brandName,
    brandColor: ws?.brand_color,
    logoUrl: ws?.logo_url,
    subject: `[#${ticket.number}] ${ticket.subject || `Your request to ${brandName}`}`,
    title: ticket.subject || `Your request to ${brandName}`,
    body,
    details: [['Request', `#${ticket.number}`]],
    footer: `You received this because you contacted ${brandName} (request #${ticket.number}). Reply to this email to answer.`,
  });
  const sent = await sendSmtpEmail(smtp, { to: requester.email, subject: email.subject, html: email.html, text: email.text });
  return sent.success ? { emailed: true } : { emailed: false, emailError: sent.error || 'Email could not be sent.' };
}

export interface ReplyOutcome {
  emailed: boolean;
  emailError?: string;
  /** Set for replies on an outside channel. */
  channel?: { status: 'sent' | 'queued' | 'failed'; error?: string };
}

async function sendQueued(supabase: Supabase, messageId: string): Promise<NonNullable<ReplyOutcome['channel']>> {
  await processOutboundQueue({ messageId, limit: 1 });
  const { data } = await supabase.from('messages').select('channel_status, channel_error').eq('id', messageId).maybeSingle();
  const status = data?.channel_status;
  if (status === 'failed') return { status: 'failed', error: data?.channel_error || 'Could not send.' };
  if (status === 'queued') return { status: 'queued', error: 'Not sent yet; it will be retried automatically.' };
  return { status: 'sent' };
}

/**
 * Sends an approved template on a channel ticket: the only thing WhatsApp
 * accepts once the customer has been quiet for 24 hours. The transcript
 * shows the filled-in body; the template itself rides in the metadata,
 * which is what the database's window rule and the outbound worker read.
 */
export async function sendTicketTemplateAction(
  workspaceId: string,
  ticketId: string,
  input: { name: string; language: string; body: string; params: string[] }
): Promise<ReplyOutcome> {
  const caller = await assertTicketAccess(workspaceId, 'reply');
  const name = (input.name || '').trim();
  const language = (input.language || '').trim();
  if (!/^[a-z0-9_]{1,512}$/.test(name) || !/^[a-zA-Z_]{2,10}$/.test(language)) throw userError('Choose a template.');
  const params = (input.params || []).map((p) => String(p ?? '').trim());
  if (params.some((p) => !p)) throw userError('Fill in every placeholder.');
  if (params.some((p) => p.length > 1000)) throw userError('A placeholder value is too long.');

  const { data: ticket } = await caller.supabase
    .from('tickets')
    .select('id, number, status, conversation_id, channel')
    .eq('workspace_id', workspaceId)
    .eq('id', ticketId)
    .maybeSingle();
  if (!ticket) throw userError('Ticket not found.');
  if (ticket.status === 'closed') throw userError(`Ticket #${ticket.number} is closed. Create a follow-up instead.`);
  const adapter = getAdapter(ticket.channel);
  if (!adapter?.capabilities.templates || !ticket.conversation_id) throw userError('Templates are only for channel tickets.');

  const { data: inserted, error } = await caller.supabase
    .from('messages')
    .insert({
      conversation_id: ticket.conversation_id,
      ticket_id: ticketId,
      sender_type: 'agent',
      sender_id: caller.agent.id,
      content: renderTemplate(input.body || `Template: ${name}`, params).slice(0, 4096),
      is_internal: false,
      metadata: { channel_template: { name, language, body_params: params } },
    })
    .select('id')
    .single();
  if (error || !inserted) throw dbError(error, 'Could not send the template.');
  return { emailed: false, channel: await sendQueued(caller.supabase, inserted.id) };
}

/** Puts a message that failed for good back in the queue (after fixing the connection, say). */
export async function retryTicketMessageAction(workspaceId: string, messageId: string): Promise<ReplyOutcome> {
  const caller = await assertTicketAccess(workspaceId, 'reply');
  if (!UUID.test(messageId)) throw userError('Message not found.');
  const { error } = await caller.supabase.rpc('fn_retry_channel_message', { p_message_id: messageId });
  if (error) throw dbError(error, 'Could not retry.');
  return { emailed: false, channel: await sendQueued(caller.supabase, messageId) };
}

/* ── Creating tickets ─────────────────────────────────────────────────── */

export async function createTicketAction(
  workspaceId: string,
  input: {
    requesterName: string;
    requesterEmail: string;
    subject: string;
    body: string;
    channel: TicketChannel;
    priority?: TicketPriority;
    type?: TicketType;
    assigneeId?: string | null;
    groupId?: string | null;
    tags?: string[];
  }
): Promise<Ticket> {
  const caller = await assertTicketAccess(workspaceId, 'edit_ticket');
  await assertWorkspaceLimit(workspaceId, 'max_tickets_per_month');
  const { supabase } = caller;
  const email = (input.requesterEmail || '').trim().toLowerCase();
  const subject = (input.subject || '').trim();
  const body = (input.body || '').trim();
  if (!isValidEmail(email)) throw userError('Enter the requester’s email address.');
  if (!subject) throw userError('Give the ticket a subject.');
  if (!body) throw userError('Describe the request.');
  const channel: TicketChannel = MANUAL_TICKET_CHANNELS.includes(input.channel) ? input.channel : 'email';

  const patch = sanitizeTicketPatch({
    priority: input.priority,
    type: input.type,
    assignee_id: input.assigneeId ?? undefined,
    group_id: input.groupId ?? undefined,
    tags: input.tags,
  });
  await assertReferences(caller, workspaceId, patch);

  // One requester per email address in a workspace.
  let { data: visitor } = await supabase
    .from('visitors')
    .select('id')
    .eq('workspace_id', workspaceId)
    .ilike('email', email)
    .order('first_seen_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!visitor) {
    const { data: created, error } = await supabase
      .from('visitors')
      .insert({
        workspace_id: workspaceId,
        email,
        name: (input.requesterName || '').trim() || email.split('@')[0],
        channel: 'web',
        is_online: false,
      })
      .select('id')
      .single();
    if (error || !created) throw dbError(error, 'Could not create the requester.');
    visitor = created;
  }

  // The conversation is the ticket's thread; the database opens the ticket.
  const { data: conv, error: convError } = await supabase
    .from('conversations')
    .insert({
      workspace_id: workspaceId,
      visitor_id: visitor.id,
      status: 'open',
      channel: 'web',
      channel_metadata: { ticket_channel: channel, ticket_subject: subject, ticket_type: patch.type || 'question' },
    })
    .select('id')
    .single();
  if (convError || !conv) throw dbError(convError, 'Could not create the ticket.');

  const { error: msgError } = await supabase.from('messages').insert({
    conversation_id: conv.id,
    sender_type: 'visitor',
    content: body,
    metadata: { logged_by_agent_id: caller.agent.id },
  });
  if (msgError) throw dbError(msgError, 'Ticket created, but its first message could not be saved.');

  const { data: created } = await supabase
    .from('conversations')
    .select('current_ticket_id')
    .eq('id', conv.id)
    .single();
  if (!created?.current_ticket_id) throw userError('Ticket was not created.');

  const rest = { ...patch };
  delete rest.type;
  if (Object.keys(rest).length) {
    const { error } = await supabase.from('tickets').update(rest).eq('id', created.current_ticket_id).eq('workspace_id', workspaceId);
    if (error) throw dbError(error, 'Ticket created, but some fields could not be set.');
  }
  const { data: ticket } = await supabase.from('tickets').select('*').eq('id', created.current_ticket_id).single();
  incrementWorkspaceUsage(workspaceId, 'tickets', 1).catch(() => {});
  return ticket as Ticket;
}

/* ── Bulk actions, merge, search ──────────────────────────────────────── */

export interface BulkChange {
  assigneeId?: string | null;
  status?: TicketStatus;
  addTag?: string;
}

export async function bulkUpdateTicketsAction(
  workspaceId: string,
  ticketIds: string[],
  change: BulkChange
): Promise<{ updated: number; skipped: { id: string; number?: number; reason: string }[] }> {
  const caller = await assertTicketAccess(workspaceId, 'edit_ticket');
  const ids = Array.from(new Set(ticketIds.filter((id) => UUID.test(id)))).slice(0, 200);
  if (!ids.length) throw userError('Select some tickets first.');

  const patch = sanitizeTicketPatch({
    assignee_id: change.assigneeId === undefined ? undefined : change.assigneeId,
    status: change.status,
  });
  const tag = change.addTag ? normalizeTag(change.addTag) : '';
  if (!Object.keys(patch).length && !tag) throw userError('Choose what to change.');
  await assertReferences(caller, workspaceId, patch);

  const { data: rows, error } = await caller.supabase
    .from('tickets')
    .select('id, number, status, tags')
    .eq('workspace_id', workspaceId)
    .in('id', ids);
  if (error) throw dbError(error, 'Could not load the selected tickets.');

  const skipped: { id: string; number?: number; reason: string }[] = ids
    .filter((id) => !(rows || []).some((r) => r.id === id))
    .map((id) => ({ id, reason: 'not found' }));
  let updated = 0;
  // One update per ticket so each gets its own audit entries and a closed
  // ticket only fails itself.
  for (const row of rows || []) {
    if (row.status === 'closed') {
      skipped.push({ id: row.id, number: row.number, reason: 'closed tickets are read-only' });
      continue;
    }
    const rowPatch: TicketPatch = { ...patch };
    if (tag && !(row.tags || []).includes(tag)) rowPatch.tags = [...(row.tags || []), tag];
    if (!Object.keys(rowPatch).length) continue;
    const { error: updateError } = await caller.supabase
      .from('tickets')
      .update(rowPatch)
      .eq('workspace_id', workspaceId)
      .eq('id', row.id);
    if (updateError) skipped.push({ id: row.id, number: row.number, reason: updateError.message });
    else updated += 1;
  }
  return { updated, skipped };
}

export async function mergeTicketsAction(workspaceId: string, targetId: string, sourceIds: string[]): Promise<Ticket> {
  const caller = await assertTicketAccess(workspaceId, 'edit_ticket');
  const sources = Array.from(new Set(sourceIds.filter((id) => UUID.test(id) && id !== targetId)));
  if (!UUID.test(targetId) || !sources.length) throw userError('Choose a ticket to merge into and at least one other.');
  const { data, error } = await caller.supabase.rpc('fn_merge_tickets', { p_target_id: targetId, p_source_ids: sources });
  if (error || !data) throw dbError(error, 'Could not merge the tickets.');
  const merged = data as Ticket;
  if (merged.workspace_id !== workspaceId) throw userError('Ticket not found.');
  return merged;
}

export async function searchTicketsAction(
  workspaceId: string,
  query: string
): Promise<{ tickets: (TicketListItem & { matched_on: string })[] }> {
  const caller = await assertTicketAccess(workspaceId);
  const q = (query || '').trim().slice(0, 200);
  if (!q) return { tickets: [] };
  const { data: hits, error } = await caller.supabase.rpc('fn_search_tickets', {
    p_workspace_id: workspaceId,
    p_query: q,
    p_limit: 50,
  });
  if (error) throw dbError(error, 'Search failed.');
  const matches = (hits as { ticket_id: string; matched_on: string }[]) || [];
  if (!matches.length) return { tickets: [] };
  const { data: rows } = await caller.supabase
    .from('tickets')
    .select(LIST_COLUMNS)
    .eq('workspace_id', workspaceId)
    .in('id', matches.map((m) => m.ticket_id));
  const byId = new Map(((rows as unknown as TicketListItem[]) || []).map((r) => [r.id, r]));
  return {
    tickets: matches
      .map((m) => (byId.has(m.ticket_id) ? { ...byId.get(m.ticket_id)!, matched_on: m.matched_on } : null))
      .filter((t): t is TicketListItem & { matched_on: string } => t !== null),
  };
}

/* ── Presence (collision detection) ───────────────────────────────────── */

export type PresenceState = 'viewing' | 'replying' | 'noting';

export interface TicketPresence {
  agent_id: string;
  name: string;
  avatar_url: string | null;
  state: PresenceState;
  updated_at: string;
}

/** A heartbeat older than this means the agent has gone (closed the tab, lost connection). */
const PRESENCE_TTL_MS = 45_000;

/**
 * Records what the caller is doing on a ticket (or that they left, with
 * `null`) and returns who else is on it right now.
 */
export async function setTicketPresenceAction(
  workspaceId: string,
  ticketId: string,
  state: PresenceState | null
): Promise<TicketPresence[]> {
  const caller = await assertTicketAccess(workspaceId);
  if (!UUID.test(ticketId || '')) throw userError('Ticket not found.');
  if (state === null) {
    await caller.supabase.from('ticket_presence').delete().eq('ticket_id', ticketId).eq('agent_id', caller.agent.id);
    return [];
  }
  const safeState: PresenceState = state === 'replying' && !roleCan(caller.role, 'reply') ? 'noting' : state;
  const { error } = await caller.supabase
    .from('ticket_presence')
    .upsert({ ticket_id: ticketId, agent_id: caller.agent.id, workspace_id: workspaceId, state: safeState }, { onConflict: 'ticket_id,agent_id' });
  if (error) throw dbError(error, 'Could not update presence.');
  return othersOnTicket(caller, workspaceId, ticketId);
}

async function othersOnTicket(caller: Caller, workspaceId: string, ticketId: string): Promise<TicketPresence[]> {
  const since = new Date(Date.now() - PRESENCE_TTL_MS).toISOString();
  const { data } = await caller.supabase
    .from('ticket_presence')
    .select('agent_id, state, updated_at, agent:agents(name, avatar_url)')
    .eq('workspace_id', workspaceId)
    .eq('ticket_id', ticketId)
    .neq('agent_id', caller.agent.id)
    .gte('updated_at', since)
    .order('updated_at', { ascending: false });
  type Row = { agent_id: string; state: PresenceState; updated_at: string; agent: { name: string | null; avatar_url: string | null } | null };
  return ((data as unknown as Row[]) || []).map((r) => ({
    agent_id: r.agent_id,
    name: r.agent?.name || 'Another agent',
    avatar_url: r.agent?.avatar_url ?? null,
    state: r.state,
    updated_at: r.updated_at,
  }));
}
