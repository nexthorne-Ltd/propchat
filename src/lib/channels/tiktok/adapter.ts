import type { ChannelAdapter, ChannelContext, SendResult } from '@/lib/channels/types';
import { ChannelApiError, sendFailure } from '@/lib/channels/http';
import { charCount } from '@/lib/channels/public';
import { tiktokRequest } from './api';
import { parseTikTokWebhook, verifyTikTokSignature } from './webhook';
import { userError } from '@/lib/errors/user-error';

/**
 * TikTok on the TikTok API for Business: comments on the account's own
 * videos, in through a signed webhook and answered with a public reply.
 *
 * Needs a TikTok Business Account and a developer app approved for the
 * organic comment management APIs; access is granted by TikTok, not
 * self-service. Direct messages (the Business Messaging API) are not
 * implemented: that API is restricted to approved partners, is unavailable in
 * the EEA, UK and Switzerland, and its request and webhook schemas are only
 * visible once access is granted. See docs/CHANNELS.md.
 *
 * Because access cannot be self-served, this adapter has not been exercised
 * against the live API. The request and event shapes follow TikTok's
 * published reference for comment replies and the webhook signature scheme;
 * check them against a first real delivery.
 */

export interface TikTokCredentials {
  accessToken: string;
}

export interface TikTokConnectInput {
  /** The Business Account's id (open_id) returned with the access token. */
  businessId: string;
}

type Ctx = ChannelContext<TikTokCredentials>;

export const TIKTOK_MAX_LENGTH = 150;

export const tiktokAdapter: ChannelAdapter<TikTokCredentials, TikTokConnectInput> = {
  id: 'tiktok',
  label: 'TikTok',
  capabilities: {
    media: false,
    templates: false,
    readReceipts: false,
    serviceWindowHours: null,
    directMessages: false,
    publicReplies: true,
    maxReplyLength: TIKTOK_MAX_LENGTH,
  },

  async connect(input, credentials) {
    const businessId = (input.businessId || '').trim();
    const token = credentials.accessToken?.trim();
    if (!businessId) throw userError('Enter the Business Account id (open_id) that came with your access token.');
    if (!token) throw userError('Paste the access token for the TikTok Business Account.');
    let name = businessId;
    try {
      const res = await tiktokRequest<{ username?: string; display_name?: string }>(token, 'business/get/', {
        query: { business_id: businessId, fields: JSON.stringify(['username', 'display_name']) },
      });
      name = res.json.data?.username ? `@${res.json.data.username}` : res.json.data?.display_name || businessId;
    } catch (err) {
      if (err instanceof ChannelApiError) throw userError(err.failure.error);
      throw err;
    }
    return { externalAccountId: businessId, externalBusinessId: null, displayName: name, settings: { username: name.startsWith('@') ? name.slice(1) : null } };
  },

  verifyWebhookChallenge: () => null,
  verifyWebhookSignature: (req, secret) => verifyTikTokSignature(req.rawBody, req.headers.get('tiktok-signature'), secret),
  parseWebhook: parseTikTokWebhook,

  async sendMessage(ctx: Ctx, _to, content): Promise<SendResult> {
    if (content.type !== 'text') return { ok: false, error: 'TikTok does not support message templates.', retryable: false };
    const target = content.publicTarget;
    if (!target?.rootId) return { ok: false, error: 'Zentry can only answer TikTok comments; direct messages are not supported.', retryable: false };
    const text = content.text.trim();
    const n = charCount(text);
    if (!text) return { ok: false, error: 'There is nothing to send.', retryable: false };
    if (n > TIKTOK_MAX_LENGTH) return { ok: false, error: `This reply is ${n} characters; TikTok comments allow ${TIKTOK_MAX_LENGTH}. Shorten it and send again.`, retryable: false };
    const businessId = ctx.connection.external_account_id;
    if (!businessId) return { ok: false, error: 'The TikTok account id is missing. Reconnect TikTok.', retryable: false, needsAttention: true };
    try {
      const res = await tiktokRequest<{ comment_id?: string }>(ctx.credentials.accessToken, 'business/comment/reply/create/', {
        method: 'POST',
        json: { business_id: businessId, video_id: target.rootId, comment_id: target.itemId, text },
      });
      return { ok: true, providerMessageId: `tiktok:${res.json.data?.comment_id ?? `${target.itemId}:${Date.now()}`}` };
    } catch (err) {
      return sendFailure(err);
    }
  },
  async sendMedia() {
    return { ok: false, error: 'Replies on TikTok from Zentry are text only.', retryable: false };
  },
  async markRead() {},
  async downloadMedia() {
    throw userError('TikTok attachments are not downloaded.');
  },
  async listTemplates() {
    return [];
  },
  // The webhook is configured on the app in TikTok's portal, not per account.
  async disconnect() {},
};
