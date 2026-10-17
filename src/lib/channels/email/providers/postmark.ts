import { timingSafeEqual } from 'node:crypto';
import { normalizeEmail, normalizeMessageId, parseMessageIds } from '../addresses';
import { parseRawEmail } from '../parse';
import { htmlToPlainText } from '../html';
import type { DnsRecord, EmailProvider, EmailSendResult, OutboundEmail, ParsedEmail, SenderDomainStatus } from '../types';
import { userError } from '@/lib/errors/user-error';

/**
 * Postmark: transactional sending, inbound webhooks and sender-domain
 * authentication over plain REST (no SDK, so it runs anywhere fetch does).
 *
 * Setup in Postmark: an inbound domain whose MX points at Postmark, the
 * inbound webhook set to `https://<EMAIL_WEBHOOK_AUTH>@<app>/api/channels/email/webhook`
 * (Postmark sends the credentials as HTTP Basic auth), and "Include raw email
 * content in JSON payload" switched on so threading headers arrive untouched.
 * The JSON fields are used when the raw message is absent.
 *
 * Not exercised against the live API in this repository's tests: the mapping
 * below follows Postmark's documented formats, and the channel page's
 * "Send test email" and domain check are the live smoke tests.
 */

const API = 'https://api.postmarkapp.com';

interface PostmarkAddress {
  Email: string;
  Name?: string;
  MailboxHash?: string;
}

interface PostmarkInbound {
  RawEmail?: string;
  OriginalRecipient?: string;
  MailboxHash?: string;
  Subject?: string;
  MessageID?: string;
  Date?: string;
  TextBody?: string;
  HtmlBody?: string;
  FromFull?: PostmarkAddress;
  ToFull?: PostmarkAddress[];
  CcFull?: PostmarkAddress[];
  Headers?: { Name: string; Value: string }[];
  Attachments?: { Name: string; Content: string; ContentType: string; ContentLength: number; ContentID?: string }[];
}

function addr(a: PostmarkAddress | undefined) {
  return a?.Email ? { email: normalizeEmail(a.Email), ...(a.Name ? { name: a.Name } : {}) } : null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const postmarkProvider: EmailProvider = {
  id: 'postmark',

  isConfigured: () => Boolean(process.env.POSTMARK_SERVER_TOKEN),

  verifyInbound(headers) {
    const expected = process.env.EMAIL_WEBHOOK_AUTH; // "user:password"
    if (!expected) return false;
    const header = headers.get('authorization') || '';
    if (!header.toLowerCase().startsWith('basic ')) return false;
    return safeEqual(Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'), expected);
  },

  async parseInbound(rawBody) {
    const body = JSON.parse(rawBody) as PostmarkInbound;
    if (typeof body !== 'object' || body === null || (!body.FromFull && !body.RawEmail)) throw userError('Not a Postmark inbound email');
    const envelopeTo = [body.OriginalRecipient, ...(body.ToFull || []).map((a) => a.Email)].filter(Boolean).map((a) => normalizeEmail(a!));
    const hash = body.MailboxHash || body.ToFull?.find((a) => a.MailboxHash)?.MailboxHash || undefined;

    if (body.RawEmail) {
      const parsed = await parseRawEmail(body.RawEmail, { envelopeTo: body.OriginalRecipient ? [body.OriginalRecipient] : [], mailboxHash: hash });
      return parsed;
    }

    const headers: Record<string, string> = {};
    for (const h of body.Headers || []) {
      const key = h.Name.toLowerCase();
      headers[key] = headers[key] ? `${headers[key]}\n${h.Value}` : h.Value;
    }
    const html = body.HtmlBody || null;
    const parsed: ParsedEmail = {
      messageId: normalizeMessageId(headers['message-id']),
      inReplyTo: normalizeMessageId(headers['in-reply-to']),
      references: parseMessageIds(headers['references']),
      from: addr(body.FromFull),
      to: (body.ToFull || []).map(addr).filter((a): a is NonNullable<typeof a> => Boolean(a)),
      cc: (body.CcFull || []).map(addr).filter((a): a is NonNullable<typeof a> => Boolean(a)),
      envelopeTo: Array.from(new Set(envelopeTo)),
      mailboxHash: hash,
      subject: (body.Subject || '').trim(),
      text: body.TextBody || (html ? htmlToPlainText(html) : ''),
      html,
      date: body.Date && !Number.isNaN(Date.parse(body.Date)) ? new Date(body.Date) : new Date(),
      headers,
      attachments: (body.Attachments || []).map((a) => ({
        filename: a.Name || 'attachment',
        contentType: a.ContentType || 'application/octet-stream',
        size: a.ContentLength ?? 0,
        content: Buffer.from(a.Content || '', 'base64'),
        contentId: a.ContentID ? a.ContentID.replace(/^<|>$/g, '') : undefined,
        inline: Boolean(a.ContentID) && Boolean(html && html.toLowerCase().includes(`cid:${a.ContentID!.replace(/^<|>$/g, '').toLowerCase()}`)),
      })),
    };
    return parsed;
  },

  async send(email: OutboundEmail): Promise<EmailSendResult> {
    const token = process.env.POSTMARK_SERVER_TOKEN;
    if (!token) return { ok: false, error: 'POSTMARK_SERVER_TOKEN is not set.', retryable: false, needsAttention: true };
    const format = (a: { email: string; name?: string }) => (a.name ? `"${a.name.replace(/["\r\n\\]/g, '')}" <${a.email}>` : a.email);
    let res: Response;
    try {
      res = await fetch(`${API}/email`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token },
        body: JSON.stringify({
          From: format(email.from),
          To: email.to.map(format).join(', '),
          ...(email.cc?.length ? { Cc: email.cc.map(format).join(', ') } : {}),
          ...(email.replyTo ? { ReplyTo: email.replyTo } : {}),
          Subject: email.subject,
          TextBody: email.text,
          HtmlBody: email.html,
          Headers: Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value })),
          Attachments: (email.attachments || []).map((a) => ({ Name: a.filename, Content: a.content.toString('base64'), ContentType: a.contentType })),
          MessageStream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound',
          TrackOpens: false,
          TrackLinks: 'None',
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'Could not reach Postmark.', retryable: true };
    }
    const data = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string; MessageID?: string };
    if (res.ok && !data.ErrorCode) return { ok: true, providerId: data.MessageID };

    const message = data.Message || `Postmark answered ${res.status}.`;
    // 300 invalid address, 406 address previously hard-bounced or blocked: the recipient can never get it.
    if (data.ErrorCode === 300 || data.ErrorCode === 406) return { ok: false, error: message, retryable: false, recipientRejected: true };
    // 10 bad token, 400 unknown sender, 405 sending not allowed: the setup is broken.
    if (data.ErrorCode === 10 || data.ErrorCode === 400 || data.ErrorCode === 405 || res.status === 401) {
      return { ok: false, error: message, retryable: false, needsAttention: true };
    }
    return { ok: false, error: message, retryable: res.status === 429 || res.status >= 500 };
  },

  async createSenderDomain(domain) {
    const accountToken = process.env.POSTMARK_ACCOUNT_TOKEN;
    if (!accountToken) throw userError('POSTMARK_ACCOUNT_TOKEN is not set, so domains cannot be authenticated from here.');
    const res = await fetch(`${API}/domains`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Account-Token': accountToken },
      body: JSON.stringify({ Name: domain, ReturnPathDomain: `pm-bounces.${domain}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as PostmarkDomain & { Message?: string };
    // 422 "already exists" is fine: look the domain up instead.
    if (!res.ok) {
      const existing = await findDomain(accountToken, domain);
      if (existing) return mapDomain(existing);
      throw userError(data.Message || `Postmark answered ${res.status}.`);
    }
    return mapDomain(data);
  },

  async checkSenderDomain(providerRef, domain) {
    const accountToken = process.env.POSTMARK_ACCOUNT_TOKEN;
    if (!accountToken) throw userError('POSTMARK_ACCOUNT_TOKEN is not set, so domains cannot be checked from here.');
    const headers = { Accept: 'application/json', 'X-Postmark-Account-Token': accountToken };
    // Ask Postmark to re-check DNS now; both calls are cheap and idempotent.
    await fetch(`${API}/domains/${providerRef}/verifyDkim`, { method: 'PUT', headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    await fetch(`${API}/domains/${providerRef}/verifyReturnPath`, { method: 'PUT', headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const res = await fetch(`${API}/domains/${providerRef}`, { headers, signal: AbortSignal.timeout(15_000) });
    const data = (await res.json().catch(() => ({}))) as PostmarkDomain & { Message?: string };
    if (!res.ok) throw userError(data.Message || `Postmark answered ${res.status}.`);
    return mapDomain({ ...data, Name: data.Name || domain });
  },
};

interface PostmarkDomain {
  ID?: number;
  Name?: string;
  DKIMVerified?: boolean;
  DKIMHost?: string;
  DKIMTextValue?: string;
  DKIMPendingHost?: string;
  DKIMPendingTextValue?: string;
  ReturnPathDomain?: string;
  ReturnPathDomainVerified?: boolean;
  ReturnPathDomainCNAMEValue?: string;
}

async function findDomain(accountToken: string, name: string): Promise<PostmarkDomain | null> {
  const res = await fetch(`${API}/domains?count=100&offset=0`, { headers: { Accept: 'application/json', 'X-Postmark-Account-Token': accountToken }, signal: AbortSignal.timeout(15_000) });
  const data = (await res.json().catch(() => ({}))) as { Domains?: PostmarkDomain[] };
  const hit = data.Domains?.find((d) => d.Name?.toLowerCase() === name.toLowerCase());
  if (!hit?.ID) return null;
  const full = await fetch(`${API}/domains/${hit.ID}`, { headers: { Accept: 'application/json', 'X-Postmark-Account-Token': accountToken }, signal: AbortSignal.timeout(15_000) });
  return full.ok ? ((await full.json()) as PostmarkDomain) : hit;
}

function mapDomain(d: PostmarkDomain): SenderDomainStatus {
  const dkimHost = d.DKIMPendingHost || d.DKIMHost || '';
  const dkimValue = d.DKIMPendingTextValue || d.DKIMTextValue || '';
  const records: DnsRecord[] = [];
  if (dkimHost && dkimValue) {
    records.push({ type: 'TXT', host: dkimHost, value: dkimValue, purpose: 'DKIM: proves emails from your domain are really yours', verified: Boolean(d.DKIMVerified) });
  }
  if (d.ReturnPathDomain && d.ReturnPathDomainCNAMEValue) {
    records.push({ type: 'CNAME', host: d.ReturnPathDomain, value: d.ReturnPathDomainCNAMEValue, purpose: 'Return-Path: lets bounces find their way back', verified: Boolean(d.ReturnPathDomainVerified) });
  }
  return { domain: d.Name || '', verified: Boolean(d.DKIMVerified) && (d.ReturnPathDomain ? Boolean(d.ReturnPathDomainVerified) : true), records, providerRef: String(d.ID ?? '') };
}
