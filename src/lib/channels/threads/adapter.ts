import type { ChannelAdapter, ChannelContext, ChannelEvent, PollResult, PollState, SendResult } from '@/lib/channels/types';
import { ChannelApiError, sendFailure } from '@/lib/channels/http';
import { safeEqual, verifyMetaSignature } from '@/lib/channels/meta-signature';
import { charCount, publicSender } from '@/lib/channels/public';
import { threadsRequest } from './api';
import { refreshThreadsToken } from './oauth';
import { parseThreadsWebhook } from './webhook';
import { userError } from '@/lib/errors/user-error';

/**
 * Threads on the official Threads API. There are no direct messages on
 * Threads; what the API offers is public:
 *
 *   - replies to the account's own posts, and public mentions of the account,
 *     arrive by webhook (needs App Review for Advanced Access). Replies are
 *     also polled from the account's recent posts, so a connection works
 *     before the webhook is approved;
 *   - the answer is a public reply under that item.
 *
 * Polling sees only top-level replies to posts from the last 7 days; replies
 * to replies and mentions need the webhook. Tokens last 60 days and are
 * renewed by the daily cron.
 */

export interface ThreadsCredentials {
  accessToken: string;
  expiresAt?: string | null;
}

type Ctx = ChannelContext<ThreadsCredentials>;

export const THREADS_MAX_LENGTH = 500;
const RECENT_POST_DAYS = 7;
const POSTS_PER_POLL = 10;

interface ThreadsList<T> {
  data?: T[];
}
interface ThreadsPost {
  id: string;
  timestamp?: string;
}
interface ThreadsReply {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  permalink?: string;
  is_reply_owned_by_me?: boolean;
}

export const threadsAdapter: ChannelAdapter<ThreadsCredentials, Record<string, never>> = {
  id: 'threads',
  label: 'Threads',
  capabilities: {
    media: false,
    templates: false,
    readReceipts: false,
    serviceWindowHours: null,
    directMessages: false,
    publicReplies: true,
    maxReplyLength: THREADS_MAX_LENGTH,
    pollIntervalSeconds: 300,
  },

  async connect(_input, credentials) {
    const token = credentials.accessToken?.trim();
    if (!token) throw userError('Threads did not return an access token.');
    let me;
    try {
      me = await threadsRequest<{ id?: string; username?: string; name?: string }>(token, 'me', { query: { fields: 'id,username,name' } });
    } catch (err) {
      if (err instanceof ChannelApiError) throw userError(err.failure.error);
      throw err;
    }
    if (!me.json.id) throw userError('Threads did not return the account id.');
    return {
      externalAccountId: me.json.id,
      externalBusinessId: null,
      displayName: me.json.username ? `@${me.json.username}${me.json.name ? ` · ${me.json.name}` : ''}` : me.json.name || me.json.id,
      settings: { username: me.json.username || null, token_expires_at: credentials.expiresAt ?? null, poll_state: { lastReplyAt: new Date().toISOString() } },
    };
  },

  verifyWebhookChallenge(query, expectedToken) {
    const challenge = query.get('hub.challenge');
    if (query.get('hub.mode') !== 'subscribe' || !challenge) return null;
    return safeEqual(query.get('hub.verify_token') || '', expectedToken) ? challenge : null;
  },
  verifyWebhookSignature: (req, secret) => verifyMetaSignature(req.rawBody, req.headers.get('x-hub-signature-256'), secret),
  parseWebhook: parseThreadsWebhook,

  async sendMessage(ctx: Ctx, _to, content): Promise<SendResult> {
    if (content.type !== 'text') return { ok: false, error: 'Threads does not support message templates.', retryable: false };
    if (!content.publicTarget) {
      return { ok: false, error: 'Threads has no direct messages. Replies are public replies under the customer’s post.', retryable: false };
    }
    const text = content.text.trim();
    const n = charCount(text);
    if (!text) return { ok: false, error: 'There is nothing to send.', retryable: false };
    if (n > THREADS_MAX_LENGTH) return { ok: false, error: `This reply is ${n} characters; Threads allows ${THREADS_MAX_LENGTH}. Shorten it and send again.`, retryable: false };
    const me = ctx.connection.external_account_id;
    if (!me) return { ok: false, error: 'The Threads account id is missing. Reconnect Threads.', retryable: false, needsAttention: true };
    try {
      // Two steps, like every Threads post: create a container, then publish it.
      const container = await threadsRequest<{ id?: string }>(ctx.credentials.accessToken, `${me}/threads`, {
        method: 'POST',
        form: { media_type: 'TEXT', text, reply_to_id: content.publicTarget.itemId },
      });
      if (!container.json.id) return { ok: false, error: 'Threads did not create the reply.', retryable: true };
      const published = await threadsRequest<{ id?: string }>(ctx.credentials.accessToken, `${me}/threads_publish`, {
        method: 'POST',
        form: { creation_id: container.json.id },
      });
      return published.json.id ? { ok: true, providerMessageId: `threads:${published.json.id}` } : { ok: false, error: 'Threads did not publish the reply.', retryable: true };
    } catch (err) {
      return sendFailure(err);
    }
  },
  async sendMedia() {
    return { ok: false, error: 'Replies on Threads from Zentry are text only.', retryable: false };
  },
  async markRead() {},
  async downloadMedia() {
    throw userError('Threads attachments are not downloaded.');
  },
  async listTemplates() {
    return [];
  },
  // Webhook subscriptions live on the app, not the account: nothing to undo here.
  async disconnect() {},

  async refreshCredentials(ctx) {
    const expires = ctx.credentials.expiresAt ? Date.parse(ctx.credentials.expiresAt) : NaN;
    // Meta only renews tokens that are at least a day old and not yet expired.
    if (Number.isNaN(expires) || expires - Date.now() > 10 * 86_400_000 || expires <= Date.now()) return null;
    const fresh = await refreshThreadsToken(ctx.credentials.accessToken);
    return { credentials: { accessToken: fresh.accessToken, expiresAt: fresh.expiresAt }, settings: { ...ctx.connection.settings, token_expires_at: fresh.expiresAt } };
  },

  async poll(ctx: Ctx, state: PollState): Promise<PollResult> {
    const me = ctx.connection.external_account_id;
    if (!me) return { events: [], state };
    const token = ctx.credentials.accessToken;
    const own = typeof ctx.connection.settings?.username === 'string' ? ctx.connection.settings.username.toLowerCase() : null;
    const sinceMs = Date.parse(typeof state.lastReplyAt === 'string' ? state.lastReplyAt : new Date().toISOString());
    const horizon = Date.now() - RECENT_POST_DAYS * 86_400_000;

    const posts = await threadsRequest<ThreadsList<ThreadsPost>>(token, 'me/threads', { query: { fields: 'id,timestamp', limit: String(POSTS_PER_POLL) } });
    const events: ChannelEvent[] = [];
    let newestMs = sinceMs;
    for (const post of posts.json.data || []) {
      if (post.timestamp && Date.parse(post.timestamp) < horizon) continue;
      const replies = await threadsRequest<ThreadsList<ThreadsReply>>(token, `${post.id}/replies`, {
        query: { fields: 'id,text,username,timestamp,permalink,is_reply_owned_by_me' },
      });
      for (const r of replies.json.data || []) {
        const username = r.username?.toLowerCase();
        // Threads writes times as 2026-10-01T10:00:00+0000, so compare instants, not strings.
        const at = r.timestamp ? Date.parse(r.timestamp) : NaN;
        if (!username || r.is_reply_owned_by_me || username === own || Number.isNaN(at) || at <= sinceMs) continue;
        if (at > newestMs) newestMs = at;
        events.push({
          kind: 'message',
          accountId: me,
          externalId: `threads:${r.id}`,
          from: publicSender(username),
          fromName: `@${r.username}`,
          sentAt: new Date(at),
          text: r.text || '[Reply with no text]',
          type: 'reply',
          public: { kind: 'reply', itemId: r.id, rootId: post.id, parentId: post.id, permalink: r.permalink, handle: `@${r.username}` },
        });
      }
    }
    events.sort((a, b) => (a as { sentAt: Date }).sentAt.getTime() - (b as { sentAt: Date }).sentAt.getTime());
    return { events, state: { ...state, lastReplyAt: new Date(newestMs).toISOString() } };
  },
};
