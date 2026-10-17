import type { ChannelAdapter, ChannelContext, ChannelEvent, InboundMessageEvent, OutboundContent, PollResult, PollState, SendResult } from '@/lib/channels/types';
import { ChannelApiError, sendFailure } from '@/lib/channels/http';
import { authorOf, charCount, publicSender } from '@/lib/channels/public';
import { xRequest } from './api';
import { refreshXToken, revokeXToken } from './oauth';
import { parseXWebhook, verifyXSignature, xCrcResponse } from './webhook';
import { userError } from '@/lib/errors/user-error';

/**
 * X (Twitter) on the official X API v2.
 *
 * What it does:
 *   - Mentions of the account, and replies to its posts, become tickets
 *     (polled with `since_id`, so each poll is billed only for new posts).
 *     The answer is a public reply under that post.
 *   - Direct messages become tickets too, and are answered privately. They
 *     arrive by webhook (Account Activity API, needs that access on your X
 *     plan) or, if switched on, by a slow poll: X bills every event a poll
 *     returns, so DM polling is off by default.
 *
 * Credentials are an OAuth 2.0 user token (2 hours) and its refresh token;
 * `refreshesOnUse` makes the runtime renew it just before each use.
 */

export interface XCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | null;
}

type Ctx = ChannelContext<XCredentials>;

interface Tweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: { type: string; id: string }[];
}
interface XUser {
  id: string;
  username?: string;
  name?: string;
}
interface TimelineResponse<T> {
  data?: T[];
  includes?: { users?: XUser[] };
  meta?: { newest_id?: string; next_token?: string; result_count?: number };
}
interface DmEvent {
  id: string;
  text?: string;
  created_at?: string;
  sender_id?: string;
  event_type?: string;
}

export const X_MAX_LENGTH = 280;
const MAX_POLL_PAGES = 3;
/** DM polling is billed per event returned, so it runs on a much slower beat than mentions. */
export const DM_PROBE_MINUTES = 15;

function displayName(u: XUser | undefined): string | undefined {
  if (!u) return undefined;
  return u.name ? `${u.name}${u.username ? ` (@${u.username})` : ''}` : u.username ? `@${u.username}` : undefined;
}

/** A mention or reply, as the neutral event the database stores. */
export function tweetEvent(t: Tweet, accountId: string, users: Map<string, XUser>): InboundMessageEvent | null {
  if (!t.author_id || t.author_id === accountId) return null;
  const author = users.get(t.author_id);
  const repliesToUs = t.in_reply_to_user_id === accountId && (t.referenced_tweets || []).some((r) => r.type === 'replied_to');
  const parent = (t.referenced_tweets || []).find((r) => r.type === 'replied_to')?.id;
  const handle = author?.username ? `@${author.username}` : undefined;
  return {
    kind: 'message',
    accountId,
    externalId: `x:tweet:${t.id}`,
    from: publicSender(t.author_id),
    fromName: displayName(author),
    sentAt: t.created_at ? new Date(t.created_at) : new Date(),
    text: t.text || '[Post]',
    type: repliesToUs ? 'reply' : 'mention',
    public: {
      kind: repliesToUs ? 'reply' : 'mention',
      itemId: t.id,
      rootId: t.conversation_id,
      parentId: repliesToUs ? parent : undefined,
      permalink: author?.username ? `https://x.com/${author.username}/status/${t.id}` : undefined,
      handle,
    },
  };
}

function dmEvent(e: DmEvent, accountId: string, users: Map<string, XUser>): InboundMessageEvent | null {
  if (!e.sender_id || e.sender_id === accountId || e.event_type !== 'MessageCreate') return null;
  return {
    kind: 'message',
    accountId,
    externalId: `x:dm:${e.id}`,
    from: e.sender_id,
    fromName: displayName(users.get(e.sender_id)),
    sentAt: e.created_at ? new Date(e.created_at) : new Date(),
    text: e.text || '[A message type X does not share with business apps]',
    type: 'dm',
  };
}

/** The request body for a public reply. Exported for tests. */
export function buildXReply(text: string, inReplyTo: string): Record<string, unknown> {
  return { text, reply: { in_reply_to_tweet_id: inReplyTo } };
}

async function send(ctx: Ctx, to: string, content: OutboundContent): Promise<SendResult> {
  if (content.type !== 'text') return { ok: false, error: 'X does not support message templates.', retryable: false };
  const text = content.text.trim();
  if (!text) return { ok: false, error: 'There is nothing to send.', retryable: false };
  try {
    if (content.publicTarget) {
      const n = charCount(text);
      if (n > X_MAX_LENGTH) {
        return { ok: false, error: `This reply is ${n} characters; X allows ${X_MAX_LENGTH}. Shorten it and send again.`, retryable: false };
      }
      const res = await xRequest<{ data?: { id?: string } }>(ctx.credentials.accessToken, 'tweets', { method: 'POST', json: buildXReply(text, content.publicTarget.itemId) });
      const id = res.json.data?.id;
      return id ? { ok: true, providerMessageId: `x:tweet:${id}` } : { ok: false, error: 'X accepted the reply but returned no post id.', retryable: false };
    }
    const res = await xRequest<{ data?: { dm_event_id?: string } }>(ctx.credentials.accessToken, `dm_conversations/with/${encodeURIComponent(authorOf(to))}/messages`, {
      method: 'POST',
      json: { text },
    });
    const id = res.json.data?.dm_event_id;
    return id ? { ok: true, providerMessageId: `x:dm:${id}` } : { ok: false, error: 'X accepted the message but returned no id.', retryable: false };
  } catch (err) {
    return sendFailure(err);
  }
}

function userMap(users: XUser[] | undefined): Map<string, XUser> {
  return new Map((users || []).map((u) => [u.id, u]));
}

export const xAdapter: ChannelAdapter<XCredentials, Record<string, never>> = {
  id: 'x',
  label: 'X',
  capabilities: {
    media: false,
    templates: false,
    readReceipts: false,
    serviceWindowHours: null,
    directMessages: true,
    publicReplies: true,
    maxReplyLength: X_MAX_LENGTH,
    pollIntervalSeconds: 120,
    refreshesOnUse: true,
  },

  async connect(_input, credentials) {
    const token = credentials.accessToken?.trim();
    if (!token) throw userError('X did not return an access token.');
    let me;
    try {
      me = await xRequest<{ data?: XUser }>(token, 'users/me', { query: { 'user.fields': 'username,name' } });
    } catch (err) {
      if (err instanceof ChannelApiError) throw userError(err.failure.error);
      throw err;
    }
    const user = me.json.data;
    if (!user?.id) throw userError('X did not return the account id.');
    return {
      externalAccountId: user.id,
      externalBusinessId: null,
      displayName: user.username ? `@${user.username}${user.name ? ` · ${user.name}` : ''}` : user.name || user.id,
      // Only items from now on: the account's whole mention history is not a backlog of tickets.
      settings: { username: user.username || null, poll_dms: false, poll_state: { startTime: new Date().toISOString() } },
    };
  },

  verifyWebhookChallenge: () => null,
  respondToChallenge: xCrcResponse,
  verifyWebhookSignature: (req, secret) => verifyXSignature(req.rawBody, req.headers.get('x-twitter-webhooks-signature'), secret),
  parseWebhook: parseXWebhook,

  sendMessage: (ctx, to, content) => send(ctx, to, content),
  async sendMedia() {
    return { ok: false, error: 'Replies on X from Zentry are text only.', retryable: false };
  },
  async markRead() {},
  async downloadMedia() {
    throw userError('X attachments are not downloaded.');
  },
  async listTemplates() {
    return [];
  },

  async disconnect(ctx) {
    await revokeXToken(ctx.credentials.accessToken);
  },

  async refreshCredentials(ctx) {
    const { refreshToken, expiresAt } = ctx.credentials;
    const expires = expiresAt ? Date.parse(expiresAt) : NaN;
    // Access tokens last two hours: renew in the last ten minutes.
    if (!refreshToken || Number.isNaN(expires) || expires - Date.now() > 10 * 60_000) return null;
    const fresh = await refreshXToken(refreshToken);
    return {
      credentials: { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken || refreshToken, expiresAt: fresh.expiresAt },
      settings: ctx.connection.settings,
    };
  },

  async poll(ctx: Ctx, state: PollState): Promise<PollResult> {
    const me = ctx.connection.external_account_id;
    if (!me) return { events: [], state };
    const token = ctx.credentials.accessToken;
    const events: ChannelEvent[] = [];
    const next: PollState = { ...state };
    const startTime = typeof state.startTime === 'string' ? state.startTime : new Date().toISOString();
    next.startTime = startTime;

    // Mentions and replies: newest-first; since_id means only new posts are returned, and billed.
    const sinceId = typeof state.mentionsSinceId === 'string' ? state.mentionsSinceId : undefined;
    let pageToken: string | undefined;
    const mentions: { tweet: Tweet; users: Map<string, XUser> }[] = [];
    for (let page = 0; page < MAX_POLL_PAGES; page++) {
      const res = await xRequest<TimelineResponse<Tweet>>(token, `users/${me}/mentions`, {
        query: {
          max_results: '50',
          'tweet.fields': 'created_at,author_id,conversation_id,in_reply_to_user_id,referenced_tweets',
          expansions: 'author_id',
          'user.fields': 'username,name',
          ...(sinceId ? { since_id: sinceId } : { start_time: startTime }),
          ...(pageToken ? { pagination_token: pageToken } : {}),
        },
      });
      const users = userMap(res.json.includes?.users);
      for (const tweet of res.json.data || []) mentions.push({ tweet, users });
      if (res.json.meta?.newest_id && page === 0) next.mentionsSinceId = res.json.meta.newest_id;
      pageToken = res.json.meta?.next_token;
      if (!pageToken) break;
    }
    // Oldest first, so tickets are created in the order things were said.
    for (const { tweet, users } of mentions.reverse()) {
      const ev = tweetEvent(tweet, me, users);
      if (ev) events.push(ev);
    }

    // DMs: off unless asked for. X bills each event a read returns, so look at the
    // single newest event first (at most every 15 minutes) and only read more when it is new.
    const lastProbe = typeof state.lastDmProbeAt === 'string' ? Date.parse(state.lastDmProbeAt) : 0;
    if (ctx.connection.settings?.poll_dms === true && Date.now() - lastProbe >= DM_PROBE_MINUTES * 60_000) {
      next.lastDmProbeAt = new Date().toISOString();
      const since = typeof state.lastDmAt === 'string' ? state.lastDmAt : startTime;
      const dmQuery = {
        event_types: 'MessageCreate',
        'dm_event.fields': 'id,text,created_at,sender_id,event_type',
        expansions: 'sender_id',
        'user.fields': 'username,name',
      };
      const probe = await xRequest<TimelineResponse<DmEvent>>(token, 'dm_events', { query: { ...dmQuery, max_results: '1' } });
      const newest = probe.json.data?.[0];
      if (newest?.created_at && Date.parse(newest.created_at) > Date.parse(since)) {
        const res = await xRequest<TimelineResponse<DmEvent>>(token, 'dm_events', { query: { ...dmQuery, max_results: '50' } });
        const users = userMap(res.json.includes?.users);
        const fresh = (res.json.data || []).filter((e) => e.created_at && Date.parse(e.created_at) > Date.parse(since)).reverse();
        for (const e of fresh) {
          const ev = dmEvent(e, me, users);
          if (ev) events.push(ev);
        }
        next.lastDmAt = newest.created_at;
      }
    }
    return { events, state: next };
  },
};
