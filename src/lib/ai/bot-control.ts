/**
 * Who answers a conversation: the bot or a person.
 *
 * The rules live in the database (migration 20261031090000): a person's
 * public reply takes the conversation over, only a person (or a resolution)
 * turns the bot back on, and fn_deliver_ai_reply refuses a bot reply when
 * control changed while it was being written. This module reads that state
 * for the auto-responder and the inbox, and records why the bot did or did
 * not answer.
 */
import type { serviceClient } from '@/lib/supabase/service';

type Service = ReturnType<typeof serviceClient>;

export type BotControlState =
  | 'ai_active'
  | 'ai_resuming'
  | 'needs_attention'
  | 'human_handling'
  | 'ai_paused'
  | 'human_requested';

export type AiPausedReason = 'human_reply' | 'agent_paused' | 'human_requested' | 'needs_attention' | 'system';

export interface BotControlFields {
  ai_mode?: string | null;
  ai_paused_reason?: string | null;
  ai_resumed_at?: string | null;
  ai_needs_attention_at?: string | null;
}

/**
 * The conversation's state, from its row and the time of the bot's last
 * public reply. "Resuming" is a bot that was switched back on and has not
 * answered since: its next reply must pick the conversation up where the
 * person left it, not start over.
 */
export function botControlState(conv: BotControlFields, lastBotReplyAt?: string | null): BotControlState {
  if (conv.ai_mode === 'disabled') {
    switch (conv.ai_paused_reason) {
      case 'human_reply':
        return 'human_handling';
      case 'human_requested':
        return 'human_requested';
      case 'needs_attention':
        return 'needs_attention';
      default:
        return 'ai_paused';
    }
  }
  if (conv.ai_needs_attention_at) return 'needs_attention';
  const resumed = conv.ai_resumed_at ? Date.parse(conv.ai_resumed_at) : NaN;
  const lastReply = lastBotReplyAt ? Date.parse(lastBotReplyAt) : -Infinity;
  if (!Number.isNaN(resumed) && resumed > lastReply) return 'ai_resuming';
  return 'ai_active';
}

/**
 * Whether the bot may send the visitor anything on its own. Read from the
 * switch, not the state: "needs attention" is both a bot that is still on but
 * handed a question over, and one that stepped aside.
 */
export function botMayReply(conv: BotControlFields): boolean {
  return conv.ai_mode !== 'disabled';
}

export const BOT_STATE_LABEL: Record<BotControlState, string> = {
  ai_active: 'AI active',
  ai_resuming: 'AI resuming',
  needs_attention: 'Needs attention',
  human_handling: 'Human handling',
  ai_paused: 'AI paused',
  human_requested: 'Human requested',
};

/** How a person's earlier reply is shown to the model, so it never takes it for its own. */
export const TEAM_MEMBER_PREFIX = '[Team member] ';

/**
 * Tells the team something without telling the visitor: an internal note and
 * a priority bump. For when a person owns the conversation and the bot must
 * stay quiet, but what the visitor said still needs someone's eyes.
 */
export async function notifyTeamOnly({
  supabase,
  conversationId,
  visitorMessageId,
  note,
}: {
  supabase: Service;
  conversationId: string;
  visitorMessageId: string;
  note: string;
}): Promise<void> {
  const { error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'ai',
    content: note,
    is_internal: true,
    reply_to_message_id: visitorMessageId,
    metadata: { is_handover: true, handover_for_message_id: visitorMessageId, reason: 'team_only_notice' },
  });
  // 23505: this visitor message already has its note (a retry).
  if (error && error.code !== '23505') {
    console.error('[Bot Control] Could not add the team note:', error.message);
    return;
  }
  const { error: convErr } = await supabase
    .from('conversations')
    .update({ priority: 'high', updated_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (convErr) console.error('[Bot Control] Could not raise the priority:', convErr.message);
}

/* ── Events ───────────────────────────────────────────────────────────── */

export type AiReplyEvent =
  | 'message_received'
  | 'processing_started'
  | 'reply_generated'
  | 'reply_delivered'
  | 'reply_suppressed'
  | 'handover'
  | 'provider_error'
  | 'route_error'
  /** What Jev decided (or would have, in shadow mode) about the intent. */
  | 'jev_intent'
  /** Jev's check of a drafted help-center answer against its passages. */
  | 'jev_grounding'
  /** A lookup specialist read the trader data endpoint (found / not_found / error). */
  | 'trader_lookup'
  /** A step of the in-chat email verification before a lookup (no email or code logged). */
  | 'trader_verification'
  /** Jev or the model picked the specialist where the router's rules were unsure. */
  | 'route_assist'
  /** A screenshot the visitor sent was read (vision.ts); no image text logged. */
  | 'image_read';

/**
 * Records a decision. Never throws and never blocks a reply: before the
 * migration has run the table does not exist, and a lost event is only a
 * lost log line. No message text goes in, only the decision and its reason.
 */
export async function logAiEvent(
  supabase: Service,
  event: {
    workspaceId: string;
    conversationId: string;
    visitorMessageId?: string | null;
    event: AiReplyEvent;
    reason?: string | null;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    const { error } = await supabase.from('ai_reply_events').insert({
      workspace_id: event.workspaceId,
      conversation_id: event.conversationId,
      visitor_message_id: event.visitorMessageId ?? null,
      event: event.event,
      reason: event.reason ?? null,
      detail: event.detail ?? {},
    });
    if (error) console.warn('[AI Events] Could not record event:', error.message);
  } catch (err) {
    console.warn('[AI Events] Could not record event:', (err as Error)?.message);
  }
}

/* ── Delivery ─────────────────────────────────────────────────────────── */

export type DeliveryResult =
  | { delivered: true; message: Record<string, unknown> }
  | { delivered: false; reason: string };

/** PostgREST / Postgres codes for "this function does not exist (yet)". */
const MISSING_FUNCTION = new Set(['PGRST202', '42883']);

/**
 * Sends a bot reply through fn_deliver_ai_reply, which refuses it when the
 * bot lost the conversation while the reply was being written. Returns null
 * when the function is not installed yet, so the caller can fall back to its
 * old insert until the migration runs.
 */
export async function deliverAiReply(
  supabase: Service,
  args: {
    conversationId: string;
    visitorMessageId: string;
    expectedVersion: number | null;
    content: string;
    metadata: Record<string, unknown>;
  }
): Promise<DeliveryResult | null> {
  const { data, error } = await supabase.rpc('fn_deliver_ai_reply', {
    p_conversation_id: args.conversationId,
    p_visitor_message_id: args.visitorMessageId,
    p_expected_version: args.expectedVersion,
    p_content: args.content,
    p_metadata: args.metadata,
  });
  if (error) {
    if (MISSING_FUNCTION.has(error.code || '')) return null;
    throw error;
  }
  const result = data as { delivered?: boolean; reason?: string; message?: Record<string, unknown> } | null;
  if (result?.delivered && result.message) return { delivered: true, message: result.message };
  return { delivered: false, reason: result?.reason || 'unknown' };
}
