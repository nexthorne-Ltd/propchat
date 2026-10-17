/**
 * The public chat API (/api/v1): what the route handlers share.
 *
 * Every request is authenticated by a workspace API key (src/lib/api/keys.ts)
 * and counted against the plan's monthly API request limit. A key acts for
 * its workspace only, and only on conversations it started through the API
 * (channel_metadata.source = 'api'), so one integration cannot read the
 * widget's or another integration's chats.
 *
 * A visitor message goes through the same auto-respond route as the widget,
 * in-process, so every bot rule holds here too: plan and settings checks,
 * a person owning the conversation, fn_deliver_ai_reply, handover. The API
 * never writes a bot or agent message itself.
 *
 * This is a server-to-server API and sends no CORS headers: a key used from a
 * browser would be readable by anyone visiting the page.
 */
import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/service';
import { checkWorkspaceLimit, incrementWorkspaceUsage } from '@/lib/plans/enforce';
import { authenticateApiKey, type ApiCaller } from '@/lib/api/keys';
import { POST as autoRespond } from '@/app/api/ai/auto-respond/route';

/* ── Responses ────────────────────────────────────────────────────────── */

export function apiJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function apiError(status: number, code: string, message: string) {
  return apiJson({ error: { code, message } }, status);
}

export class ApiInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Authenticates, enforces the plan's API limit, counts the request and maps
 * failures to JSON errors. Unexpected errors are logged and returned as a
 * plain 500, never with their details.
 */
export async function withApiCaller(req: Request, handler: (caller: ApiCaller) => Promise<Response>): Promise<Response> {
  try {
    const caller = await authenticateApiKey(req);
    if (!caller) {
      return apiError(401, 'unauthorized', 'Missing or invalid API key. Send it as "Authorization: Bearer zk_live_...".');
    }
    const limit = await checkWorkspaceLimit(caller.workspaceId, 'max_api_requests_per_month');
    if (!limit.allowed) {
      return apiError(429, 'plan_limit_reached', limit.upgradeMessage || 'Monthly API request limit reached.');
    }
    incrementWorkspaceUsage(caller.workspaceId, 'api_requests', 1).catch(() => {});
    return await handler(caller);
  } catch (err) {
    if (err instanceof ApiInputError) return apiError(400, err.code, err.message);
    console.error('[Public API Error]:', err);
    return apiError(500, 'internal_error', 'Something went wrong. Try again.');
  }
}

/* ── Input ────────────────────────────────────────────────────────────── */

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new ApiInputError('invalid_json', 'The request body must be a JSON object.');
}

export const MAX_MESSAGE_LENGTH = 4000;

export function messageContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiInputError('invalid_content', '"content" must be a non-empty string.');
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    throw new ApiInputError('content_too_long', `"content" can be at most ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new ApiInputError('invalid_field', `"${field}" must be a string of at most ${max} characters.`);
  }
  return value.trim() || null;
}

export interface VisitorInput {
  externalId: string | null;
  name: string | null;
  email: string | null;
}

export function visitorInput(value: unknown): VisitorInput {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const email = optionalString(v.email, 'visitor.email', 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiInputError('invalid_field', '"visitor.email" is not an email address.');
  }
  return {
    externalId: optionalString(v.external_id, 'visitor.external_id', 200),
    name: optionalString(v.name, 'visitor.name', 120),
    email,
  };
}

/* ── Visitors and conversations ───────────────────────────────────────── */

/**
 * The visitor for this integration's user: found again by external_id, so a
 * returning user keeps their history and the inbox shows one person.
 */
export async function findOrCreateVisitor(workspaceId: string, input: VisitorInput): Promise<string> {
  const supabase = serviceClient();
  const channelUserId = input.externalId ? `api:${input.externalId}` : null;
  if (channelUserId) {
    const { data: existing } = await supabase
      .from('visitors')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('channel_user_id', channelUserId)
      .maybeSingle();
    if (existing) {
      const patch: Record<string, unknown> = { last_seen: new Date().toISOString() };
      if (input.name) patch.name = input.name;
      if (input.email) patch.email = input.email;
      const { error } = await supabase.from('visitors').update(patch).eq('id', existing.id);
      if (error) console.warn('[Public API] Could not update visitor:', error.message);
      return existing.id as string;
    }
  }
  const { data, error } = await supabase
    .from('visitors')
    .insert({
      workspace_id: workspaceId,
      name: input.name,
      email: input.email,
      channel_user_id: channelUserId,
      last_seen: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error || !data) throw error || new Error('Visitor not created');
  return data.id as string;
}

export interface ApiConversation {
  id: string;
  workspace_id: string;
  visitor_id: string;
  status: string;
  ai_mode: string | null;
  ai_paused_reason: string | null;
  created_at: string;
  channel_metadata: Record<string, unknown> | null;
}

/** A conversation this key may touch: its workspace's, started through the API. */
export async function loadApiConversation(caller: ApiCaller, conversationId: string): Promise<ApiConversation | null> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  const { data } = await serviceClient()
    .from('conversations')
    .select('id, workspace_id, visitor_id, status, ai_mode, ai_paused_reason, created_at, channel_metadata')
    .eq('id', conversationId)
    .eq('workspace_id', caller.workspaceId)
    .maybeSingle();
  const conv = data as ApiConversation | null;
  if (!conv || conv.channel_metadata?.source !== 'api') return null;
  return conv;
}

export async function createApiConversation(caller: ApiCaller, visitorId: string, metadata: Record<string, unknown>) {
  const { data, error } = await serviceClient()
    .from('conversations')
    .insert({
      workspace_id: caller.workspaceId,
      visitor_id: visitorId,
      status: 'open',
      ai_mode: 'autopilot',
      channel_metadata: { source: 'api', api_key_id: caller.keyId, ...metadata },
    })
    .select('id, workspace_id, visitor_id, status, ai_mode, ai_paused_reason, created_at, channel_metadata')
    .single();
  if (error || !data) throw error || new Error('Conversation not created');
  return data as ApiConversation;
}

/* ── Messages ─────────────────────────────────────────────────────────── */

export type MessageRole = 'customer' | 'bot' | 'agent' | 'system';

export interface PublicMessage {
  id: string;
  role: MessageRole;
  content: string;
  attachment_url: string | null;
  created_at: string;
}

interface MessageRow {
  id: string;
  sender_type: string;
  sender_id: string | null;
  content: string;
  attachment_url: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/** What an outside system may see of a message. Internal notes never get here. */
export function publicMessage(m: MessageRow): PublicMessage {
  const role: MessageRole =
    m.sender_type === 'visitor'
      ? 'customer'
      : m.sender_type === 'ai'
      ? m.metadata?.system_event
        ? 'system'
        : 'bot'
      : m.sender_type === 'agent' && m.sender_id
      ? 'agent'
      : m.sender_type === 'agent'
      ? 'bot'
      : 'system';
  return { id: m.id, role, content: m.content, attachment_url: m.attachment_url ?? null, created_at: m.created_at };
}

/** Public messages of a conversation, oldest first, optionally after a message. */
export async function listMessages(conversationId: string, opts: { after?: string | null; limit?: number } = {}) {
  const supabase = serviceClient();
  let afterAt: string | null = null;
  if (opts.after) {
    const { data: anchor } = await supabase
      .from('messages')
      .select('created_at')
      .eq('id', opts.after)
      .eq('conversation_id', conversationId)
      .maybeSingle();
    if (!anchor) throw new ApiInputError('invalid_cursor', '"after" is not a message of this conversation.');
    afterAt = anchor.created_at as string;
  }
  let query = supabase
    .from('messages')
    .select('id, sender_type, sender_id, content, attachment_url, created_at, metadata')
    .eq('conversation_id', conversationId)
    .eq('is_internal', false)
    .order('created_at', { ascending: true })
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 100));
  if (afterAt) query = query.gt('created_at', afterAt);
  const { data, error } = await query;
  if (error) throw error;
  return ((data || []) as MessageRow[]).map(publicMessage);
}

/**
 * Stores the customer's message and, unless told not to wait, runs the bot
 * the same way the widget does and returns whatever the conversation received
 * after it (the bot's answer, a handover notice). A person may answer later;
 * fetch those with listMessages.
 */
export async function sendCustomerMessage(
  caller: ApiCaller,
  conv: ApiConversation,
  content: string,
  waitForReply: boolean
): Promise<{ message: PublicMessage; replies: PublicMessage[]; bot: { replied: boolean; reason: string | null } }> {
  // A message on a closed conversation reopens it, exactly as in the widget
  // (handle_new_message and the ticket rules do that in the database).
  const { data, error } = await serviceClient()
    .from('messages')
    .insert({ conversation_id: conv.id, sender_type: 'visitor', content, is_internal: false })
    .select('id, sender_type, sender_id, content, attachment_url, created_at, metadata')
    .single();
  if (error || !data) throw error || new Error('Message not stored');
  const message = publicMessage(data as MessageRow);

  const run = () =>
    autoRespond(
      new Request('http://internal/api/ai/auto-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conv.id, workspace_id: caller.workspaceId, message_id: message.id }),
      }) as Parameters<typeof autoRespond>[0]
    );

  if (!waitForReply) {
    run().catch((err) => console.error('[Public API] Bot run failed:', err));
    return { message, replies: [], bot: { replied: false, reason: 'not_waited' } };
  }

  let bot = { replied: false, reason: null as string | null };
  try {
    const res = await run();
    const body = (await res.json()) as { replied?: boolean; code?: string; reason?: string };
    bot = { replied: Boolean(body.replied), reason: body.replied ? null : body.code || body.reason || null };
  } catch (err) {
    console.error('[Public API] Bot run failed:', err);
    bot = { replied: false, reason: 'bot_error' };
  }
  const replies = await listMessages(conv.id, { after: message.id });
  return { message, replies, bot };
}

/** Who is answering, in words an integrator can show. */
export function conversationState(conv: ApiConversation) {
  return {
    id: conv.id,
    status: conv.status,
    created_at: conv.created_at,
    answered_by: conv.ai_mode === 'disabled' ? 'team' : 'bot',
    ai_paused_reason: conv.ai_mode === 'disabled' ? conv.ai_paused_reason : null,
  };
}
