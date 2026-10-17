'use server';

/**
 * Settings → Channels → Email: turn the channel on, set the sender's name and
 * signature, connect a custom support address (forwarding + DNS), and read the
 * inbound log. Owners and admins only. The connection itself is the same
 * channel_connections row every channel uses; its settings JSON holds what is
 * specific to email, and credentials are only the provider's name (the keys
 * live in the server environment, see docs in the pull request).
 */

import { getWorkspaceAccess } from '@/lib/team/access';
import { hasServiceRole } from '@/lib/supabase/service';
import { hasEncryptionKey, randomToken } from '@/lib/channels/crypto';
import { getConnection, saveConnection, updateConnection } from '@/lib/channels/store';
import { domainOf, forwardingAddressFor, normalizeEmail } from '@/lib/channels/email/addresses';
import { composeReply } from '@/lib/channels/email/compose';
import { emailConfig, emailSetupProblems } from '@/lib/channels/email/config';
import { getEmailProvider } from '@/lib/channels/email/providers';
import { loadBrand, senderSettingsFrom, type EmailSettings } from '@/lib/channels/email/runtime';
import { validateEmailSettings, type EmailSettingsErrors, type EmailSettingsInput } from '@/lib/channels/email/settings';
import type { DnsRecord } from '@/lib/channels/email/types';
import type { ChannelConnection } from '@/types/database';
import { assertWorkspaceLimit, assertWorkspaceFeature } from '@/lib/plans/enforce';
import { userError } from '@/lib/errors/user-error';

type Result<T = object> = ({ success: true } & T) | { success: false; error: string; fieldErrors?: EmailSettingsErrors };

function fail(err: unknown, fallback: string): { success: false; error: string } {
  const message = err instanceof Error && err.message ? err.message : fallback;
  console.error('[Email Channel Error]:', message);
  return { success: false, error: message };
}

async function guard(workspaceId: string) {
  const access = await getWorkspaceAccess(workspaceId, 'manage_settings');
  if (!hasServiceRole()) throw userError('The server is missing SUPABASE_SERVICE_ROLE_KEY, so channels cannot be managed.');
  if (!hasEncryptionKey()) throw userError('The server is missing CHANNEL_ENCRYPTION_KEY, so channel credentials cannot be stored safely.');
  return access;
}

export interface InboundLogRow {
  id: string;
  from_email: string | null;
  subject: string | null;
  outcome: string;
  detail: string | null;
  ticket_id: string | null;
  created_at: string;
}

export interface EmailChannelOverview {
  enabled: boolean;
  status: ChannelConnection['status'] | null;
  /** What the server is missing; the page says so instead of failing later. */
  problems: string[];
  provider: { id: string; configured: boolean; canAuthenticateDomains: boolean };
  forwardingAddress: string | null;
  settings: {
    from_name: string;
    signature: string;
    custom_address: string;
    domain: string | null;
    domain_verified: boolean;
    domain_records: DnsRecord[];
    forwarding_verified: boolean;
    forwarding_check_sent_at: string | null;
  };
  lastInboundAt: string | null;
  lastError: string | null;
  log: InboundLogRow[];
  suppressions: { email: string; reason: string; created_at: string }[];
}

function overviewFrom(connection: ChannelConnection | null, problems: string[], log: InboundLogRow[], suppressions: EmailChannelOverview['suppressions']): EmailChannelOverview {
  const provider = getEmailProvider();
  const s = (connection?.settings || {}) as EmailSettings;
  const live = Boolean(connection && connection.status !== 'disconnected');
  return {
    enabled: live,
    status: connection?.status ?? null,
    problems,
    provider: { id: provider.id, configured: provider.isConfigured(), canAuthenticateDomains: Boolean(provider.createSenderDomain && process.env.POSTMARK_ACCOUNT_TOKEN) },
    forwardingAddress: live ? s.forwarding_address || connection!.external_account_id : null,
    settings: {
      from_name: s.from_name || '',
      signature: s.signature || '',
      custom_address: s.custom_address || '',
      domain: s.sending_domain || null,
      domain_verified: Boolean(s.domain_verified_at),
      domain_records: Array.isArray(s.domain_records) ? (s.domain_records as DnsRecord[]) : [],
      forwarding_verified: Boolean(s.forwarding_verified_at),
      forwarding_check_sent_at: s.forwarding_check?.sent_at ?? null,
    },
    lastInboundAt: connection?.last_inbound_at ?? null,
    lastError: connection?.last_error ?? null,
    log,
    suppressions,
  };
}

async function load(workspaceId: string): Promise<EmailChannelOverview> {
  const { supabase } = await guard(workspaceId);
  const provider = getEmailProvider();
  const connection = await getConnection(workspaceId, 'email');
  const [{ data: log }, { data: suppressions }] = await Promise.all([
    supabase.from('email_inbound_log').select('id, from_email, subject, outcome, detail, ticket_id, created_at').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(25),
    supabase.from('email_suppressions').select('email, reason, created_at').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(100),
  ]);
  return overviewFrom(connection, emailSetupProblems(provider.isConfigured(), provider.id), (log || []) as InboundLogRow[], (suppressions || []) as EmailChannelOverview['suppressions']);
}

export async function getEmailChannelAction(workspaceId: string): Promise<Result<{ overview: EmailChannelOverview }>> {
  try {
    return { success: true, overview: await load(workspaceId) };
  } catch (err) {
    return fail(err, 'Could not load the email channel.');
  }
}

/** Gives the workspace its support address and switches the channel on. */
export async function enableEmailChannelAction(workspaceId: string): Promise<Result<{ overview: EmailChannelOverview }>> {
  try {
    const { supabase, user } = await guard(workspaceId);
    await assertWorkspaceLimit(workspaceId, 'max_channels_connected');
    await assertWorkspaceFeature(workspaceId, 'channel_email');
    const cfg = emailConfig();
    if (!cfg.inboundDomain) throw userError('EMAIL_INBOUND_DOMAIN is not set on the server, so a support address cannot be created.');

    const { data: ws } = await supabase.from('workspaces').select('name, slug').eq('id', workspaceId).maybeSingle();
    const existing = await getConnection(workspaceId, 'email');
    const previous = (existing?.settings || {}) as EmailSettings;
    // The address is kept once issued, even if the workspace's slug changes later: customers forward to it.
    const address = previous.forwarding_address || forwardingAddressFor(ws?.slug || `ws-${workspaceId.slice(0, 8)}`, cfg.inboundDomain);
    if (!address) throw userError('Could not build a support address for this workspace.');

    await saveConnection({
      workspaceId,
      channel: 'email',
      userId: user.id,
      setupMethod: 'manual',
      externalAccountId: address,
      externalBusinessId: null,
      displayName: address,
      settings: { ...previous, forwarding_address: address, from_name: previous.from_name ?? ws?.name ?? '' },
      credentials: { provider: getEmailProvider().id },
    });
    const { error } = await supabase.rpc('fn_install_email_notification_rules', { p_workspace_id: workspaceId });
    if (error) console.error('[Email Channel Error]: could not add notification rules:', error.message);
    return { success: true, overview: await load(workspaceId) };
  } catch (err) {
    return fail(err, 'Could not enable email.');
  }
}

export async function saveEmailSettingsAction(workspaceId: string, input: EmailSettingsInput): Promise<Result<{ overview: EmailChannelOverview }>> {
  try {
    await guard(workspaceId);
    const connection = await getConnection(workspaceId, 'email');
    if (!connection || connection.status === 'disconnected') throw userError('Enable the email channel first.');
    const settings = (connection.settings || {}) as EmailSettings;
    const forwarding = settings.forwarding_address || connection.external_account_id || '';

    const fieldErrors = validateEmailSettings(input, { inboundDomain: emailConfig().inboundDomain, forwardingAddress: forwarding });
    const first = Object.values(fieldErrors)[0];
    if (first) return { success: false, error: first, fieldErrors };

    const custom = input.custom_address.trim() ? normalizeEmail(input.custom_address) : null;
    const changedAddress = (settings.custom_address || null) !== custom;
    const next: EmailSettings = {
      ...settings,
      from_name: input.from_name.trim(),
      signature: input.signature.trim(),
      custom_address: custom,
      // A different address means a different domain and a new forwarding path: start those checks over.
      ...(changedAddress
        ? { sending_domain: null, domain_ref: null, domain_verified_at: null, domain_records: [], forwarding_verified_at: null, forwarding_check: null }
        : {}),
    };
    await updateConnection(connection.id, { settings: next as unknown as Record<string, unknown> });
    return { success: true, overview: await load(workspaceId) };
  } catch (err) {
    return fail(err, 'Could not save.');
  }
}

/** Asks the provider for the DNS records that let mail be sent From the custom address's domain. */
export async function startSenderDomainAction(workspaceId: string): Promise<Result<{ overview: EmailChannelOverview }>> {
  try {
    await guard(workspaceId);
    const connection = await getConnection(workspaceId, 'email');
    const settings = (connection?.settings || {}) as EmailSettings;
    if (!connection || !settings.custom_address) throw userError('Save your support address first.');
    const provider = getEmailProvider();
    if (!provider.createSenderDomain) throw userError('This email provider cannot authenticate domains from here.');
    const domain = domainOf(settings.custom_address);
    const status = await provider.createSenderDomain(domain);
    await updateConnection(connection.id, {
      settings: {
        ...settings,
        sending_domain: domain,
        domain_ref: status.providerRef,
        domain_records: status.records,
        domain_verified_at: status.verified ? new Date().toISOString() : null,
      } as unknown as Record<string, unknown>,
    });
    return { success: true, overview: await load(workspaceId) };
  } catch (err) {
    return fail(err, 'Could not start domain verification.');
  }
}

/** Re-checks the DNS records now. Forwarding is confirmed by the inbound webhook, so this only reloads it. */
export async function checkEmailSetupAction(workspaceId: string): Promise<Result<{ overview: EmailChannelOverview }>> {
  try {
    await guard(workspaceId);
    const connection = await getConnection(workspaceId, 'email');
    const settings = (connection?.settings || {}) as EmailSettings;
    if (connection && settings.domain_ref && settings.sending_domain) {
      const provider = getEmailProvider();
      if (provider.checkSenderDomain) {
        const status = await provider.checkSenderDomain(settings.domain_ref, settings.sending_domain);
        await updateConnection(connection.id, {
          settings: {
            ...settings,
            domain_records: status.records,
            domain_verified_at: status.verified ? settings.domain_verified_at || new Date().toISOString() : null,
          } as unknown as Record<string, unknown>,
        });
      }
    }
    return { success: true, overview: await load(workspaceId) };
  } catch (err) {
    return fail(err, 'Could not check the setup.');
  }
}

/**
 * Sends a test email to the custom address. If the customer's forwarding is
 * right, it comes back to the platform address carrying the code, and the
 * inbound handler marks forwarding as working.
 */
export async function sendForwardingTestAction(workspaceId: string): Promise<Result<{ overview: EmailChannelOverview }>> {
  try {
    await guard(workspaceId);
    const connection = await getConnection(workspaceId, 'email');
    const settings = (connection?.settings || {}) as EmailSettings;
    if (!connection || !settings.custom_address) throw userError('Save your support address first.');
    const provider = getEmailProvider();
    if (!provider.isConfigured()) throw userError('The email provider is not configured on the server.');
    const forwarding = settings.forwarding_address || connection.external_account_id || '';

    const code = `ZENTRY-CHECK-${randomToken(6)}`;
    const result = await provider.send({
      from: { email: forwarding, name: settings.from_name || 'Zentry' },
      to: [{ email: settings.custom_address }],
      subject: 'Zentry forwarding check',
      text: `This is a test message from Zentry.\n\nIf you can read it in the inbox of ${settings.custom_address}, nothing more is needed on your side unless forwarding is not set up yet. Once your forwarding to ${forwarding} works, this message returns to Zentry and the check passes by itself.\n\n${code}`,
      html: `<p>This is a test message from Zentry.</p><p>Once forwarding from <b>${settings.custom_address}</b> to <b>${forwarding}</b> works, this message returns to Zentry and the check passes by itself.</p><p style="color:#8a94a0">${code}</p>`,
      headers: { 'X-Zentry-Mail': '1', 'Auto-Submitted': 'auto-generated' },
    });
    if (!result.ok) throw userError(result.error);
    await updateConnection(connection.id, {
      settings: { ...settings, forwarding_verified_at: null, forwarding_check: { code, sent_at: new Date().toISOString() } } as unknown as Record<string, unknown>,
    });
    return { success: true, overview: await load(workspaceId) };
  } catch (err) {
    return fail(err, 'Could not send the test email.');
  }
}

/** A branded sample reply to the signed-in person's own address: the live smoke test for sending. */
export async function sendTestReplyAction(workspaceId: string): Promise<Result<{ sentTo: string }>> {
  try {
    const { user, agent } = await guard(workspaceId);
    const connection = await getConnection(workspaceId, 'email');
    if (!connection || connection.status === 'disconnected') throw userError('Enable the email channel first.');
    const provider = getEmailProvider();
    const cfg = emailConfig();
    if (!provider.isConfigured() || !cfg.tokenSecret) throw userError('The email provider is not configured on the server.');
    if (!user.email) throw userError('Your account has no email address.');
    const mail = composeReply({
      workspace: await loadBrand(workspaceId),
      sender: senderSettingsFrom((connection.settings || {}) as EmailSettings, connection.external_account_id || ''),
      tokenSecret: cfg.tokenSecret,
      to: { email: user.email },
      ticket: { number: 1001, subject: 'A test of your support email' },
      agentName: agent.name || 'Your team',
      text: 'This is how your replies look to customers.\n\nIf it landed in your inbox, sending works. Reply to this email to check that replies reach your ticket inbox: the reply will not match a real ticket, so it opens a new one.',
    });
    const result = await provider.send(mail);
    if (!result.ok) throw userError(result.error);
    return { success: true, sentTo: user.email };
  } catch (err) {
    return fail(err, 'Could not send the test email.');
  }
}

export async function removeSuppressionAction(workspaceId: string, email: string): Promise<Result<{ overview: EmailChannelOverview }>> {
  try {
    const { supabase } = await guard(workspaceId);
    const { error } = await supabase.from('email_suppressions').delete().eq('workspace_id', workspaceId).eq('email', normalizeEmail(email));
    if (error) throw userError(error.message);
    return { success: true, overview: await load(workspaceId) };
  } catch (err) {
    return fail(err, 'Could not unblock the address.');
  }
}
