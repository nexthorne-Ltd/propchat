import type { ChannelEvent, InboundMessageEvent, MediaKind, StoryContext } from '@/lib/channels/types';

/**
 * Parses an Instagram messaging webhook (object "instagram") into neutral
 * channel events: DMs (text and media), story replies, story mentions, shared
 * posts, and read receipts. Echoes of the business's own messages, deleted
 * messages and fields we do not subscribe to are skipped, never thrown on.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- webhook JSON is untyped input, narrowed field by field below. */

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Instagram timestamps are milliseconds (older payloads used seconds). */
function toDate(v: unknown): Date {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return new Date();
  return new Date(n < 1e12 ? n * 1000 : n);
}

const MEDIA: Record<string, MediaKind> = { image: 'image', video: 'video', audio: 'audio', file: 'document', animated_image: 'image', sticker: 'sticker' };
const MEDIA_LABEL: Record<MediaKind, string> = {
  image: '[Image]',
  video: '[Video]',
  audio: '[Voice message]',
  document: '[File]',
  sticker: '[Sticker]',
};
const SHARE_LABEL: Record<string, string> = {
  share: 'Shared a post',
  ig_post: 'Shared a post',
  ig_reel: 'Shared a reel',
  reel: 'Shared a reel',
};

function messageEvent(item: any, accountId: string): InboundMessageEvent | null {
  const msg = item.message;
  const externalId = str(msg?.mid);
  const from = str(item.sender?.id);
  if (!externalId || !from || msg.is_echo || msg.is_deleted) return null;

  const base = { kind: 'message' as const, accountId, externalId, from, sentAt: toDate(item.timestamp) };
  const text = str(msg.text);
  const attachments: any[] = Array.isArray(msg.attachments) ? msg.attachments : [];
  const first = attachments[0];
  const firstType = str(first?.type);
  const firstUrl = str(first?.payload?.url);

  // Mentioned the business in their story: the attachment is the story itself.
  if (firstType === 'story_mention') {
    const story: StoryContext = { kind: 'mention', url: firstUrl, id: str(first?.payload?.id) };
    return { ...base, type: 'story_mention', text: 'Mentioned you in their story', story };
  }

  // Replied to the business's story: reply_to.story points at it.
  const replyStory = msg.reply_to?.story;
  const story: StoryContext | undefined = replyStory
    ? { kind: 'reply', url: str(replyStory.url), id: str(replyStory.id) }
    : undefined;

  if (firstType && MEDIA[firstType]) {
    const kind = MEDIA[firstType];
    return {
      ...base,
      type: story ? 'story_reply' : firstType,
      text: text || MEDIA_LABEL[kind],
      media: firstUrl ? { id: firstUrl, kind } : undefined,
      story,
    };
  }
  if (firstType && SHARE_LABEL[firstType]) {
    return { ...base, type: firstType, text: [text, `${SHARE_LABEL[firstType]}${firstUrl ? `: ${firstUrl}` : ''}`].filter(Boolean).join('\n') };
  }
  if (msg.is_unsupported || (!text && !attachments.length)) {
    return { ...base, type: 'unsupported', text: '[A message type Instagram does not share with business apps]' };
  }
  return {
    ...base,
    type: story ? 'story_reply' : 'text',
    text: text || (story ? 'Replied to your story' : ''),
    replyToExternalId: str(msg.reply_to?.mid),
    story,
  };
}

export function parseInstagramWebhook(body: unknown): ChannelEvent[] {
  const root = body as any;
  if (!root || root.object !== 'instagram' || !Array.isArray(root.entry)) return [];
  const events: ChannelEvent[] = [];

  for (const entry of root.entry) {
    const entryId = str(entry?.id);
    for (const item of Array.isArray(entry?.messaging) ? entry.messaging : []) {
      // The business account is the recipient of a customer's message.
      const accountId = str(item?.recipient?.id) || entryId;
      if (!accountId) continue;
      if (item.message) {
        const ev = messageEvent(item, accountId);
        if (ev) events.push(ev);
      } else if (item.read && str(item.read.mid)) {
        // The customer read up to this message of ours.
        events.push({ kind: 'status', accountId, externalId: item.read.mid, status: 'read', at: toDate(item.timestamp) });
      }
    }
  }
  return events;
}
