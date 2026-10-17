import { randomUUID } from 'node:crypto';
import { domainOf, normalizeEmail, replySubject, taggedAddress } from './addresses';
import { DEFAULT_SIGNATURE } from './settings';
import { renderBrandedEmail, notificationContent, type NotificationTemplate } from './template';
import type { OutboundEmail } from './types';

/**
 * Building the emails we send. Pure: the channel adapter and the notification
 * sender gather the facts from the database and pass them in, so what goes on
 * the wire (From, Reply-To, threading headers, loop-prevention headers) is
 * decided, and tested, in one place.
 */

export interface SenderSettings {
  /** `<slug>@<inbound domain>`: the address replies come back to. Always set. */
  forwardingAddress: string;
  /** The address customers know, e.g. help@acme.com. Used as From only once its domain is verified. */
  customAddress?: string | null;
  domainVerified?: boolean;
  fromName?: string | null;
  /** Plain text under every reply. `{{agent.name}}` and `{{workspace.name}}` are filled in. */
  signature?: string | null;
  /** The platform's own sending domain, for when the custom domain is not verified. */
  platformFromDomain: string;
}

export interface WorkspaceBrand {
  id: string;
  name: string;
  brandColor?: string | null;
  logoUrl?: string | null;
}


export function renderSignature(template: string | null | undefined, agentName: string, workspaceName: string): string {
  return (template?.trim() ? template : DEFAULT_SIGNATURE)
    .replace(/\{\{\s*agent\.name\s*\}\}/g, agentName || 'Support')
    .replace(/\{\{\s*workspace\.name\s*\}\}/g, workspaceName)
    .trim();
}

/** The address mail is sent From: the customer's own once DKIM passes, else the platform's. */
export function fromAddressFor(s: SenderSettings): string {
  return s.customAddress && s.domainVerified ? normalizeEmail(s.customAddress) : normalizeEmail(s.forwardingAddress);
}

function messageIdFor(from: string, fallbackDomain: string): string {
  return `${randomUUID()}@${domainOf(from) || fallbackDomain}`;
}

export interface ReplyInput {
  workspace: WorkspaceBrand;
  sender: SenderSettings;
  tokenSecret: string;
  to: { email: string; name?: string };
  cc?: string[];
  ticket: { number: number; subject: string };
  agentName: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

/** An agent's (or the bot's) reply on a ticket. It is a person's mail: no auto-reply headers. */
export function composeReply(input: ReplyInput): OutboundEmail & { messageId: string } {
  const { workspace, sender } = input;
  const from = fromAddressFor(sender);
  const messageId = messageIdFor(from, sender.platformFromDomain);
  const { html, text } = renderBrandedEmail({
    workspaceName: workspace.name,
    brandColor: workspace.brandColor,
    logoUrl: workspace.logoUrl,
    body: input.text,
    signature: renderSignature(sender.signature, input.agentName, workspace.name),
    ticketNumber: input.ticket.number,
  });
  const refs = (input.references || []).slice(-15);
  const headers: Record<string, string> = {
    'Message-ID': `<${messageId}>`,
    'X-Zentry-Mail': '1',
    ...(input.inReplyTo ? { 'In-Reply-To': `<${input.inReplyTo}>` } : {}),
    ...(refs.length ? { References: refs.map((r) => `<${r}>`).join(' ') } : {}),
  };
  return {
    messageId,
    from: { email: from, name: sender.fromName?.trim() || workspace.name },
    to: [input.to],
    cc: (input.cc || []).map((email) => ({ email })),
    // Replies come back to the platform address with the signed ticket token, wherever From points.
    replyTo: taggedAddress(sender.forwardingAddress, input.tokenSecret, workspace.id, input.ticket.number),
    subject: replySubject(input.ticket.subject, input.ticket.number),
    text,
    html,
    headers,
    attachments: input.attachments,
  };
}

export interface NotificationEmailInput {
  workspace: WorkspaceBrand;
  sender: SenderSettings;
  tokenSecret: string;
  to: { email: string; name?: string };
  template: NotificationTemplate;
  ticket: { number: number; subject: string; id?: string };
  agentName?: string | null;
  reply?: string | null;
  csatLinks?: { goodUrl: string; badUrl: string } | null;
}

/** "Received", "replied" or "solved". Automatic: marked so the other side never auto-answers it. */
export function composeNotification(input: NotificationEmailInput): OutboundEmail & { messageId: string } {
  const { workspace, sender } = input;
  const from = fromAddressFor(sender);
  const messageId = messageIdFor(from, sender.platformFromDomain);
  const content = notificationContent({
    template: input.template,
    requesterName: input.to.name || '',
    ticketNumber: input.ticket.number,
    ticketSubject: input.ticket.subject,
    reply: input.reply,
    agentName: input.agentName,
  });
  const { html, text } = renderBrandedEmail({
    workspaceName: workspace.name,
    brandColor: workspace.brandColor,
    logoUrl: workspace.logoUrl,
    body: content.body,
    signature: renderSignature(sender.signature, input.agentName || 'The team', workspace.name),
    ticketNumber: input.ticket.number,
    csatLinks: input.csatLinks,
  });
  return {
    messageId,
    from: { email: from, name: sender.fromName?.trim() || workspace.name },
    to: [input.to],
    replyTo: taggedAddress(sender.forwardingAddress, input.tokenSecret, workspace.id, input.ticket.number),
    subject: content.subject,
    text,
    html,
    headers: {
      'Message-ID': `<${messageId}>`,
      'X-Zentry-Mail': '1',
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
      Precedence: 'auto_reply',
    },
  };
}
