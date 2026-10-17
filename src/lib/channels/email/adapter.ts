import { serviceClient } from '@/lib/supabase/service';
import { emailConfig } from './config';
import { composeReply } from './compose';
import { getEmailProvider } from './providers';
import { isSuppressed, loadBrand, senderSettingsFrom, type EmailSettings } from './runtime';
import type { ChannelAdapter, ChannelContext, OutboundContent, OutboundMedia, SendResult } from '@/lib/channels/types';
import type { EmailSendContext } from './types';
import { userError } from '@/lib/errors/user-error';

/**
 * Email on the channel framework. Inbound mail does not go through
 * parseWebhook (an email carries far more than a chat message: threading
 * headers, attachments, CC): /api/channels/email/webhook hands it to
 * ./inbound.ts, which ends in fn_email_ingest_inbound. Outbound is the normal
 * path: the database queues every public reply and the worker calls
 * sendMessage / sendMedia here.
 */

export interface EmailCredentials {
  /** Which provider the connection was made with; nothing secret is needed, the keys live in the environment. */
  provider: string;
}

type Ctx = ChannelContext<EmailCredentials>;

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function deliver(ctx: Ctx, to: string, context: EmailSendContext | undefined, text: string, attachment?: { filename: string; contentType: string; content: Buffer }): Promise<SendResult> {
  if (!context) return { ok: false, error: 'This email has no ticket to belong to.', retryable: false };
  const cfg = emailConfig();
  if (!cfg.tokenSecret) return { ok: false, error: 'EMAIL_TOKEN_SECRET is not set on the server.', retryable: false, needsAttention: true };
  const workspaceId = ctx.connection.workspace_id;
  if (await isSuppressed(workspaceId, to)) {
    return { ok: false, error: `${to} is blocked because an earlier email to it bounced. Remove it from the blocked list in Settings → Channels → Email if the address is fixed.`, retryable: false };
  }

  const provider = getEmailProvider();
  if (!provider.isConfigured()) return { ok: false, error: 'The email provider is not configured on the server.', retryable: false, needsAttention: true };

  const settings = (ctx.connection.settings || {}) as EmailSettings;
  const brand = await loadBrand(workspaceId);
  const email = composeReply({
    workspace: brand,
    sender: senderSettingsFrom(settings, ctx.connection.external_account_id || ''),
    tokenSecret: cfg.tokenSecret,
    to: { email: to },
    cc: (context.cc || []).filter((c) => c.toLowerCase() !== to.toLowerCase()),
    ticket: { number: context.ticketNumber, subject: context.ticketSubject },
    agentName: context.agentName || 'Support',
    text,
    inReplyTo: context.inReplyTo,
    references: context.references,
    attachments: attachment ? [attachment] : undefined,
  });

  const result = await provider.send(email);
  if (!result.ok) {
    return { ok: false, error: result.error, retryable: result.retryable, needsAttention: result.needsAttention };
  }
  // Our Message-ID is what a reply's In-Reply-To names. Some providers assign their own; keep theirs as well.
  if (result.providerId && context.messageRowId) {
    const sb = serviceClient();
    const { data } = await sb.from('messages').select('metadata').eq('id', context.messageRowId).maybeSingle();
    await sb.from('messages').update({ metadata: { ...(data?.metadata || {}), email_provider_id: result.providerId } }).eq('id', context.messageRowId);
  }
  return { ok: true, providerMessageId: email.messageId };
}

async function fetchAttachment(media: OutboundMedia): Promise<{ filename: string; contentType: string; content: Buffer } | string> {
  let url: URL;
  try {
    url = new URL(media.url);
  } catch {
    return 'The attachment link is not valid.';
  }
  if (url.protocol !== 'https:') return 'The attachment must be served over https.';
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return `The attachment could not be downloaded (${res.status}).`;
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_ATTACHMENT_BYTES) return 'The attachment is larger than 10 MB.';
  const content = Buffer.from(await res.arrayBuffer());
  if (content.length > MAX_ATTACHMENT_BYTES) return 'The attachment is larger than 10 MB.';
  return { filename: media.filename || 'attachment', contentType: res.headers.get('content-type') || 'application/octet-stream', content };
}

export const emailAdapter: ChannelAdapter<EmailCredentials, Record<string, never>> = {
  id: 'email',
  label: 'Email',
  capabilities: { media: true, templates: false, readReceipts: false, serviceWindowHours: null },

  // The address is provisioned by the channel page (actions/email-channel.ts), not by checking credentials.
  async connect() {
    throw userError('Email is enabled from Settings → Channels → Email.');
  },

  verifyWebhookChallenge: () => null,
  verifyWebhookSignature: ({ headers }) => getEmailProvider().verifyInbound(headers),
  parseWebhook: () => [],

  async sendMessage(ctx: Ctx, to: string, content: OutboundContent) {
    if (content.type !== 'text') return { ok: false, error: 'Email has no message templates.', retryable: false };
    return deliver(ctx, to, content.email, content.text);
  },

  async sendMedia(ctx: Ctx, to: string, media: OutboundMedia) {
    const file = await fetchAttachment(media).catch((e: Error) => e.message);
    if (typeof file === 'string') return { ok: false, error: file, retryable: false };
    return deliver(ctx, to, media.email, media.caption || 'Please find the attached file.', file);
  },

  async markRead() {},

  async downloadMedia(_ctx, url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw userError(`Could not download the file (${res.status}).`);
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type') || 'application/octet-stream' };
  },

  async listTemplates() {
    return [];
  },

  async disconnect() {},
};
