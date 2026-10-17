import { NextResponse, after } from 'next/server';
import { handleWebhookChallenge, handleWebhookPost } from '@/lib/channels/inbound';
import { processOutboundQueue } from '@/lib/channels/outbound';
import { hasServiceRole } from '@/lib/supabase/service';
import { handleEmailWebhook } from '@/lib/channels/email/inbound';
import { processAutomationOutbox } from '@/lib/automation/outbox';

/**
 * Shared by the platform webhook URL (/api/channels/<channel>/webhook, used by
 * embedded signup) and the per-connection one
 * (/api/channels/<channel>/webhook/<connectionId>, used by manual setup with
 * the customer's own Meta app). All the logic is in src/lib/channels/inbound.ts.
 */

export async function verify(request: Request, channel: string, connectionId?: string) {
  // Providers ping an email webhook URL with GET when it is saved; there is no handshake.
  if (channel === 'email') return new NextResponse('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  const { status, body, contentType } = await handleWebhookChallenge(channel, new URL(request.url).searchParams, connectionId);
  return new NextResponse(body, { status, headers: { 'Content-Type': contentType || 'text/plain' } });
}

export async function receive(request: Request, channel: string, connectionId?: string) {
  if (!hasServiceRole()) {
    console.error('[Channels Webhook Error]: SUPABASE_SERVICE_ROLE_KEY is not set; cannot store inbound messages.');
    return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  }
  if (channel === 'email') {
    // Email is not a Meta payload: it has its own parser and authentication (src/lib/channels/email/inbound.ts).
    const outcome = await handleEmailWebhook(request, process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin);
    for (const job of outcome.followUps) {
      after(() => job().catch((err) => console.error('[Email Webhook Follow-up Error]:', err)));
    }
    if (outcome.status === 200 && outcome.workspaceId) {
      // Rules may have queued notifications for this email; send them now.
      after(() => processAutomationOutbox({ workspaceId: outcome.workspaceId, limit: 10 }).then(() => undefined));
      after(() => processOutboundQueue({ limit: 20 }).then(() => undefined));
    }
    return new NextResponse(outcome.body, { status: outcome.status, headers: { 'Content-Type': 'text/plain' } });
  }
  // The signature covers the exact bytes Meta sent, so read text, not JSON.
  const rawBody = await request.text();
  const outcome = await handleWebhookPost({
    channel,
    rawBody,
    headers: request.headers,
    connectionId,
    origin: process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin,
  });
  // Answer Meta now; media downloads and the bot run after the response.
  for (const job of outcome.followUps) {
    after(() => job().catch((err) => console.error('[Channels Webhook Follow-up Error]:', err)));
  }
  // Webhooks arrive all day (receipts, messages): a cheap moment to send any
  // retries that have come due, so they do not wait for the daily cron.
  if (outcome.status === 200) {
    after(() => processOutboundQueue({ limit: 20 }).then(() => undefined));
  }
  return new NextResponse(outcome.body, { status: outcome.status, headers: { 'Content-Type': 'text/plain' } });
}
