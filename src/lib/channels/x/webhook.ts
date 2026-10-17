import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelEvent } from '@/lib/channels/types';
import { publicSender } from '@/lib/channels/public';

/**
 * X webhooks (Account Activity API). Two things are verified:
 *
 *   - The CRC check X makes on registration and about hourly: a GET with
 *     `crc_token`, answered with `{"response_token": "sha256=<base64 HMAC-SHA256
 *     of crc_token keyed with the app's consumer secret>"}`. Failing it makes X
 *     mark the webhook invalid and stop delivering.
 *   - Every POST carries `x-twitter-webhooks-signature: sha256=<base64 HMAC-SHA256
 *     of the raw body, same key>`. The signature has no timestamp, so it proves
 *     the sender, not freshness; replays are harmless because message ids are
 *     stored once.
 *
 * Parsing handles the classic Account Activity payload (`direct_message_events`
 * and `tweet_create_events`, with `for_user_id` naming the account). X's newer
 * "X Activity API" delivers a different envelope that is not parsed yet.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- webhook JSON is untyped input, narrowed field by field below. */

function hmac(data: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(data, 'utf8').digest('base64')}`;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function xCrcResponse(query: URLSearchParams, consumerSecret: string): { contentType: string; body: string } | null {
  const token = query.get('crc_token');
  if (!token) return null;
  return { contentType: 'application/json', body: JSON.stringify({ response_token: hmac(token, consumerSecret) }) };
}

export function verifyXSignature(rawBody: string, header: string | null | undefined, consumerSecret: string): boolean {
  if (!header || !consumerSecret) return false;
  return same(header.trim(), hmac(rawBody, consumerSecret));
}

export function signXPayload(rawBody: string, consumerSecret: string): string {
  return hmac(rawBody, consumerSecret);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function parseXWebhook(body: unknown): ChannelEvent[] {
  const root = body as any;
  const accountId = str(root?.for_user_id);
  if (!root || !accountId) return [];
  const events: ChannelEvent[] = [];
  const users: Record<string, any> = root.users && typeof root.users === 'object' ? root.users : {};

  for (const dm of Array.isArray(root.direct_message_events) ? root.direct_message_events : []) {
    const create = dm?.message_create;
    const id = str(dm?.id);
    const sender = str(create?.sender_id);
    const text = str(create?.message_data?.text);
    // Echoes of what the business itself sent arrive too.
    if (dm?.type !== 'message_create' || !id || !sender || sender === accountId) continue;
    const u = users[sender];
    events.push({
      kind: 'message',
      accountId,
      externalId: `x:dm:${id}`,
      from: sender,
      fromName: str(u?.name) ? `${u.name}${str(u?.screen_name) ? ` (@${u.screen_name})` : ''}` : undefined,
      sentAt: new Date(Number(dm.created_timestamp) || Date.now()),
      text: text || '[A message type X does not share with business apps]',
      type: 'dm',
    });
  }

  for (const t of Array.isArray(root.tweet_create_events) ? root.tweet_create_events : []) {
    const id = str(t?.id_str);
    const author = str(t?.user?.id_str);
    if (!id || !author || author === accountId || t.retweeted_status) continue;
    const mentionsUs = Array.isArray(t.entities?.user_mentions) && t.entities.user_mentions.some((m: any) => m?.id_str === accountId);
    const repliesToUs = t.in_reply_to_user_id_str === accountId;
    if (!mentionsUs && !repliesToUs) continue;
    const handle = str(t.user?.screen_name);
    events.push({
      kind: 'message',
      accountId,
      externalId: `x:tweet:${id}`,
      from: publicSender(author),
      fromName: str(t.user?.name) ? `${t.user.name}${handle ? ` (@${handle})` : ''}` : undefined,
      sentAt: new Date(t.timestamp_ms ? Number(t.timestamp_ms) : Date.parse(t.created_at) || Date.now()),
      text: str(t.extended_tweet?.full_text) || str(t.full_text) || str(t.text) || '[Post]',
      type: repliesToUs ? 'reply' : 'mention',
      public: {
        kind: repliesToUs ? 'reply' : 'mention',
        itemId: id,
        rootId: str(t.in_reply_to_status_id_str),
        parentId: repliesToUs ? str(t.in_reply_to_status_id_str) : undefined,
        permalink: handle ? `https://x.com/${handle}/status/${id}` : undefined,
        handle: handle ? `@${handle}` : undefined,
      },
    });
  }
  return events;
}
