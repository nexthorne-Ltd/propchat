import type { ChannelAdapter, ChannelContext, OutboundContent, OutboundMedia, SendResult } from '@/lib/channels/types';
import { safeEqual, verifyMetaSignature } from '@/lib/channels/meta-signature';
import { IgError, igRequest } from './graph';
import { parseInstagramWebhook } from './webhook';
import { userError } from '@/lib/errors/user-error';

/**
 * Instagram direct messages through Meta's Instagram API with Instagram Login
 * (graph.instagram.com). Works with professional accounts (Business or
 * Creator); no Facebook Page is needed.
 *
 * Two ways in, like WhatsApp:
 *   - Business Login: the admin signs in with Instagram from Zentry; the
 *     platform's Instagram app (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET)
 *     receives webhooks at /api/channels/instagram/webhook.
 *   - Manual: a token generated in the customer's own Meta app dashboard,
 *     with their app secret; webhooks go to the connection's own URL.
 *
 * Long-lived tokens last 60 days; refreshCredentials renews them from the
 * daily cron while they are still valid.
 */

export interface InstagramCredentials {
  accessToken: string;
  /** Signs this connection's webhooks. Unset: the platform app (INSTAGRAM_APP_SECRET). */
  appSecret?: string;
  verifyToken?: string;
  /** ISO time the token stops working. */
  expiresAt?: string | null;
}

/** Nothing beyond the token: the account is whoever the token belongs to. */
export type InstagramConnectInput = Record<string, never>;

type Ctx = ChannelContext<InstagramCredentials>;

interface MeResponse {
  id?: string;
  user_id?: string;
  username?: string;
  name?: string;
  account_type?: string;
}

/** Plain-language reasons an account cannot be connected. */
export function eligibilityError(accountType: string | undefined): string | null {
  const t = (accountType || '').toUpperCase();
  if (t === 'BUSINESS' || t === 'MEDIA_CREATOR' || t === 'CREATOR') return null;
  if (t === 'PERSONAL') {
    return 'This is a personal Instagram account. In the Instagram app, go to Settings → Account type and tools → Switch to professional account (Business or Creator), then connect again.';
  }
  return 'Instagram did not confirm this is a professional (Business or Creator) account, so it cannot use messaging. Switch it to a professional account and try again.';
}

const ATTACHMENT_TYPE: Record<OutboundMedia['kind'], string> = { image: 'image', video: 'video', audio: 'audio', document: 'file' };

export function buildInstagramText(to: string, content: OutboundContent): Record<string, unknown> {
  if (content.type === 'template') {
    // Instagram has no message templates; the database never lets one through.
    throw userError('Instagram does not support message templates.');
  }
  return {
    recipient: { id: to },
    message: { text: content.text.slice(0, 1000) },
    ...(content.tag === 'HUMAN_AGENT' ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' } : {}),
  };
}

export function buildInstagramMedia(to: string, media: OutboundMedia, tag?: 'HUMAN_AGENT'): Record<string, unknown> {
  return {
    recipient: { id: to },
    message: { attachment: { type: ATTACHMENT_TYPE[media.kind], payload: { url: media.url } } },
    ...(tag === 'HUMAN_AGENT' ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' } : {}),
  };
}

async function send(ctx: Ctx, payload: Record<string, unknown>): Promise<SendResult> {
  try {
    const res = await igRequest<{ message_id?: string }>(ctx.credentials.accessToken, 'me/messages', { method: 'POST', body: payload });
    if (!res.message_id) return { ok: false, error: 'Instagram accepted the request but returned no message id.', retryable: true };
    return { ok: true, providerMessageId: res.message_id };
  } catch (err) {
    if (err instanceof IgError) {
      const f = err.failure;
      return { ok: false, error: f.error, retryable: f.retryable, needsAttention: f.needsAttention, windowClosed: f.windowClosed };
    }
    return { ok: false, error: (err as Error).message || 'Could not send.', retryable: true };
  }
}

const SUBSCRIBED_FIELDS = 'messages,messaging_seen';

export const instagramAdapter: ChannelAdapter<InstagramCredentials, InstagramConnectInput> = {
  id: 'instagram',
  label: 'Instagram',
  capabilities: { media: true, templates: false, readReceipts: true, serviceWindowHours: 24, humanAgentWindowHours: 24 * 7 },

  async connect(_input, credentials) {
    const token = credentials.accessToken?.trim();
    if (!token) throw userError('Paste an access token.');
    const me = await igRequest<MeResponse>(token, 'me', { query: { fields: 'user_id,username,name,account_type' } });
    const notEligible = eligibilityError(me.account_type);
    if (notEligible) throw userError(notEligible);
    const accountId = me.user_id || me.id;
    if (!accountId) throw userError('Instagram did not return the account id.');
    try {
      await igRequest(token, 'me/subscribed_apps', { method: 'POST', query: { subscribed_fields: SUBSCRIBED_FIELDS } });
    } catch (err) {
      const reason = err instanceof IgError ? err.failure.error : (err as Error).message;
      throw userError(
        `Instagram would not send this account's messages to Zentry (${reason}). Check the app has instagram_business_manage_messages, and that in the Instagram app Settings → Messages and story replies → Message controls → Connected tools → "Allow access to messages" is on.`
      );
    }
    return {
      externalAccountId: accountId,
      externalBusinessId: null,
      displayName: me.username ? `@${me.username}${me.name ? ` · ${me.name}` : ''}` : me.name || accountId,
      settings: {
        username: me.username || null,
        account_type: me.account_type || null,
        token_expires_at: credentials.expiresAt ?? null,
      },
    };
  },

  verifyWebhookChallenge(query, expectedToken) {
    const challenge = query.get('hub.challenge');
    if (query.get('hub.mode') !== 'subscribe' || !challenge) return null;
    return safeEqual(query.get('hub.verify_token') || '', expectedToken) ? challenge : null;
  },

  verifyWebhookSignature(req, secret) {
    return verifyMetaSignature(req.rawBody, req.headers.get('x-hub-signature-256'), secret);
  },

  parseWebhook: parseInstagramWebhook,

  sendMessage(ctx, to, content) {
    return send(ctx, buildInstagramText(to, content));
  },

  async sendMedia(ctx, to, media) {
    // Instagram attachments carry no caption: the text goes first, as its own message.
    if (media.caption) {
      const text = await send(ctx, buildInstagramText(to, { type: 'text', text: media.caption, tag: media.tag }));
      if (!text.ok) return text;
    }
    return send(ctx, buildInstagramMedia(to, media, media.tag));
  },

  // Instagram marks a whole thread seen (by customer id), not a message, and
  // shows the reply itself as activity; nothing to do per message.
  async markRead() {},

  async downloadMedia(_ctx, mediaUrl) {
    // Instagram webhooks carry a signed CDN URL rather than a media id.
    const res = await fetch(mediaUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw userError(`Media download failed with HTTP ${res.status}.`);
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type') || 'application/octet-stream' };
  },

  async listTemplates() {
    return [];
  },

  async disconnect(ctx) {
    await igRequest(ctx.credentials.accessToken, 'me/subscribed_apps', { method: 'DELETE' });
  },

  async getSenderProfile(ctx, senderId) {
    try {
      const p = await igRequest<{ name?: string; username?: string }>(ctx.credentials.accessToken, senderId, { query: { fields: 'name,username' } });
      return { name: p.name, username: p.username };
    } catch {
      // The customer may not allow profile access; their id stays as the name.
      return null;
    }
  },

  async refreshCredentials(ctx) {
    const expires = ctx.credentials.expiresAt ? Date.parse(ctx.credentials.expiresAt) : NaN;
    // Refresh in the last 10 days; Meta only refreshes tokens at least a day old that have not expired.
    if (Number.isNaN(expires) || expires - Date.now() > 10 * 86_400_000 || expires <= Date.now()) return null;
    const res = await igRequest<{ access_token?: string; expires_in?: number }>(ctx.credentials.accessToken, 'refresh_access_token', {
      versioned: false,
      query: { grant_type: 'ig_refresh_token', access_token: ctx.credentials.accessToken },
    });
    if (!res.access_token) return null;
    const expiresAt = new Date(Date.now() + (res.expires_in ?? 60 * 86_400) * 1000).toISOString();
    return {
      credentials: { ...ctx.credentials, accessToken: res.access_token, expiresAt },
      settings: { ...ctx.connection.settings, token_expires_at: expiresAt },
    };
  },
};
