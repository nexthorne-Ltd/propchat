/**
 * Sends what rules asked for. The database can only queue emails and webhooks
 * (automation_outbox); this drains the queue. It runs hourly from
 * /api/cron/run-automations and, so a reply or an edit does not wait for the
 * hour, after ticket actions from agents.
 *
 * Service role: the outbox has no row level security policy on purpose, and
 * every row already carries the workspace it belongs to.
 */
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { serviceClient } from '@/lib/supabase/service';
import { isValidEmail, sendSmtpEmail, teamMessageEmail } from '@/lib/email/smtp';
import { loadWorkspaceSmtp } from '@/lib/email/workspace-smtp';
import { isPrivateAddress, isSafeWebhookUrl } from '@/lib/automation/rules';
import { emailConfig } from '@/lib/channels/email/config';
import { composeNotification } from '@/lib/channels/email/compose';
import { getEmailProvider } from '@/lib/channels/email/providers';
import { isSuppressed, loadBrand, senderSettingsFrom, type EmailSettings } from '@/lib/channels/email/runtime';
import type { NotificationTemplate } from '@/lib/channels/email/template';
import { getConnection } from '@/lib/channels/store';

import { generateCsatToken } from '@/lib/csat/token';
import { getRequestOrigin } from '@/lib/request-origin';

const MAX_ATTEMPTS = 5;
const CLAIM_MINUTES = 5;

interface OutboxRow {
  id: string;
  workspace_id: string;
  kind: 'email_requester' | 'email_agent' | 'webhook';
  payload: Record<string, unknown>;
  attempts: number;
}

/** Backoff: 1, 5, 25, 125 minutes. */
export function retryDelayMinutes(attemptsSoFar: number): number {
  return Math.pow(5, Math.max(0, attemptsSoFar - 1));
}

/** The requester notifications (received / replied / solved): branded mail through the email channel. */
async function sendNotification(row: OutboxRow, to: string): Promise<{ ok: boolean; error?: string; permanent?: boolean }> {
  const template = String(row.payload.template) as NotificationTemplate;
  if (!['received', 'replied', 'solved'].includes(template)) return { ok: false, error: 'Unknown notification.', permanent: true };
  const connection = await getConnection(row.workspace_id, 'email');
  if (!connection || connection.status === 'disconnected') {
    return { ok: false, error: 'The email channel is not enabled (Settings → Channels → Email).', permanent: true };
  }
  const cfg = emailConfig();
  const provider = getEmailProvider();
  if (!cfg.tokenSecret || !provider.isConfigured()) return { ok: false, error: 'The email provider is not configured on the server.', permanent: true };
  if (await isSuppressed(row.workspace_id, to)) return { ok: false, error: `${to} is blocked because an earlier email to it bounced.`, permanent: true };

  const ticketId = String(row.payload.ticket_id || (row as unknown as { ticket_id?: string }).ticket_id || '');
  let csatLinks = undefined;
  if (template === 'solved' && ticketId) {
    const appUrl = (await getRequestOrigin()).replace(/\/$/, '');
    const token = generateCsatToken(ticketId, row.workspace_id);
    csatLinks = {
      goodUrl: `${appUrl}/csat/${ticketId}?rating=good&token=${token}`,
      badUrl: `${appUrl}/csat/${ticketId}?rating=bad&token=${token}`,
    };
  }

  const email = composeNotification({
    workspace: await loadBrand(row.workspace_id),
    sender: senderSettingsFrom((connection.settings || {}) as EmailSettings, connection.external_account_id || ''),
    tokenSecret: cfg.tokenSecret,
    to: { email: to, name: String(row.payload.requester_name ?? '') || undefined },
    template,
    ticket: { number: Number(row.payload.ticket_number), subject: String(row.payload.ticket_subject ?? ''), id: ticketId || undefined },
    agentName: String(row.payload.agent_name ?? '') || null,
    reply: String(row.payload.reply ?? '') || null,
    csatLinks,
  });
  const result = await provider.send(email);
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error, permanent: !result.retryable };
}

async function sendEmail(row: OutboxRow): Promise<{ ok: boolean; error?: string; permanent?: boolean }> {
  const to = String(row.payload.to ?? '');
  if (!isValidEmail(to)) return { ok: false, error: 'The recipient has no valid email address.', permanent: true };
  if (row.payload.template) return sendNotification(row, to);
  const smtp = await loadWorkspaceSmtp(row.workspace_id);
  if (!smtp) {
    return { ok: false, error: 'SMTP is not set up for this workspace (Settings → Channels → Email).', permanent: true };
  }
  const body = String(row.payload.body ?? '');
  const { data: ws } = await serviceClient()
    .from('workspaces')
    .select('name, brand_color, logo_url')
    .eq('id', row.workspace_id)
    .maybeSingle();
  const brandName = (ws?.name as string) || smtp.from_name || 'Support';
  const email = teamMessageEmail({
    brandName,
    brandColor: ws?.brand_color as string | null,
    logoUrl: ws?.logo_url as string | null,
    subject: String(row.payload.subject ?? '').slice(0, 200) || `A message from ${brandName}`,
    body,
    footer:
      row.kind === 'email_agent'
        ? `You received this automatic message as a member of ${brandName}.`
        : `You received this because you have a request open with ${brandName}.`,
  });
  const sent = await sendSmtpEmail(smtp, {
    to,
    subject: email.subject,
    text: email.text,
    html: email.html,
    headers: { 'Auto-Submitted': 'auto-generated' },
  });
  return sent.success ? { ok: true } : { ok: false, error: sent.error || 'Email could not be sent.' };
}

/**
 * POSTs a signed JSON body to a public https URL. The signature header is
 * `X-Zentry-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>`.
 * Private and internal addresses are refused, before and after DNS, and
 * redirects are not followed, so the endpoint cannot bounce us inward.
 */
export async function deliverSignedWebhook(
  url: string,
  secret: string,
  event: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; error?: string; permanent?: boolean; status?: number }> {
  if (!isSafeWebhookUrl(url)) return { ok: false, error: 'The webhook address is not a public https URL.', permanent: true };
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.some((a) => isPrivateAddress(a.address))) {
      return { ok: false, error: 'The webhook address resolves to a private network.', permanent: true };
    }
  } catch {
    return { ok: false, error: 'The webhook address could not be resolved.' };
  }

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'Zentry-Webhook/1', 'X-Zentry-Event': event };
  if (secret) headers['X-Zentry-Signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  try {
    const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return res.status >= 200 && res.status < 300
      ? { ok: true, status: res.status }
      : { ok: false, error: `The endpoint answered ${res.status}.`, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'The endpoint could not be reached.' };
  }
}

async function sendWebhook(row: OutboxRow): Promise<{ ok: boolean; error?: string; permanent?: boolean }> {
  const p = row.payload;
  const event = String(p.event ?? '');
  const secret = typeof p.secret === 'string' ? p.secret : '';
  // Settings → Webhooks deliveries carry the event data; automation rule
  // webhooks keep the shape they always had.
  const body: Record<string, unknown> = p.webhook_id
    ? {
        id: row.id,
        event,
        workspace_id: p.workspace_id,
        occurred_at: p.occurred_at,
        ...(p.ticket ? { ticket: p.ticket } : {}),
        ...(p.message ? { message: p.message } : {}),
        ...(p.previous ? { previous: p.previous } : {}),
      }
    : { event, rule: p.rule, ticket: p.ticket };
  return deliverSignedWebhook(String(p.url ?? ''), secret, event, body);
}

/** Records the latest delivery on a Settings → Webhooks endpoint (best effort). */
async function recordWebhookResult(row: OutboxRow, ok: boolean, error?: string) {
  const webhookId = row.payload.webhook_id;
  if (row.kind !== 'webhook' || typeof webhookId !== 'string') return;
  const { error: updateError } = await serviceClient()
    .from('workspace_webhooks')
    .update({ last_delivery_at: new Date().toISOString(), last_status: ok ? 'sent' : 'failed', last_error: ok ? null : (error || 'Failed').slice(0, 300) })
    .eq('id', webhookId);
  if (updateError) console.warn('[Webhook] Could not record the delivery:', updateError.message);
}

/** Sends due rows. Returns how many were sent and how many failed for good. */
export async function processAutomationOutbox(opts: { workspaceId?: string; limit?: number } = {}): Promise<{ sent: number; failed: number }> {
  const supabase = serviceClient();
  let query = supabase
    .from('automation_outbox')
    .select('id, workspace_id, kind, payload, attempts')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('created_at')
    .limit(opts.limit ?? 25);
  if (opts.workspaceId) query = query.eq('workspace_id', opts.workspaceId);
  const { data, error } = await query;
  if (error) {
    console.error('[Automation Outbox Error]:', error);
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;
  for (const row of (data || []) as OutboxRow[]) {
    // Claim the row: push its next attempt out first, so a second worker skips it.
    const claim = await supabase
      .from('automation_outbox')
      .update({ attempts: row.attempts + 1, next_attempt_at: new Date(Date.now() + CLAIM_MINUTES * 60_000).toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .eq('attempts', row.attempts)
      .select('id')
      .maybeSingle();
    if (!claim.data) continue;

    const result = row.kind === 'webhook' ? await sendWebhook(row) : await sendEmail(row);
    const attempts = row.attempts + 1;
    if (result.ok || result.permanent || attempts >= MAX_ATTEMPTS) await recordWebhookResult(row, result.ok, result.error);
    if (result.ok) {
      sent++;
      await supabase.from('automation_outbox').update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null }).eq('id', row.id);
    } else if (result.permanent || attempts >= MAX_ATTEMPTS) {
      failed++;
      await supabase.from('automation_outbox').update({ status: 'failed', last_error: result.error ?? 'Failed' }).eq('id', row.id);
      console.error('[Automation Outbox Error]:', row.kind, result.error);
    } else {
      await supabase
        .from('automation_outbox')
        .update({ last_error: result.error ?? 'Failed', next_attempt_at: new Date(Date.now() + retryDelayMinutes(attempts) * 60_000).toISOString() })
        .eq('id', row.id);
    }
  }
  return { sent, failed };
}
