import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { htmlToPlainText } from './html';
import { normalizeEmail, normalizeMessageId, parseMessageIds, splitTaggedAddress } from './addresses';
import type { EmailAddress, ParsedEmail } from './types';

/**
 * Parses a raw RFC 822 message (what most providers can hand over) into the
 * neutral shape. Providers that deliver JSON instead map into the same shape
 * themselves; this is also what the tests feed with sample raw emails.
 */

function addresses(field: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  const out: EmailAddress[] = [];
  for (const group of list) {
    for (const a of group.value) {
      if (a.address) out.push({ email: normalizeEmail(a.address), ...(a.name ? { name: a.name } : {}) });
    }
  }
  return out;
}

/** Flattens mailparser's header values (strings, address objects, structured values) to text. */
function headerText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(headerText).join('\n');
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as { text?: string; value?: unknown; params?: Record<string, string> };
    if (typeof v.text === 'string') return v.text;
    if (v.value !== undefined && typeof v.value !== 'object') {
      const params = v.params ? Object.entries(v.params).map(([k, p]) => `; ${k}=${p}`).join('') : '';
      return `${String(v.value)}${params}`;
    }
  }
  return String(value);
}

export function flattenHeaders(headers: ParsedMail['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) out[key.toLowerCase()] = headerText(value);
  return out;
}

export async function parseRawEmail(raw: string | Buffer, extras: { envelopeTo?: string[]; mailboxHash?: string } = {}): Promise<ParsedEmail> {
  // Keep `cid:` image references as they are: we store the images ourselves and link those, not data: URIs.
  const mail = await simpleParser(raw, { skipImageLinks: true });
  const from = addresses(mail.from)[0] || null;
  const envelopeTo = (extras.envelopeTo || []).map(normalizeEmail);
  // Without a provider envelope, fall back to the delivery headers a mail server adds.
  const headers = flattenHeaders(mail.headers);
  for (const h of ['x-original-to', 'delivered-to']) {
    if (headers[h]) envelopeTo.push(normalizeEmail(headers[h].split('\n')[0]));
  }
  const hash = extras.mailboxHash || envelopeTo.map((a) => splitTaggedAddress(a).tag).find(Boolean) || undefined;

  return {
    messageId: normalizeMessageId(mail.messageId),
    inReplyTo: normalizeMessageId(typeof mail.inReplyTo === 'string' ? mail.inReplyTo : null),
    references: parseMessageIds(mail.references),
    from,
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    envelopeTo: Array.from(new Set(envelopeTo)),
    mailboxHash: hash,
    subject: (mail.subject || '').trim(),
    text: (mail.text || (typeof mail.html === 'string' ? htmlToPlainText(mail.html) : '')).replace(/\r\n/g, '\n'),
    html: typeof mail.html === 'string' ? mail.html : null,
    date: mail.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date : new Date(),
    headers,
    attachments: (mail.attachments || []).map((a) => ({
      filename: a.filename || (a.contentType === 'message/rfc822' ? 'forwarded-message.eml' : 'attachment'),
      contentType: a.contentType || 'application/octet-stream',
      size: a.size ?? a.content.length,
      content: a.content,
      contentId: a.cid ? a.cid.replace(/^<|>$/g, '') : undefined,
      inline: a.contentDisposition === 'inline' || Boolean(a.related),
    })),
  };
}
