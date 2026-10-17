import { serviceClient } from '@/lib/supabase/service';
import { domainOf, normalizeEmail } from './addresses';
import { emailConfig } from './config';
import type { SenderSettings, WorkspaceBrand } from './compose';

/**
 * Facts about a workspace's email channel that the adapter, the notification
 * sender and the channel page all need: its settings, brand and suppressions.
 * Server-only (service role); callers have already checked the workspace.
 */

export interface EmailSettings {
  forwarding_address?: string;
  custom_address?: string | null;
  from_name?: string | null;
  signature?: string | null;
  sending_domain?: string | null;
  domain_ref?: string | null;
  domain_verified_at?: string | null;
  domain_records?: unknown;
  forwarding_verified_at?: string | null;
  forwarding_check?: { code: string; sent_at: string } | null;
}

export function senderSettingsFrom(settings: EmailSettings, fallbackAddress: string): SenderSettings {
  const cfg = emailConfig();
  const forwardingAddress = settings.forwarding_address || fallbackAddress;
  return {
    forwardingAddress,
    customAddress: settings.custom_address || null,
    domainVerified: Boolean(settings.domain_verified_at),
    fromName: settings.from_name || null,
    signature: settings.signature || null,
    platformFromDomain: cfg.fromDomain || domainOf(forwardingAddress),
  };
}

export async function loadBrand(workspaceId: string): Promise<WorkspaceBrand> {
  const { data } = await serviceClient().from('workspaces').select('id, name, brand_color, logo_url').eq('id', workspaceId).maybeSingle();
  return { id: workspaceId, name: data?.name || 'Support', brandColor: data?.brand_color ?? null, logoUrl: data?.logo_url ?? null };
}

export async function isSuppressed(workspaceId: string, email: string): Promise<boolean> {
  const { data } = await serviceClient().from('email_suppressions').select('email').eq('workspace_id', workspaceId).eq('email', normalizeEmail(email)).maybeSingle();
  return Boolean(data);
}

export async function logInbound(entry: {
  workspaceId: string;
  messageId?: string | null;
  from?: string | null;
  subject?: string | null;
  outcome: string;
  detail?: string | null;
  ticketId?: string | null;
}): Promise<void> {
  const { error } = await serviceClient().from('email_inbound_log').insert({
    workspace_id: entry.workspaceId,
    message_id: entry.messageId ?? null,
    from_email: entry.from ?? null,
    subject: (entry.subject ?? '').slice(0, 250) || null,
    outcome: entry.outcome,
    detail: entry.detail?.slice(0, 500) ?? null,
    ticket_id: entry.ticketId ?? null,
  });
  if (error) console.error('[Email Inbound Log Error]:', error.message);
}
