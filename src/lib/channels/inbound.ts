import { serviceClient } from '@/lib/supabase/service';
import { isCloudinaryConfigured, uploadToCloudinary } from '@/lib/cloudinary';
import { getAdapter } from './registry';
import { loadConnectionByAccount, loadConnectionById, updateConnection, type LoadedConnection } from './store';
import type { ChannelAdapter, ChannelEvent, InboundMessageEvent } from './types';
import { userError } from '@/lib/errors/user-error';

/**
 * Everything a channel webhook does, independent of the HTTP framework:
 * verify, parse, route each event to its workspace's connection, store it,
 * and list the slow follow-ups (media download, the bot) for the route to
 * run after it has answered.
 *
 * Providers retry any delivery that does not get a 2xx, for days. So: a bad
 * signature is 401 (never retried into success); a payload we cannot use is
 * 200 (retrying it would not help); a database failure is 500 so the
 * provider retries, which is safe because fn_channel_ingest_inbound ignores
 * a message id it has already stored.
 */

export interface WebhookOutcome {
  status: number;
  body: string;
  /** Work to run after the response is sent. */
  followUps: (() => Promise<void>)[];
}

/** Secrets for webhooks that arrive at the shared platform URL (embedded signup). */
export function platformWebhookSecrets(channel: string): { appSecret?: string; verifyToken?: string } {
  if (channel === 'whatsapp') {
    return { appSecret: process.env.META_APP_SECRET, verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN };
  }
  if (channel === 'instagram') {
    return { appSecret: process.env.INSTAGRAM_APP_SECRET, verifyToken: process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN };
  }
  // X signs with the app's consumer (API) secret, TikTok and LinkedIn with the app's client secret.
  if (channel === 'x') return { appSecret: process.env.X_API_SECRET };
  if (channel === 'tiktok') return { appSecret: process.env.TIKTOK_CLIENT_SECRET };
  if (channel === 'linkedin') return { appSecret: process.env.LINKEDIN_CLIENT_SECRET };
  if (channel === 'threads') return { appSecret: process.env.THREADS_APP_SECRET, verifyToken: process.env.THREADS_WEBHOOK_VERIFY_TOKEN };
  return {};
}

interface Creds {
  appSecret?: string;
  verifyToken?: string;
}

export async function handleWebhookChallenge(
  channel: string,
  query: URLSearchParams,
  connectionId?: string
): Promise<{ status: number; body: string; contentType?: string }> {
  const adapter = getAdapter(channel);
  if (!adapter) return { status: 404, body: 'Unknown channel' };
  // X and TikTok prove ownership of the URL with a signed JSON answer, not an echoed token.
  if (adapter.respondToChallenge) {
    const secret = platformWebhookSecrets(channel).appSecret;
    if (!secret) return { status: 403, body: 'Webhook verification is not configured' };
    const answer = adapter.respondToChallenge(query, secret);
    return answer ? { status: 200, body: answer.body, contentType: answer.contentType } : { status: 403, body: 'Verification failed' };
  }
  let expected = platformWebhookSecrets(channel).verifyToken;
  let connection: LoadedConnection<Creds> | null = null;
  if (connectionId) {
    connection = await loadConnectionById<Creds>(connectionId).catch(() => null);
    expected = connection?.credentials.verifyToken;
  }
  if (!expected) return { status: 403, body: 'Webhook verification is not configured' };
  const challenge = adapter.verifyWebhookChallenge(query, expected);
  if (challenge === null) return { status: 403, body: 'Verification token mismatch' };
  if (connection) {
    await updateConnection(connection.connection.id, {
      settings: { ...connection.connection.settings, webhook_verified_at: new Date().toISOString() },
    });
  }
  return { status: 200, body: challenge };
}

function metadataFor(event: InboundMessageEvent): Record<string, unknown> {
  return {
    channel_type: event.type,
    ...(event.media ? { channel_media: event.media } : {}),
    ...(event.replyToExternalId ? { channel_reply_to: event.replyToExternalId } : {}),
    ...(event.story ? { channel_story: event.story } : {}),
    ...(event.public ? { channel_public: event.public } : {}),
  };
}

export async function handleWebhookPost(params: {
  channel: string;
  rawBody: string;
  headers: Headers;
  connectionId?: string;
  /** Where this app is reachable, to hand messages to the bot. */
  origin: string;
}): Promise<WebhookOutcome> {
  const { channel, rawBody, headers, connectionId, origin } = params;
  const followUps: WebhookOutcome['followUps'] = [];
  const adapter = getAdapter(channel);
  if (!adapter) return { status: 404, body: 'Unknown channel', followUps };

  // Which secret signs this delivery: the connection's own app (manual
  // setup) or the platform app (embedded signup).
  let pinned: LoadedConnection<Creds> | null = null;
  let secret = platformWebhookSecrets(channel).appSecret;
  if (connectionId) {
    pinned = await loadConnectionById<Creds>(connectionId).catch(() => null);
    if (!pinned || pinned.connection.channel !== channel) return { status: 404, body: 'Unknown connection', followUps };
    secret = pinned.credentials.appSecret || secret;
  }
  if (!secret) {
    console.error(`[Channels] No app secret to verify ${channel} webhooks; set META_APP_SECRET.`);
    return { status: 401, body: 'Signature cannot be verified', followUps };
  }
  if (!adapter.verifyWebhookSignature({ rawBody, headers }, secret)) {
    return { status: 401, body: 'Invalid signature', followUps };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 200, body: 'Ignored: not JSON', followUps };
  }

  const events = adapter.parseWebhook(body);
  const cache = new Map<string, LoadedConnection<Creds> | null>();
  const connectionFor = async (accountId: string) => {
    if (pinned) return pinned.connection.external_account_id === accountId ? pinned : null;
    if (!cache.has(accountId)) cache.set(accountId, await loadConnectionByAccount<Creds>(channel, accountId));
    return cache.get(accountId) || null;
  };

  let failed = 0;
  for (const event of events) {
    const conn = await connectionFor(event.accountId);
    if (!conn || conn.connection.status === 'disconnected') {
      // Not ours (another workspace's number on a shared app, or disconnected): drop it.
      continue;
    }
    try {
      const followUp = await storeEvent(adapter, conn, event, origin);
      if (followUp) followUps.push(followUp);
    } catch (err) {
      failed++;
      console.error(`[Channels] Could not store ${channel} ${event.kind} ${event.externalId}:`, err);
    }
  }

  if (failed) return { status: 500, body: 'Some events could not be stored; please retry', followUps };
  return { status: 200, body: 'EVENT_RECEIVED', followUps };
}

/** Stores one event from a webhook or a poll. Exported for the poller (./poll.ts). */
export async function storeEvent(
  adapter: ChannelAdapter<unknown, unknown>,
  conn: LoadedConnection<Creds>,
  event: ChannelEvent,
  origin: string
): Promise<(() => Promise<void>) | null> {
  const sb = serviceClient();
  if (event.kind === 'status') {
    const { error } = await sb.rpc('fn_channel_record_status', {
      p_channel_message_id: event.externalId,
      p_status: event.status,
      p_at: event.at.toISOString(),
      p_error: event.error ?? null,
    });
    if (error) throw userError(error.message);
    return null;
  }

  const { data, error } = await sb.rpc('fn_channel_ingest_inbound', {
    p_connection_id: conn.connection.id,
    p_sender_id: event.from,
    p_sender_name: event.fromName ?? null,
    p_external_id: event.externalId,
    p_content: event.text,
    p_attachment_url: null,
    p_metadata: metadataFor(event),
    p_sent_at: event.sentAt.toISOString(),
  });
  if (error) throw userError(error.message);
  const result = data as { duplicate: boolean; message_id: string; conversation_id?: string; workspace_id?: string; ai_mode?: string | null };
  if (result.duplicate) return null;

  return async () => {
    if (event.media && adapter.capabilities.media) {
      await attachMedia(adapter, conn, result.message_id, event.media.id, event.media.filename).catch((err) =>
        console.error('[Channels] Could not fetch inbound media:', err)
      );
    }
    if (event.story?.url) {
      await keepStory(adapter, conn, result.message_id, event.story.url, metadataFor(event)).catch((err) =>
        console.error('[Channels] Could not keep the story media:', err)
      );
    }
    if (!event.fromName && adapter.getSenderProfile) {
      await nameSender(adapter, conn, event.from).catch((err) => console.error('[Channels] Could not look up the sender:', err));
    }
    if ((result.ai_mode ?? 'autopilot') === 'autopilot' && result.conversation_id) {
      await fetch(`${origin}/api/ai/auto-respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: result.conversation_id, workspace_id: result.workspace_id, message_id: result.message_id }),
      }).catch((err) => console.error('[Channels] Could not hand the message to the bot:', err));
    }
  };
}

/** Copies an inbound file to our own storage: provider media URLs expire within minutes. */
async function attachMedia(
  adapter: ChannelAdapter<unknown, unknown>,
  conn: LoadedConnection<Creds>,
  messageId: string,
  mediaId: string,
  filename?: string
) {
  if (!isCloudinaryConfigured()) return;
  const file = await adapter.downloadMedia(conn, mediaId);
  const uploaded = await uploadToCloudinary(file.data, {
    folder: `channels/${conn.connection.workspace_id}`,
    filename,
    resourceType: file.mimeType.startsWith('image/') ? 'image' : 'auto',
  });
  const { error } = await serviceClient().from('messages').update({ attachment_url: uploaded.secure_url }).eq('id', messageId);
  if (error) throw userError(error.message);
}

/**
 * Stories disappear after a day, and so do their URLs: keep a copy so the
 * agent can still see what the customer replied to or mentioned.
 */
async function keepStory(
  adapter: ChannelAdapter<unknown, unknown>,
  conn: LoadedConnection<Creds>,
  messageId: string,
  storyUrl: string,
  metadata: Record<string, unknown>
) {
  if (!isCloudinaryConfigured()) return;
  const file = await adapter.downloadMedia(conn, storyUrl);
  const uploaded = await uploadToCloudinary(file.data, {
    folder: `channels/${conn.connection.workspace_id}/stories`,
    resourceType: file.mimeType.startsWith('image/') ? 'image' : 'auto',
  });
  const story = { ...(metadata.channel_story as Record<string, unknown>), media_url: uploaded.secure_url, media_type: file.mimeType };
  const { error } = await serviceClient()
    .from('messages')
    .update({ metadata: { ...metadata, channel_story: story } })
    .eq('id', messageId);
  if (error) throw userError(error.message);
}

/** Webhooks that carry only an id for the sender: give the visitor a readable name. */
async function nameSender(adapter: ChannelAdapter<unknown, unknown>, conn: LoadedConnection<Creds>, senderId: string) {
  const profile = await adapter.getSenderProfile!(conn, senderId);
  const name = profile?.name || (profile?.username ? `@${profile.username}` : null);
  if (!name) return;
  const { error } = await serviceClient()
    .from('visitors')
    .update({ name })
    .eq('workspace_id', conn.connection.workspace_id)
    .eq('channel', conn.connection.channel)
    .eq('channel_user_id', senderId)
    .eq('name', senderId);
  if (error) throw userError(error.message);
}
