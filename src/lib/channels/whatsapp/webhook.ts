import type { ChannelEvent, InboundMessageEvent, MediaKind, StatusEvent } from '@/lib/channels/types';

/**
 * Parses a WhatsApp Cloud API webhook (object "whatsapp_business_account")
 * into neutral channel events. Webhooks carry many shapes (messages, status
 * receipts, template reviews, account updates); anything we do not handle is
 * skipped rather than thrown on, because an exception would make Meta retry a
 * delivery that can never succeed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- webhook JSON is untyped input, narrowed field by field below. */

const MEDIA_KINDS: MediaKind[] = ['image', 'video', 'audio', 'document', 'sticker'];
const MEDIA_LABEL: Record<MediaKind, string> = {
  image: '[Image]',
  video: '[Video]',
  audio: '[Voice message]',
  document: '[Document]',
  sticker: '[Sticker]',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function unixToDate(v: unknown): Date {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

function messageText(msg: any): { text: string; media?: InboundMessageEvent['media'] } | null {
  const type = str(msg?.type) || 'unknown';
  if (type === 'text') return { text: str(msg.text?.body) || '' };
  if ((MEDIA_KINDS as string[]).includes(type)) {
    const kind = type as MediaKind;
    const m = msg[kind] || {};
    const id = str(m.id);
    const caption = str(m.caption);
    const filename = str(m.filename);
    return {
      text: caption || (filename ? `${MEDIA_LABEL[kind]} ${filename}` : MEDIA_LABEL[kind]),
      media: id ? { id, kind, mimeType: str(m.mime_type), filename } : undefined,
    };
  }
  if (type === 'location') {
    const l = msg.location || {};
    const label = [str(l.name), str(l.address)].filter(Boolean).join(', ');
    const coords = l.latitude !== undefined && l.longitude !== undefined ? `${l.latitude},${l.longitude}` : '';
    return { text: `[Location] ${label || coords}${label && coords ? ` (${coords})` : ''}`.trim() };
  }
  if (type === 'contacts') {
    const names = (Array.isArray(msg.contacts) ? msg.contacts : []).map((c: any) => str(c?.name?.formatted_name)).filter(Boolean);
    return { text: `[Contact] ${names.join(', ') || 'shared a contact'}` };
  }
  if (type === 'button') return { text: str(msg.button?.text) || str(msg.button?.payload) || '[Button]' };
  if (type === 'interactive') {
    const i = msg.interactive || {};
    return { text: str(i.button_reply?.title) || str(i.list_reply?.title) || '[Reply]' };
  }
  if (type === 'reaction') {
    const emoji = str(msg.reaction?.emoji);
    // An empty emoji removes a reaction: nothing for an agent to read.
    return emoji ? { text: `Reacted ${emoji}` } : null;
  }
  if (type === 'unsupported' || type === 'unknown') {
    return { text: '[A message type WhatsApp does not share with business apps]' };
  }
  // "system" (customer changed number), "order", "request_welcome" …: not a customer line.
  return null;
}

export function parseWhatsAppWebhook(body: unknown): ChannelEvent[] {
  const root = body as any;
  if (!root || root.object !== 'whatsapp_business_account' || !Array.isArray(root.entry)) return [];
  const events: ChannelEvent[] = [];

  for (const entry of root.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'messages') continue;
      const value = change.value || {};
      const accountId = str(value.metadata?.phone_number_id);
      if (!accountId) continue;

      const names = new Map<string, string>();
      for (const c of Array.isArray(value.contacts) ? value.contacts : []) {
        const waId = str(c?.wa_id);
        const name = str(c?.profile?.name);
        if (waId && name) names.set(waId, name);
      }

      for (const msg of Array.isArray(value.messages) ? value.messages : []) {
        const externalId = str(msg?.id);
        const from = str(msg?.from);
        if (!externalId || !from) continue;
        const content = messageText(msg);
        if (!content) continue;
        events.push({
          kind: 'message',
          accountId,
          externalId,
          from,
          fromName: names.get(from),
          sentAt: unixToDate(msg.timestamp),
          text: content.text,
          media: content.media,
          type: str(msg.type) || 'unknown',
          replyToExternalId: str(msg.context?.id),
        });
      }

      for (const st of Array.isArray(value.statuses) ? value.statuses : []) {
        const externalId = str(st?.id);
        const status = str(st?.status);
        if (!externalId || !status || !['sent', 'delivered', 'read', 'failed'].includes(status)) continue;
        const err = Array.isArray(st.errors) ? st.errors[0] : undefined;
        const error = err
          ? [str(err.title) || str(err.message), str(err.error_data?.details)].filter(Boolean).join(': ') || `Error ${err.code}`
          : undefined;
        events.push({
          kind: 'status',
          accountId,
          externalId,
          status: status as StatusEvent['status'],
          at: unixToDate(st.timestamp),
          error,
        });
      }
    }
  }
  return events;
}
