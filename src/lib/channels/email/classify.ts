import type { ParsedEmail } from './types';

/**
 * Deciding whether an inbound email is a person writing to us or a machine.
 * Machines must never open tickets or get answers: an auto-responder answering
 * our "ticket received" while we answer its reply is how two systems end up
 * mailing each other forever. So automatic mail and bounces are recorded and
 * dropped, and our own mail coming back is recognised.
 */

export type InboundClass =
  | { kind: 'person' }
  | { kind: 'auto_reply'; reason: string }
  | {
      kind: 'bounce';
      reason: string;
      /** Permanent failure (the address does not exist); false for "mailbox full" and delays. */
      hard: boolean;
      /** Message-ID of our email that bounced, when the report includes it. */
      originalMessageId: string | null;
      recipient: string | null;
    }
  | { kind: 'loop'; reason: string }
  | { kind: 'invalid'; reason: string };

/** Header we put on every email we send, so a copy that comes back is recognisable. */
export const OUR_MAIL_HEADER = 'x-zentry-mail';

const BOUNCE_SENDERS = /^(mailer-daemon|postmaster|mail-delivery-subsystem|mailerdaemon)$/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification|delivery failure|returned mail|mail delivery failed|failure notice|couldn.t be delivered|nicht zugestellt)/i;
const AUTO_SUBJECT = /^\s*(auto(matic)?[\s-]*(reply|response|antwort)|automatische antwort|réponse automatique|respuesta automática|out of (the )?office|abwesenheit|absence du bureau|vacation|ooo\b)/i;
const NO_REPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply)$/i;
const MESSAGE_ID_IN_TEXT = /^message-id:\s*<([^>\s]+)>/im;

function sniff(email: ParsedEmail): string {
  // Delivery reports carry the original headers in an attached message; read them too.
  const attached = email.attachments
    .filter((a) => /^(message\/|text\/)/.test(a.contentType))
    .map((a) => a.content.toString('utf8', 0, 20_000))
    .join('\n');
  return `${email.text}\n${attached}`;
}

export function classifyInbound(email: ParsedEmail, ownAddresses: string[]): InboundClass {
  const from = email.from?.email;
  if (!from) return { kind: 'invalid', reason: 'The email has no sender address.' };
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const [local] = from.split('@');
  const h = email.headers;

  if (own.has(from)) return { kind: 'loop', reason: 'Sent from one of this workspace’s own addresses.' };
  if (h[OUR_MAIL_HEADER] && !BOUNCE_SENDERS.test(local)) return { kind: 'loop', reason: 'A copy of an email this workspace sent came back.' };

  const contentType = (h['content-type'] || '').toLowerCase();
  const isReport = contentType.includes('multipart/report') || contentType.includes('delivery-status');
  if (BOUNCE_SENDERS.test(local) || isReport || h['x-failed-recipients'] || (h['return-path'] === '<>' && BOUNCE_SUBJECT.test(email.subject))) {
    const body = sniff(email);
    const status = body.match(/^status:\s*([245])\.\d+\.\d+/im) || body.match(/\b([245])\d\d[ -]([245])\.\d+\.\d+/);
    const soft = status ? status[1] === '4' : /mailbox full|over quota|temporar|delayed/i.test(body);
    const original = body.match(MESSAGE_ID_IN_TEXT)?.[1] || null;
    const recipient =
      body.match(/^final-recipient:\s*rfc822;\s*([^\s]+)/im)?.[1] || (h['x-failed-recipients'] || '').split(/[,\s]+/)[0] || null;
    const reason = (body.match(/^diagnostic-code:\s*(.+)$/im)?.[1] || email.subject || 'The email could not be delivered.').trim().slice(0, 300);
    return { kind: 'bounce', reason, hard: !soft, originalMessageId: original ? original.toLowerCase() : null, recipient: recipient ? recipient.toLowerCase() : null };
  }

  const auto = (h['auto-submitted'] || '').trim().toLowerCase();
  if (auto && auto !== 'no') return { kind: 'auto_reply', reason: `Auto-Submitted: ${auto}` };
  if (h['x-autoreply'] || h['x-autorespond']) return { kind: 'auto_reply', reason: 'Marked as an automatic reply.' };
  if (/^(bulk|junk|auto_reply|list)$/i.test((h['precedence'] || '').trim())) return { kind: 'auto_reply', reason: `Precedence: ${h['precedence'].trim()}` };
  if (h['list-id'] || h['list-unsubscribe'] || h['list']) return { kind: 'auto_reply', reason: 'Sent by a mailing list.' };
  if (h['x-auto-response-suppress'] && /\b(oof|autoreply|all)\b/i.test(h['x-auto-response-suppress']) && AUTO_SUBJECT.test(email.subject)) {
    return { kind: 'auto_reply', reason: 'Out-of-office reply.' };
  }
  if (AUTO_SUBJECT.test(email.subject)) return { kind: 'auto_reply', reason: 'Looks like an automatic reply.' };
  if (NO_REPLY.test(local)) return { kind: 'auto_reply', reason: 'Sent from a no-reply address.' };

  return { kind: 'person' };
}
