import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelEvent } from '@/lib/channels/types';
import { publicSender } from '@/lib/channels/public';

/**
 * TikTok webhooks. Every POST carries `Tiktok-Signature: t=<unix seconds>,s=<hex>`
 * where `s` is the HMAC-SHA256, keyed by the app's client secret, of
 * `<t>.<raw body>`. Because the timestamp is signed, a captured request cannot
 * be replayed later: anything older than five minutes is refused.
 *
 * Parsing is deliberately forgiving. TikTok's business events are only
 * documented to approved developers, so the comment event is read through the
 * field names its envelope is known to use and everything else is skipped.
 * Verify these against a real delivery once your app is approved (see
 * docs/CHANNELS.md).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- webhook JSON is untyped input, narrowed field by field below. */

export const TIKTOK_TOLERANCE_SECONDS = 300;

export function signTikTokPayload(rawBody: string, clientSecret: string, timestamp: number): string {
  const s = createHmac('sha256', clientSecret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},s=${s}`;
}

export function verifyTikTokSignature(rawBody: string, header: string | null | undefined, clientSecret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!header || !clientSecret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  const given = parts.s;
  if (!Number.isFinite(t) || !given || !/^[0-9a-f]{64}$/i.test(given)) return false;
  if (Math.abs(nowSeconds - t) > TIKTOK_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', clientSecret).update(`${t}.${rawBody}`, 'utf8').digest();
  const got = Buffer.from(given, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : undefined;
}

function toDate(v: unknown): Date {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return new Date();
  return new Date(n < 1e12 ? n * 1000 : n);
}

/** The envelope carries its event body as a JSON string or, in some versions, an object. */
function contentOf(root: any): any {
  const c = root?.content;
  if (typeof c === 'string') {
    try {
      return JSON.parse(c);
    } catch {
      return null;
    }
  }
  return c && typeof c === 'object' ? c : null;
}

export function parseTikTokWebhook(body: unknown): ChannelEvent[] {
  const root = body as any;
  const event = str(root?.event)?.toLowerCase();
  if (!event || !event.includes('comment')) return [];
  const c = contentOf(root);
  if (!c) return [];
  const accountId = str(c.business_id) || str(root.user_openid);
  const commentId = str(c.comment_id) || str(c.id);
  const authorId = str(c.user_id) || str(c.open_id) || str(c.from_user_id);
  const text = str(c.text) || str(c.content);
  const videoId = str(c.video_id) || str(c.item_id);
  // Only new comments by someone else; edits, deletions and visibility changes are not tickets.
  const action = str(c.action)?.toLowerCase();
  if (!accountId || !commentId || !authorId || !text || !videoId || authorId === accountId) return [];
  if (action && !['create', 'created', 'new'].includes(action)) return [];
  const username = str(c.username) || str(c.user_name);
  return [
    {
      kind: 'message',
      accountId,
      externalId: `tiktok:${commentId}`,
      from: publicSender(authorId),
      fromName: username ? `@${username}` : 'TikTok user',
      sentAt: toDate(c.create_time ?? root.create_time),
      text,
      type: 'comment',
      public: {
        kind: 'comment',
        itemId: commentId,
        rootId: videoId,
        parentId: str(c.parent_comment_id),
        handle: username ? `@${username}` : undefined,
      },
    },
  ];
}
