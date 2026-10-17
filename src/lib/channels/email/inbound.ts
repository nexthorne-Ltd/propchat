import { createHash } from 'node:crypto';
import { serviceClient } from '@/lib/supabase/service';
import { isCloudinaryConfigured, uploadToCloudinary } from '@/lib/cloudinary';
import { loadConnectionByAccount, updateConnection, type LoadedConnection } from '@/lib/channels/store';
import { normalizeEmail, splitTaggedAddress, ticketNumberFromSubject, verifiedTicketFromTag, cleanSubject } from './addresses';
import { classifyInbound } from './classify';
import { emailConfig } from './config';
import { sanitizeEmailHtml } from './html';
import { getEmailProvider } from './providers';
import { splitQuotedText } from './quote';
import { logInbound, type EmailSettings } from './runtime';
import type { ParsedEmail } from './types';

/**
 * Everything an inbound email does, independent of the HTTP framework:
 * authenticate, parse, find the workspace, drop machines and loops, work out
 * which ticket it belongs to, keep its attachments, and store it in one
 * transaction (fn_email_ingest_inbound).
 *
 * Status codes follow the same rule as the other channels: providers retry
 * anything that is not a 2xx, so a bad credential is 401, an email we choose
 * not to turn into a ticket is 200 (retrying cannot change our mind), and a
 * database failure is 500 so the provider tries again. Storing is idempotent
 * on the email's Message-ID, so a retry is harmless.
 */

export interface EmailWebhookOutcome {
  status: number;
  body: string;
  followUps: (() => Promise<void>)[];
  workspaceId?: string;
}

const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|com|scr|msi|js|jse|vbs|vbe|jar|ps1|sh|apk|dll|lnk|app|dmg|iso)$/i;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_HTML_CHARS = 100_000;

interface StoredAttachment {
  name: string;
  type: string;
  size: number;
  url: string | null;
  inline: boolean;
  cid?: string;
  /** Why the file has no link: blocked type, too large, storage not set up. */
  skipped?: string;
}

async function storeAttachments(workspaceId: string, mail: ParsedEmail): Promise<{ list: StoredAttachment[]; cidMap: Record<string, string> }> {
  const list: StoredAttachment[] = [];
  const cidMap: Record<string, string> = {};
  for (const [index, a] of mail.attachments.entries()) {
    const base = { name: a.filename.slice(0, 200), type: a.contentType, size: a.size, inline: a.inline, ...(a.contentId ? { cid: a.contentId } : {}) };
    if (index >= MAX_FILES) {
      list.push({ ...base, url: null, skipped: 'Too many attachments.' });
    } else if (BLOCKED_EXTENSIONS.test(a.filename)) {
      list.push({ ...base, url: null, skipped: 'This file type is blocked for safety.' });
    } else if (a.size > MAX_FILE_BYTES || a.content.length > MAX_FILE_BYTES) {
      list.push({ ...base, url: null, skipped: 'Larger than 10 MB.' });
    } else if (!isCloudinaryConfigured()) {
      list.push({ ...base, url: null, skipped: 'File storage is not set up (Cloudinary).' });
    } else {
      try {
        const uploaded = await uploadToCloudinary(a.content, {
          folder: `channels/${workspaceId}/email`,
          filename: a.filename,
          resourceType: a.contentType.startsWith('image/') ? 'image' : 'raw',
        });
        list.push({ ...base, url: uploaded.secure_url });
        if (a.contentId) cidMap[a.contentId] = uploaded.secure_url;
      } catch (err) {
        console.error('[Email Inbound Error]: attachment upload failed:', (err as Error).message);
        list.push({ ...base, url: null, skipped: 'The file could not be stored.' });
      }
    }
  }
  return { list, cidMap };
}

/** A stable id for the rare email that has no Message-ID, so retries still dedupe. */
function fallbackMessageId(mail: ParsedEmail): string {
  const hash = createHash('sha256').update(`${mail.from?.email}|${mail.date.toISOString()}|${mail.subject}|${mail.text}`).digest('hex').slice(0, 32);
  return `generated-${hash}@zentry.invalid`;
}

export async function handleEmailWebhook(request: Request, origin: string): Promise<EmailWebhookOutcome> {
  const followUps: EmailWebhookOutcome['followUps'] = [];
  const provider = getEmailProvider();
  if (!provider.verifyInbound(request.headers)) return { status: 401, body: 'Unauthorized', followUps };

  const raw = await request.text();
  let mail: ParsedEmail;
  try {
    mail = await provider.parseInbound(raw);
  } catch (err) {
    console.error('[Email Inbound Error]: could not parse the webhook body:', (err as Error).message);
    return { status: 200, body: 'Ignored: not an email', followUps };
  }
  return processInboundEmail(mail, origin);
}

export async function processInboundEmail(mail: ParsedEmail, origin: string): Promise<EmailWebhookOutcome> {
  const followUps: EmailWebhookOutcome['followUps'] = [];
  const cfg = emailConfig();
  const sb = serviceClient();

  // 1. Which workspace was this sent to? The address it was delivered to, minus any +tag.
  let conn: LoadedConnection<{ provider?: string }> | null = null;
  let tag: string | null = mail.mailboxHash || null;
  const candidates = [...mail.envelopeTo, ...mail.to.map((a) => a.email), ...mail.cc.map((a) => a.email)];
  for (const candidate of candidates) {
    const { base, tag: t } = splitTaggedAddress(candidate);
    conn = await loadConnectionByAccount<{ provider?: string }>('email', base);
    if (conn) {
      tag = t || tag;
      break;
    }
  }
  if (!conn) return { status: 200, body: 'Ignored: unknown recipient', followUps };
  const workspaceId = conn.connection.workspace_id;
  const settings = (conn.connection.settings || {}) as EmailSettings;
  const logBase = { workspaceId, messageId: mail.messageId, from: mail.from?.email, subject: mail.subject };
  const own = [conn.connection.external_account_id, settings.custom_address, settings.forwarding_address].filter((a): a is string => Boolean(a)).map(normalizeEmail);

  // 2. The forwarding check comes first: it is our own test email (so it carries our headers and
  // comes From our own address) forwarded back from the customer's address, and only the code,
  // known to us and stored on the connection, proves it.
  const check = settings.forwarding_check;
  if (check?.code && `${mail.subject}\n${mail.text}`.includes(check.code)) {
    await updateConnection(conn.connection.id, {
      settings: { ...conn.connection.settings, forwarding_verified_at: new Date().toISOString(), forwarding_check: null },
    });
    await logInbound({ ...logBase, outcome: 'forwarding_verified', detail: 'The test email arrived through your forwarding.' });
    return { status: 200, body: 'Forwarding verified', followUps, workspaceId };
  }

  // 3. Machines and loops end here, and are recorded so an admin can see why.
  const kind = classifyInbound(mail, own);
  if (kind.kind === 'bounce') {
    const { error } = await sb.rpc('fn_email_record_bounce', {
      p_connection_id: conn.connection.id,
      p_original_message_id: kind.originalMessageId,
      p_recipient: kind.recipient,
      p_reason: kind.reason,
      p_hard: kind.hard,
    });
    if (error) {
      console.error('[Email Inbound Error]: bounce:', error.message);
      return { status: 500, body: 'Could not record the bounce', followUps, workspaceId };
    }
    await logInbound({ ...logBase, outcome: 'ignored_bounce', detail: `${kind.hard ? 'Hard' : 'Soft'} bounce${kind.recipient ? ` for ${kind.recipient}` : ''}: ${kind.reason}` });
    return { status: 200, body: 'Bounce recorded', followUps, workspaceId };
  }
  if (kind.kind !== 'person') {
    const outcome = kind.kind === 'auto_reply' ? 'ignored_auto_reply' : kind.kind === 'loop' ? 'ignored_loop' : 'ignored_invalid';
    await logInbound({ ...logBase, outcome, detail: kind.reason });
    return { status: 200, body: 'Ignored', followUps, workspaceId };
  }
  const from = mail.from!;

  // 4. Already stored? (A provider retry.) Skip the slow work.
  const messageId = mail.messageId || fallbackMessageId(mail);
  const { data: seen } = await sb.from('messages').select('id').eq('channel_message_id', messageId).maybeSingle();
  if (seen) return { status: 200, body: 'Duplicate', followUps, workspaceId };

  // 5. Which ticket? Headers decide in SQL; here only the parts that need a secret or parsing.
  const verifiedTicket = cfg.tokenSecret ? verifiedTicketFromTag(tag, cfg.tokenSecret, workspaceId) : null;
  const subjectTicket = ticketNumberFromSubject(mail.subject);

  // 6. What to store: the new text only, sanitised HTML, files, and who else is on the thread.
  const { reply, quoted } = splitQuotedText(mail.text);
  const { list: attachments, cidMap } = await storeAttachments(workspaceId, mail);
  const html = mail.html ? sanitizeEmailHtml(mail.html, cidMap).html.slice(0, MAX_HTML_CHARS) : null;
  const copied = [...mail.to, ...mail.cc]
    .filter((a) => !own.includes(a.email) && a.email !== from.email && !a.email.endsWith(`@${cfg.inboundDomain}`))
    .map((a) => ({ email: a.email, name: a.name ?? '' }));
  const content = reply || (attachments.length ? '(attachment only)' : '(empty email)');

  const { data, error } = await sb.rpc('fn_email_ingest_inbound', {
    p_connection_id: conn.connection.id,
    p_from_email: from.email,
    p_from_name: from.name ?? null,
    p_message_id: messageId,
    p_in_reply_to: mail.inReplyTo,
    p_references: mail.references,
    p_verified_ticket_number: verifiedTicket,
    p_subject_ticket_number: subjectTicket,
    p_subject: cleanSubject(mail.subject) || mail.subject,
    p_content: content,
    p_attachments: attachments,
    p_metadata: {
      email: {
        subject: mail.subject,
        from: { email: from.email, name: from.name ?? '' },
        to: mail.to,
        cc: mail.cc,
        in_reply_to: mail.inReplyTo,
        ...(html ? { html } : {}),
        ...(quoted ? { quoted: quoted.slice(0, 10_000) } : {}),
      },
    },
    p_cc: copied,
    p_sent_at: mail.date.toISOString(),
  });

  if (error) {
    if (error.hint === 'email_rate_limited' || /Too many emails/.test(error.message)) {
      await logInbound({ ...logBase, outcome: 'ignored_loop', detail: `${from.email} sent too many emails in 10 minutes; paused.` });
      return { status: 200, body: 'Rate limited', followUps, workspaceId };
    }
    console.error('[Email Inbound Error]:', error.message);
    await logInbound({ ...logBase, outcome: 'failed', detail: error.message });
    return { status: 500, body: 'Could not store the email; please retry', followUps, workspaceId };
  }

  const result = data as { duplicate: boolean; created?: boolean; ticket_id?: string; conversation_id?: string; ai_mode?: string | null; message_id?: string; matched_by?: string };
  if (result.duplicate) return { status: 200, body: 'Duplicate', followUps, workspaceId };
  await logInbound({
    ...logBase,
    outcome: result.created ? 'ticket_created' : 'ticket_updated',
    detail: result.created ? undefined : `Added to an existing ticket (matched by ${result.matched_by}).`,
    ticketId: result.ticket_id,
  });

  if ((result.ai_mode ?? 'autopilot') === 'autopilot' && result.conversation_id) {
    followUps.push(async () => {
      await fetch(`${origin}/api/ai/auto-respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: result.conversation_id, workspace_id: workspaceId, message_id: result.message_id }),
      }).catch((err) => console.error('[Email Inbound Error]: could not hand the email to the bot:', err));
    });
  }
  return { status: 200, body: 'OK', followUps, workspaceId };
}
