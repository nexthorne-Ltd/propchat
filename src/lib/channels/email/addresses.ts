import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Addresses, threading ids and the ticket reference. Everything here is pure
 * so the rules that decide which ticket an email belongs to can be tested
 * without a database.
 */

import { isEmail, normalizeEmail, domainOf } from './address-basics';

export { isEmail, normalizeEmail, domainOf };

/** `<ABC@Mail.Example>` → `abc@mail.example`. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/<([^<>]+)>/);
  const id = (m ? m[1] : value).trim().toLowerCase();
  return id && !/\s/.test(id) ? id : null;
}

/** All ids in a References / In-Reply-To header value. */
export function parseMessageIds(value: string | string[] | null | undefined): string[] {
  const text = Array.isArray(value) ? value.join(' ') : value || '';
  const ids = Array.from(text.matchAll(/<([^<>\s]+)>/g)).map((m) => m[1].toLowerCase());
  if (ids.length === 0 && text.trim() && !/\s/.test(text.trim())) {
    const single = normalizeMessageId(text);
    return single ? [single] : [];
  }
  return Array.from(new Set(ids));
}

/** `support+t1042-ab12@in.example.test` → base address and the tag after the "+". */
export function splitTaggedAddress(address: string): { base: string; tag: string | null } {
  const email = normalizeEmail(address);
  const at = email.lastIndexOf('@');
  if (at < 1) return { base: email, tag: null };
  const local = email.slice(0, at);
  const plus = local.indexOf('+');
  if (plus < 0) return { base: email, tag: null };
  return { base: `${local.slice(0, plus)}${email.slice(at)}`, tag: local.slice(plus + 1) || null };
}

/**
 * A reference only the sender of one of our emails could hold: HMAC over the
 * workspace and ticket number. Ten hex digits (40 bits) are enough because
 * guessing one means sending an email per guess.
 */
export function ticketToken(secret: string, workspaceId: string, ticketNumber: number): string {
  return createHmac('sha256', secret).update(`email-ticket:${workspaceId}:${ticketNumber}`).digest('hex').slice(0, 10);
}

/** `acme@in.example.test` → `acme+t1042-ab12cd34ef@in.example.test`. */
export function taggedAddress(base: string, secret: string, workspaceId: string, ticketNumber: number): string {
  const email = normalizeEmail(base);
  const at = email.lastIndexOf('@');
  return `${email.slice(0, at)}+t${ticketNumber}-${ticketToken(secret, workspaceId, ticketNumber)}${email.slice(at)}`;
}

/** The ticket number in a tag, but only when its token proves we issued it. */
export function verifiedTicketFromTag(tag: string | null | undefined, secret: string, workspaceId: string): number | null {
  const m = (tag || '').toLowerCase().match(/^t(\d{1,9})-([0-9a-f]{10})$/);
  if (!m) return null;
  const number = Number(m[1]);
  const expected = Buffer.from(ticketToken(secret, workspaceId, number));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? number : null;
}

/** `[#1042]` in a subject. Only a hint: the database also checks who sent it. */
export function ticketNumberFromSubject(subject: string): number | null {
  const m = subject.match(/\[(?:ticket\s*)?#(\d{3,9})\]/i);
  return m ? Number(m[1]) : null;
}

/** Subject without reply/forward prefixes and our `[#1042]` reference. */
export function cleanSubject(subject: string): string {
  let s = subject.replace(/\[(?:ticket\s*)?#\d{3,9}\]/gi, ' ');
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^\s*(re|fwd?|aw|wg|sv|vs|rv|tr|enc)(\[\d+\])?\s*:\s*/i, '');
  } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim().slice(0, 250);
}

/** Subject of a reply we send: `Re: <subject> [#1042]`. */
export function replySubject(subject: string, ticketNumber: number): string {
  const base = cleanSubject(subject) || 'Your request';
  return `Re: ${base} [#${ticketNumber}]`.slice(0, 250);
}


/** The platform address for a workspace, from its slug: letters, digits and hyphens only. */
export function forwardingAddressFor(slug: string, inboundDomain: string): string | null {
  const local = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const domain = inboundDomain.trim().toLowerCase();
  if (!local || !domain.includes('.')) return null;
  return `${local}@${domain}`;
}

/** Splits "Name <a@b.c>, d@e.f" into addresses; anything that is not an address is dropped. */
export function parseAddressList(value: string): { email: string; name?: string }[] {
  const out: { email: string; name?: string }[] = [];
  for (const part of value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = part.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^<>]+)>\s*$/) || part.match(/^\s*()([^\s<>,]+@[^\s<>,]+)\s*$/);
    if (m && isEmail(m[2].trim())) out.push({ email: normalizeEmail(m[2]), ...(m[1]?.trim() ? { name: m[1].trim() } : {}) });
  }
  return out;
}
