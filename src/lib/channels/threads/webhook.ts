import type { ChannelEvent } from '@/lib/channels/types';
import { publicSender } from '@/lib/channels/public';

/**
 * Threads webhooks: replies to the account's posts ("replies") and public
 * mentions of the account ("mentions"). Signed like every Meta webhook
 * (X-Hub-Signature-256 over the raw body, keyed by the app secret) and
 * verified with the usual hub.challenge handshake, both shared with the other
 * Meta channels.
 *
 * Meta documents the payload as a `values` list; the standard Graph envelope
 * (`entry[].changes[]`) is accepted too. Replies and mentions from private
 * accounts are never delivered, and replies need the app to have passed App
 * Review for Advanced Access. Anything unrecognised is skipped, not thrown on.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- webhook JSON is untyped input, narrowed field by field below. */

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function toDate(v: unknown): Date {
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? new Date() : new Date(t);
}

function eventFor(field: string, value: any, accountId: string): ChannelEvent | null {
  const id = str(value?.id);
  const username = str(value?.username);
  if ((field !== 'replies' && field !== 'mentions') || !id || !username) return null;
  const kind = field === 'replies' ? 'reply' : 'mention';
  return {
    kind: 'message',
    accountId,
    externalId: `threads:${id}`,
    from: publicSender(username.toLowerCase()),
    fromName: `@${username}`,
    sentAt: toDate(value.timestamp),
    text: str(value.text) || (kind === 'reply' ? '[Reply with no text]' : '[Mention with no text]'),
    type: kind,
    public: {
      kind,
      itemId: id,
      rootId: str(value.root_post?.id) || str(value.replied_to?.id),
      parentId: kind === 'reply' ? str(value.replied_to?.id) : undefined,
      permalink: str(value.permalink),
      handle: `@${username}`,
    },
  };
}

export function parseThreadsWebhook(body: unknown): ChannelEvent[] {
  const root = body as any;
  if (!root || typeof root !== 'object') return [];
  const events: ChannelEvent[] = [];
  const add = (field: unknown, value: unknown, accountId: string | undefined) => {
    if (!accountId || typeof field !== 'string') return;
    const ev = eventFor(field, value, accountId);
    if (ev) events.push(ev);
  };

  const topAccount = str(root.target_id);
  for (const item of Array.isArray(root.values) ? root.values : []) add(item?.field, item?.value, topAccount);
  for (const entry of Array.isArray(root.entry) ? root.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) add(change?.field, change?.value, str(entry?.id) || topAccount);
  }
  return events;
}
