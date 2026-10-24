import type { SupabaseClient } from '@supabase/supabase-js';
import type { Conversation } from '@/types/database';

/**
 * The questions the bot handed to the team, for the Handovers screen.
 *
 * Nothing new is stored for this. Every handover already leaves a private
 * note (executeHandoverToHuman in anthropic.ts: `metadata.is_handover`, the
 * reason, the priority, `reply_to_message_id` = the visitor's message) and
 * marks the conversation as needing a person (`ai_needs_attention_at`, or the
 * bot switched off with `needs_attention` / `human_requested`). A person's
 * public reply clears both in the database (fn_human_reply_takes_over), so
 * "is somebody still waiting?" is read from the conversation, never guessed
 * here.
 */

export type HandoverState = 'waiting' | 'answered' | 'closed';

export interface HandoverItem {
  /** The handover note's id. */
  id: string;
  conversationId: string;
  at: string;
  state: HandoverState;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  /** What the customer asked, in their own words. */
  question: string;
  /** Why the bot stepped aside, in plain words. */
  reason: string | null;
  /** The bot's reading of the request ("Payout question", "Wants a person"). */
  topic: string | null;
  summary: string | null;
  /** Earlier lines from the customer, for context. */
  earlier: string | null;
  /** Order / account / email the customer already gave. */
  given: string | null;
  frustrated: boolean;
  language: string | null;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  visitorName: string | null;
  visitorEmail: string | null;
  channel: string | null;
}

export interface ParsedHandoverNote {
  topic: string | null;
  reason: string | null;
  question: string | null;
  summary: string | null;
  earlier: string | null;
  given: string | null;
  frustrated: boolean;
  language: string | null;
}

/**
 * Reads the note buildHandoverSummary (intent.ts) writes:
 *   🤖 Bot handover: <intent label>
 *   Why: …  /  Visitor said: "…"  /  Summary: …  /  Earlier: …  /  Given: …
 *   Tone: frustrated / complaint  /  Language: …
 * Older notes are a single "Reason: …" line; anything unknown is ignored.
 */
export function parseHandoverNote(content: string | null | undefined): ParsedHandoverNote {
  const out: ParsedHandoverNote = {
    topic: null,
    reason: null,
    question: null,
    summary: null,
    earlier: null,
    given: null,
    frustrated: false,
    language: null,
  };
  for (const raw of (content || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:🤖\s*)?(Bot handover|Why|Reason|Visitor said|Summary|Earlier|Given|Tone|Language):\s*(.*)$/u);
    if (!m) continue;
    const value = m[2].trim();
    switch (m[1]) {
      case 'Bot handover':
        out.topic = value || null;
        break;
      case 'Why':
      case 'Reason':
        out.reason = out.reason ?? (value || null);
        break;
      case 'Visitor said':
        out.question = value.replace(/^"([\s\S]*)"$/, '$1') || null;
        break;
      case 'Summary':
        out.summary = value || null;
        break;
      case 'Earlier':
        out.earlier = value || null;
        break;
      case 'Given':
        out.given = value || null;
        break;
      case 'Tone':
        out.frustrated = /frustrat|complain/i.test(value);
        break;
      case 'Language':
        out.language = value || null;
        break;
    }
  }
  return out;
}

type ConversationBits = Pick<
  Conversation,
  'status' | 'ai_paused_reason' | 'ai_needs_attention_at' | 'channel_metadata'
>;

/** Whether the customer behind a handover made at `at` is still waiting for a person. */
export function handoverState(conv: ConversationBits, at: string): HandoverState {
  const lastHuman = (conv.channel_metadata as Record<string, unknown> | null)?.last_human_reply_at;
  if (typeof lastHuman === 'string' && lastHuman >= at) return 'answered';
  if (conv.status === 'closed') return 'closed';
  if (conv.ai_needs_attention_at || conv.ai_paused_reason === 'needs_attention' || conv.ai_paused_reason === 'human_requested') {
    return 'waiting';
  }
  // A person took it over some other way (paused the bot, replied from a
  // channel before last_human_reply_at existed): nobody is left waiting.
  return 'answered';
}

/** True when the conversation has a handover nobody has answered yet: the sidebar badge. */
export function isWaitingForPerson(conv: ConversationBits): boolean {
  if (conv.status === 'closed') return false;
  return Boolean(
    conv.ai_needs_attention_at || conv.ai_paused_reason === 'needs_attention' || conv.ai_paused_reason === 'human_requested'
  );
}

/** Plain-words reason for the card; the raw text stays in the tooltip. */
export function friendlyReason(reason: string | null): string | null {
  if (!reason) return null;
  const r = reason.toLowerCase();
  if (/anger|frustrat/.test(r)) return 'Customer is upset';
  if (/asked for a person|wants? (a )?(human|person)|human requested|speak (to|with)/.test(r)) return 'Asked for a person';
  if (/partly answered/.test(r)) return 'Partly answered';
  if (/not in the help cent|no article|not covered|named no source|do not answer/.test(r)) return 'Not in the help center';
  if (/repeated|did not help|failures|maximum attempts/.test(r)) return "Bot's answer didn't help";
  if (/switched off/.test(r)) return 'Topic handled by the team';
  if (/promised/.test(r)) return 'Waiting for a promised update';
  if (/limit|plan|unavailable/.test(r)) return 'Bot unavailable';
  if (/account|order|verified/.test(r)) return 'Needs an account check';
  return null;
}

const PRIORITY_RANK: Record<HandoverItem['priority'], number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Waiting first, then the most urgent, then whoever has waited longest. */
export function sortHandovers(items: HandoverItem[]): HandoverItem[] {
  return [...items].sort((a, b) => {
    const wa = a.state === 'waiting' ? 0 : 1;
    const wb = b.state === 'waiting' ? 0 : 1;
    if (wa !== wb) return wa - wb;
    if (a.state === 'waiting') {
      const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (p !== 0) return p;
      return a.at.localeCompare(b.at);
    }
    return b.at.localeCompare(a.at);
  });
}

/**
 * The last `days` of handovers in one workspace, read as the signed-in agent
 * (RLS keeps it to their workspace; the filter says so too). One card per
 * handover note; a conversation handed over twice shows both questions.
 */
export async function loadHandovers(
  supabase: SupabaseClient,
  workspaceId: string,
  { days = 14, limit = 300 }: { days?: number; limit?: number } = {}
): Promise<HandoverItem[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('messages')
    .select(
      'id, content, created_at, reply_to_message_id, metadata, conversation:conversations!inner(id, workspace_id, status, priority, channel, ai_paused_reason, ai_needs_attention_at, channel_metadata, assigned_agent_id, visitor:visitors(name, email))'
    )
    .eq('is_internal', true)
    .eq('metadata->>is_handover', 'true')
    .eq('conversation.workspace_id', workspaceId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  type Embedded<T> = T | T[] | null;
  type Row = {
    id: string;
    content: string | null;
    created_at: string;
    reply_to_message_id: string | null;
    metadata: Record<string, unknown> | null;
    conversation: Embedded<
      ConversationBits & {
        id: string;
        priority: HandoverItem['priority'] | null;
        channel: string | null;
        assigned_agent_id: string | null;
        visitor: Embedded<{ name: string | null; email: string | null }>;
      }
    >;
  };
  const one = <T,>(v: Embedded<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v);
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const rows = (data || []) as unknown as Row[];
  const questionIds = Array.from(new Set(rows.map((r) => r.reply_to_message_id).filter(Boolean))) as string[];
  const questions = new Map<string, string>();
  for (let i = 0; i < questionIds.length; i += 100) {
    const { data: qs, error: qErr } = await supabase
      .from('messages')
      .select('id, content')
      .in('id', questionIds.slice(i, i + 100));
    if (qErr) throw qErr;
    for (const q of qs || []) questions.set(q.id, q.content || '');
  }

  const items = rows.map((r): HandoverItem => {
    const conv = one(r.conversation);
    const visitor = conv ? one(conv.visitor) : null;
    const meta = r.metadata || {};
    const note = parseHandoverNote(r.content);
    const metaPriority = str(meta.priority);
    const priority =
      (metaPriority && ['low', 'normal', 'high', 'urgent'].includes(metaPriority) ? metaPriority : conv?.priority) || 'normal';
    return {
      id: r.id,
      conversationId: conv?.id ?? '',
      at: r.created_at,
      state: conv ? handoverState(conv, r.created_at) : 'closed',
      priority: priority as HandoverItem['priority'],
      question: (r.reply_to_message_id && questions.get(r.reply_to_message_id)) || note.question || 'The customer asked for help.',
      reason: note.reason || str(meta.reason),
      topic: note.topic,
      summary: note.summary,
      earlier: note.earlier,
      given: note.given,
      frustrated: note.frustrated,
      language: note.language,
      assignedAgentId: conv?.assigned_agent_id ?? str(meta.assigned_agent_id),
      // The note names who it went to then; the name only matches while they still have it.
      assignedAgentName: conv?.assigned_agent_id && conv.assigned_agent_id !== str(meta.assigned_agent_id) ? null : str(meta.assigned_agent_name),
      visitorName: visitor?.name ?? null,
      visitorEmail: visitor?.email ?? null,
      channel: conv?.channel ?? null,
    };
  });
  return sortHandovers(items.filter((i) => i.conversationId));
}
