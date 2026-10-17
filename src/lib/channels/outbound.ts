import { serviceClient } from '@/lib/supabase/service';
import { getAdapter } from './registry';
import { loadEmailSendContext } from './email/outbound-context';
import { loadConnection, recordConnectionError, updateConnection } from './store';
import { withFreshCredentials } from './refresh';
import { isPublicSender } from './public';
import type { OutboundContent, OutboundMedia, PublicTarget, SendResult } from './types';

/**
 * The outbound worker. A trigger queues every public agent or bot message on
 * a channel conversation (channel_outbound_queue); this claims due rows,
 * sends each through the channel's adapter, and records the outcome. The
 * database decides retries and backoff (fn_complete_channel_outbound).
 *
 * It runs right after a reply is written (so customers get it at once) and
 * from a cron (so retries and anything a crashed worker left behind still go
 * out). Claiming uses SKIP LOCKED, so both can run at the same time.
 */

interface QueueRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string;
  channel: string;
  attempts: number;
}

interface MessageRow {
  id: string;
  content: string | null;
  attachment_url: string | null;
  metadata: Record<string, unknown> | null;
  reply_to_message_id: string | null;
}

/** What WhatsApp should call a file, from its URL. */
export function mediaKindForUrl(url: string): OutboundMedia['kind'] {
  const path = url.split('?')[0].toLowerCase();
  if (/\.(jpe?g|png)$/.test(path)) return 'image';
  if (/\.(mp4|3gp)$/.test(path)) return 'video';
  if (/\.(mp3|ogg|opus|aac|amr|m4a)$/.test(path)) return 'audio';
  if (/\/image\/upload\//.test(path) && !/\.(gif|webp|svg|pdf)$/.test(path)) return 'image';
  if (/\/video\/upload\//.test(path) && !/\.(mp3|ogg|wav)$/.test(path)) return 'video';
  return 'document';
}

interface TemplateMeta {
  name?: unknown;
  language?: unknown;
  body_params?: unknown;
}

/** Decides what to send for a stored message: a template, a file, or text. */
export function contentForMessage(
  msg: MessageRow,
  replyToExternalId?: string | null
): { kind: 'content'; content: OutboundContent } | { kind: 'media'; media: OutboundMedia } {
  const template = (msg.metadata?.channel_template || null) as TemplateMeta | null;
  if (template && typeof template.name === 'string' && typeof template.language === 'string') {
    const params = Array.isArray(template.body_params) ? template.body_params.map(String) : [];
    return { kind: 'content', content: { type: 'template', template: { name: template.name, language: template.language, bodyParams: params } } };
  }
  // Set by the database when Instagram's Human Agent window applies.
  const tag = msg.metadata?.channel_tag === 'HUMAN_AGENT' ? ('HUMAN_AGENT' as const) : undefined;
  if (msg.attachment_url) {
    const kind = mediaKindForUrl(msg.attachment_url);
    const caption = (msg.content || '').trim();
    const filename = decodeURIComponent(msg.attachment_url.split('?')[0].split('/').pop() || 'file');
    return { kind: 'media', media: { kind, url: msg.attachment_url, caption: caption || undefined, filename, ...(tag ? { tag } : {}) } };
  }
  return {
    kind: 'content',
    content: { type: 'text', text: msg.content || '', replyToExternalId: replyToExternalId || undefined, ...(tag ? { tag } : {}) },
  };
}

/**
 * The public item a reply answers: the message the agent chose to reply to,
 * or else the newest public item from the customer.
 */
export async function resolvePublicTarget(conversationId: string, replyToMessageId: string | null): Promise<PublicTarget | null> {
  const sb = serviceClient();
  const fromMeta = (m: { metadata: Record<string, unknown> | null } | null | undefined) =>
    ((m?.metadata?.channel_public as PublicTarget | undefined) || null);
  if (replyToMessageId) {
    const { data } = await sb.from('messages').select('metadata').eq('id', replyToMessageId).eq('conversation_id', conversationId).maybeSingle();
    const chosen = fromMeta(data as { metadata: Record<string, unknown> | null } | null);
    if (chosen) return chosen;
  }
  const { data } = await sb
    .from('messages')
    .select('metadata')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'visitor')
    .order('created_at', { ascending: false })
    .limit(10);
  for (const m of (data as { metadata: Record<string, unknown> | null }[] | null) || []) {
    const target = fromMeta(m);
    if (target) return target;
  }
  return null;
}

type Attempt = SendResult & { connectionId?: string; connectionStatus?: string };

async function sendOne(row: QueueRow): Promise<Attempt> {
  const sb = serviceClient();
  const adapter = getAdapter(row.channel);
  if (!adapter) return { ok: false, error: `No adapter for channel "${row.channel}".`, retryable: false };

  const [{ data: msg }, { data: conv }] = await Promise.all([
    sb.from('messages').select('id, content, attachment_url, metadata, reply_to_message_id').eq('id', row.message_id).maybeSingle(),
    sb.from('conversations').select('channel_user_id, workspace_id').eq('id', row.conversation_id).maybeSingle(),
  ]);
  if (!msg) return { ok: false, error: 'The message was deleted.', retryable: false };
  if (!conv?.channel_user_id || conv.workspace_id !== row.workspace_id) {
    return { ok: false, error: 'This conversation has no customer address on the channel.', retryable: false };
  }

  let conn = await loadConnection<unknown>(row.workspace_id, row.channel);
  if (!conn || conn.connection.status === 'disconnected') {
    return { ok: false, error: `${adapter.label} is not connected. Connect it in Settings → Channels.`, retryable: false };
  }
  try {
    conn = await withFreshCredentials(conn);
  } catch (err) {
    return { ok: false, error: `Could not renew the ${adapter.label} sign-in: ${(err as Error).message}. Reconnect it in Settings → Channels.`, retryable: false, needsAttention: true };
  }

  // A conversation with a public sender (X mention, Threads reply, LinkedIn or
  // TikTok comment) is answered in public, under the item it is about.
  let publicTarget: PublicTarget | null = null;
  if (isPublicSender(conv.channel_user_id)) {
    publicTarget = await resolvePublicTarget(row.conversation_id, (msg as MessageRow).reply_to_message_id);
    if (!publicTarget) {
      return { ok: false, error: 'There is no public post, comment or reply in this conversation to answer.', retryable: false };
    }
  }

  let replyTo: string | null = null;
  if ((msg as MessageRow).reply_to_message_id) {
    const { data } = await sb.from('messages').select('channel_message_id').eq('id', (msg as MessageRow).reply_to_message_id).maybeSingle();
    replyTo = data?.channel_message_id || null;
  }

  const what = contentForMessage(msg as MessageRow, replyTo);
  if (row.channel === 'email') {
    // Email threads by headers, so the adapter needs the ticket and the Message-IDs so far.
    const email = await loadEmailSendContext(row);
    if (what.kind === 'media') what.media.email = email;
    else if (what.content.type === 'text') what.content.email = email;
  }
  if (publicTarget && what.kind === 'content' && what.content.type === 'text') what.content.publicTarget = publicTarget;
  const result =
    what.kind === 'media'
      ? await adapter.sendMedia(conn, conv.channel_user_id, what.media)
      : await adapter.sendMessage(conn, conv.channel_user_id, what.content);
  if (result.ok && publicTarget) {
    // Remember that this one went out in public, so the thread can say so.
    await sb
      .from('messages')
      .update({ metadata: { ...((msg as MessageRow).metadata || {}), channel_visibility: 'public' } })
      .eq('id', (msg as MessageRow).id);
  }
  if (result.ok) {
    // The business answering means the customer's messages were read: show them the blue ticks.
    const { data: last } = await sb
      .from('messages')
      .select('channel_message_id')
      .eq('conversation_id', row.conversation_id)
      .eq('sender_type', 'visitor')
      .not('channel_message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last?.channel_message_id) await adapter.markRead(conn, last.channel_message_id);
  }
  return { ...result, connectionId: conn.connection.id, connectionStatus: conn.connection.status };
}

export interface ProcessSummary {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
}

export async function processOutboundQueue(opts: { messageId?: string; limit?: number } = {}): Promise<ProcessSummary> {
  const sb = serviceClient();
  const summary: ProcessSummary = { claimed: 0, sent: 0, retrying: 0, failed: 0 };
  const { data, error } = await sb.rpc('fn_claim_channel_outbound', {
    p_limit: opts.limit ?? 20,
    p_message_id: opts.messageId ?? null,
  });
  if (error) {
    console.error('[Channels] Could not claim outbound messages:', error.message);
    return summary;
  }
  const rows = (data as QueueRow[]) || [];
  summary.claimed = rows.length;

  for (const row of rows) {
    let result: Attempt;
    try {
      result = await sendOne(row);
    } catch (err) {
      result = { ok: false, error: (err as Error).message || 'Could not send.', retryable: true };
    }

    const { data: outcome, error: completeError } = await sb.rpc('fn_complete_channel_outbound', {
      p_id: row.id,
      p_ok: result.ok,
      p_provider_message_id: result.ok ? result.providerMessageId : null,
      p_error: result.ok ? null : result.error,
      p_retryable: result.ok ? false : result.retryable,
    });
    if (completeError) {
      // The row stays 'sending' and is reclaimed after its lock expires.
      console.error('[Channels] Could not record the send outcome:', completeError.message);
      continue;
    }
    if (outcome === 'sent') summary.sent++;
    else if (outcome === 'queued') summary.retrying++;
    else summary.failed++;

    if (result.connectionId) {
      if (!result.ok && !result.windowClosed) {
        await recordConnectionError(result.connectionId, result.error, Boolean(result.needsAttention));
      } else if (result.ok && result.connectionStatus === 'needs_attention') {
        // A successful send proves the connection works again.
        await updateConnection(result.connectionId, { status: 'connected' });
      }
    }
  }
  return summary;
}
