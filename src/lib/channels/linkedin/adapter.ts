import type { ChannelAdapter, ChannelContext, ChannelEvent, PollResult, PollState, SendResult } from '@/lib/channels/types';
import { ChannelApiError, sendFailure } from '@/lib/channels/http';
import { charCount, publicSender } from '@/lib/channels/public';
import { linkedinRequest, organizationUrn } from './api';
import { refreshLinkedInToken } from './oauth';
import { userError } from '@/lib/errors/user-error';

/**
 * LinkedIn on the Community Management API, for one Company Page.
 *
 * What LinkedIn allows is public: comments on the Page's posts. Direct
 * messages are not available to this integration (LinkedIn's messaging API is
 * limited to approved partners), and neither are mentions of the Page by
 * other people's posts.
 *
 * Comments are polled from the Page's recent posts (LinkedIn's push
 * notifications for them are not available until the app is approved for
 * Webhooks), and the answer is a comment as the Page under the one being
 * answered. The connecting person must administer the Page.
 *
 * Polling sees top-level comments on the 10 most recently modified posts;
 * replies nested under a comment are not read.
 */

export interface LinkedInCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | null;
}

export interface LinkedInConnectInput {
  /** The number in the Page's admin URL, linkedin.com/company/<id>/admin. */
  pageId: string;
}

type Ctx = ChannelContext<LinkedInCredentials>;

export const LINKEDIN_MAX_LENGTH = 1250;
const POSTS_PER_POLL = 10;
const COMMENTS_PER_POST = 50;

interface Elements<T> {
  elements?: T[];
}
interface Post {
  id: string;
}
export interface LinkedInComment {
  id?: string;
  commentUrn?: string;
  $URN?: string;
  actor?: string;
  object?: string;
  parentComment?: string;
  message?: { text?: string };
  created?: { time?: number };
}

export function commentUrnOf(c: LinkedInComment, postUrn: string): string | null {
  return c.commentUrn || c.$URN || (c.id ? `urn:li:comment:(${postUrn},${c.id})` : null);
}

/** A comment on the Page's post as the neutral event the database stores. */
export function commentEvent(c: LinkedInComment, postUrn: string, accountId: string, pageUrn: string): ChannelEvent | null {
  const urn = commentUrnOf(c, postUrn);
  if (!urn || !c.actor || c.actor === pageUrn || !c.message?.text) return null;
  return {
    kind: 'message',
    accountId,
    externalId: `linkedin:${urn}`,
    from: publicSender(c.actor),
    // LinkedIn does not share names with apps that only manage a Page.
    fromName: 'LinkedIn member',
    sentAt: new Date(c.created?.time ?? Date.now()),
    text: c.message.text,
    type: 'comment',
    public: { kind: 'comment', itemId: urn, rootId: c.object || postUrn, parentId: c.parentComment },
  };
}

/** The body of a comment made as the Page. Exported for tests. */
export function buildLinkedInComment(pageUrn: string, postUrn: string, text: string, parentComment?: string): Record<string, unknown> {
  return { actor: pageUrn, object: postUrn, message: { text }, ...(parentComment ? { parentComment } : {}) };
}

export const linkedinAdapter: ChannelAdapter<LinkedInCredentials, LinkedInConnectInput> = {
  id: 'linkedin',
  label: 'LinkedIn',
  capabilities: {
    media: false,
    templates: false,
    readReceipts: false,
    serviceWindowHours: null,
    directMessages: false,
    publicReplies: true,
    maxReplyLength: LINKEDIN_MAX_LENGTH,
    pollIntervalSeconds: 900,
  },

  async connect(input, credentials) {
    const pageId = (input.pageId || '').trim();
    if (!/^\d{3,15}$/.test(pageId)) throw userError('Enter your Page’s numeric id: the number in linkedin.com/company/<number>/admin.');
    const token = credentials.accessToken?.trim();
    if (!token) throw userError('LinkedIn did not return an access token.');
    const urn = organizationUrn(pageId);
    // Reading the Page's posts proves the token, the scope, the product approval and the admin role at once.
    try {
      await linkedinRequest<Elements<Post>>(token, 'posts', { query: { author: urn, q: 'author', count: '1' } });
    } catch (err) {
      if (err instanceof ChannelApiError) throw userError(err.failure.error);
      throw err;
    }
    let name = `LinkedIn Page ${pageId}`;
    try {
      const org = await linkedinRequest<{ localizedName?: string }>(token, `organizations/${pageId}`);
      if (org.json.localizedName) name = org.json.localizedName;
    } catch {
      // The name is cosmetic; the posts call above already proved access.
    }
    return {
      externalAccountId: pageId,
      externalBusinessId: null,
      displayName: name,
      settings: { page_urn: urn, token_expires_at: credentials.expiresAt ?? null, poll_state: { lastCommentAt: new Date().toISOString() } },
    };
  },

  verifyWebhookChallenge: () => null,
  // LinkedIn's push notifications are not used (see the header); nothing is accepted here.
  verifyWebhookSignature: () => false,
  parseWebhook: () => [],

  async sendMessage(ctx: Ctx, _to, content): Promise<SendResult> {
    if (content.type !== 'text') return { ok: false, error: 'LinkedIn does not support message templates.', retryable: false };
    const target = content.publicTarget;
    if (!target?.rootId) {
      return { ok: false, error: 'LinkedIn has no direct messages here. Replies are comments on the Page’s post.', retryable: false };
    }
    const text = content.text.trim();
    const n = charCount(text);
    if (!text) return { ok: false, error: 'There is nothing to send.', retryable: false };
    if (n > LINKEDIN_MAX_LENGTH) return { ok: false, error: `This reply is ${n} characters; LinkedIn allows ${LINKEDIN_MAX_LENGTH}. Shorten it and send again.`, retryable: false };
    const pageId = ctx.connection.external_account_id;
    if (!pageId) return { ok: false, error: 'The Page id is missing. Reconnect LinkedIn.', retryable: false, needsAttention: true };
    try {
      const res = await linkedinRequest<{ commentUrn?: string; $URN?: string; id?: string }>(
        ctx.credentials.accessToken,
        `socialActions/${encodeURIComponent(target.rootId)}/comments`,
        { method: 'POST', json: buildLinkedInComment(organizationUrn(pageId), target.rootId, text, target.itemId) }
      );
      const id = res.headers.get('x-restli-id') || res.json?.commentUrn || res.json?.$URN || res.json?.id;
      return { ok: true, providerMessageId: `linkedin:${id ?? `${target.rootId}:${Date.now()}`}` };
    } catch (err) {
      return sendFailure(err);
    }
  },
  async sendMedia() {
    return { ok: false, error: 'Replies on LinkedIn from Zentry are text only.', retryable: false };
  },
  async markRead() {},
  async downloadMedia() {
    throw userError('LinkedIn attachments are not downloaded.');
  },
  async listTemplates() {
    return [];
  },
  // Nothing is subscribed on LinkedIn's side.
  async disconnect() {},

  async refreshCredentials(ctx) {
    const { refreshToken, expiresAt } = ctx.credentials;
    const expires = expiresAt ? Date.parse(expiresAt) : NaN;
    if (!refreshToken || Number.isNaN(expires) || expires - Date.now() > 10 * 86_400_000) return null;
    const fresh = await refreshLinkedInToken(refreshToken);
    return {
      credentials: { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt },
      settings: { ...ctx.connection.settings, token_expires_at: fresh.expiresAt },
    };
  },

  async poll(ctx: Ctx, state: PollState): Promise<PollResult> {
    const pageId = ctx.connection.external_account_id;
    if (!pageId) return { events: [], state };
    const pageUrn = organizationUrn(pageId);
    const token = ctx.credentials.accessToken;
    const sinceMs = Date.parse(typeof state.lastCommentAt === 'string' ? state.lastCommentAt : new Date().toISOString());

    const posts = await linkedinRequest<Elements<Post>>(token, 'posts', {
      query: { author: pageUrn, q: 'author', count: String(POSTS_PER_POLL), sortBy: 'LAST_MODIFIED' },
    });
    const events: ChannelEvent[] = [];
    let newestMs = sinceMs;
    for (const post of posts.json.elements || []) {
      const comments = await linkedinRequest<Elements<LinkedInComment>>(token, `socialActions/${encodeURIComponent(post.id)}/comments`, {
        query: { count: String(COMMENTS_PER_POST) },
      });
      for (const c of comments.json.elements || []) {
        const at = c.created?.time ?? 0;
        if (at <= sinceMs) continue;
        const ev = commentEvent(c, post.id, pageId, pageUrn);
        if (!ev) continue;
        events.push(ev);
        if (at > newestMs) newestMs = at;
      }
    }
    events.sort((a, b) => (a as { sentAt: Date }).sentAt.getTime() - (b as { sentAt: Date }).sentAt.getTime());
    return { events, state: { ...state, lastCommentAt: new Date(newestMs).toISOString() } };
  },
};
