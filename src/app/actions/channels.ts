'use server';

/**
 * Channel settings: connect, test and disconnect a workspace's messaging
 * channels (Settings → Channels). Every action checks the caller's role
 * first; connection rows are read through the caller's session (RLS), while
 * credentials are written and read only by server code with the service role
 * (src/lib/channels/store.ts), encrypted.
 */

import { getWorkspaceAccess } from '@/lib/team/access';
import { hasServiceRole } from '@/lib/supabase/service';
import { hasEncryptionKey, randomToken } from '@/lib/channels/crypto';
import { CHANNEL_CATALOG, getAdapter, isChannelId, type ChannelCatalogEntry } from '@/lib/channels/registry';
import { deleteSecrets, getConnection, loadConnection, recordConnectionError, saveConnection, updateConnection } from '@/lib/channels/store';
import { exchangeSignupCode } from '@/lib/channels/whatsapp/graph';
import { normalizePhone, type WhatsAppCredentials } from '@/lib/channels/whatsapp/adapter';
import type { InstagramCredentials } from '@/lib/channels/instagram/adapter';
import { authorizeUrl, createState } from '@/lib/channels/instagram/oauth';
import { createOAuthState, pkceFor, readOAuthState } from '@/lib/channels/oauth-state';
import { isSocialChannel, socialAccess, type SocialAccessState } from '@/lib/channels/social-info';
import { MANUAL_POLL_MIN_SECONDS, pollConnection } from '@/lib/channels/poll';
import { xAuthorizeUrl } from '@/lib/channels/x/oauth';
import { threadsAuthorizeUrl } from '@/lib/channels/threads/oauth';
import { linkedinAuthorizeUrl } from '@/lib/channels/linkedin/oauth';
import { tiktokAdapter } from '@/lib/channels/tiktok/adapter';
import type { Capability } from '@/lib/team/permissions';
import type { ChannelConnection } from '@/types/database';
import type { MessageTemplate } from '@/lib/channels/types';
import { assertWorkspaceLimit, assertWorkspaceFeature } from '@/lib/plans/enforce';
import { getRequestOrigin } from '@/lib/request-origin';
import { userError } from '@/lib/errors/user-error';

type Result<T = object> = ({ success: true } & T) | { success: false; error: string };

function fail(err: unknown, fallback: string): { success: false; error: string } {
  const message = err instanceof Error && err.message ? err.message : fallback;
  return { success: false, error: message };
}

async function guard(workspaceId: string, capability: Capability) {
  const access = await getWorkspaceAccess(workspaceId, capability);
  if (!hasServiceRole()) throw userError('The server is missing SUPABASE_SERVICE_ROLE_KEY, so channels cannot be managed.');
  if (!hasEncryptionKey()) throw userError('The server is missing CHANNEL_ENCRYPTION_KEY, so channel credentials cannot be stored safely.');
  return access;
}

async function appUrl(): Promise<string> {
  return getRequestOrigin();
}

/* ── Overview ─────────────────────────────────────────────────────────── */

/** What the page needs to show a social channel honestly (the static facts are in social-info.ts). */
export interface SocialCardState {
  access: { state: SocialAccessState; missing: string[] };
  /** Where the platform sends the admin back after sign-in; the app must list it. */
  redirectUri: string | null;
  /** The URL to register as the webhook, for channels that push. */
  webhookUrl: string | null;
  /** Minutes between checks for channels that are polled; null when not polled. */
  pollEveryMinutes: number | null;
}

export interface ChannelCard extends ChannelCatalogEntry {
  connection: ChannelConnection | null;
  /** Manual setup: where to point the customer's Meta app, and the token to give it. */
  manualWebhook: { url: string; verifyToken: string } | null;
  social: SocialCardState | null;
}

export interface ChannelsOverview {
  cards: ChannelCard[];
  /** What the server is missing; the page explains each one instead of failing later. */
  setupProblems: string[];
  /** Present when the platform Meta app is configured for Embedded Signup. */
  embeddedSignup: { appId: string; configId: string; graphVersion: string } | null;
  platformWebhookUrl: string | null;
  /** Present when the platform Instagram app is configured for Business Login. */
  instagramLogin: { webhookUrl: string | null } | null;
}

export async function getChannelsOverviewAction(workspaceId: string): Promise<Result<{ overview: ChannelsOverview }>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const { data, error } = await supabase.from('channel_connections').select('*').eq('workspace_id', workspaceId);
    if (error) throw userError(`Could not load channels: ${error.message}`);
    const rows = (data as ChannelConnection[]) || [];

    const currentAppUrl = await appUrl();
    const setupProblems: string[] = [];
    if (!hasServiceRole()) setupProblems.push('SUPABASE_SERVICE_ROLE_KEY is not set on the server.');
    if (!hasEncryptionKey()) setupProblems.push('CHANNEL_ENCRYPTION_KEY is not set (or is not 32 bytes) on the server.');
    if (!currentAppUrl) setupProblems.push('NEXT_PUBLIC_APP_URL is not set, so webhook URLs cannot be shown.');

    const cards: ChannelCard[] = [];
    for (const entry of CHANNEL_CATALOG) {
      const connection = rows.find((r) => r.channel === entry.id) || null;
      let manualWebhook: ChannelCard['manualWebhook'] = null;
      if (connection && connection.setup_method === 'manual' && connection.status !== 'disconnected' && hasServiceRole() && hasEncryptionKey()) {
        const loaded = await loadConnection<WhatsAppCredentials>(workspaceId, entry.id).catch(() => null);
        if (loaded?.credentials.verifyToken) {
          manualWebhook = { url: `${currentAppUrl}/api/channels/${entry.id}/webhook/${connection.id}`, verifyToken: loaded.credentials.verifyToken };
        }
      }
      let social: SocialCardState | null = null;
      if (isSocialChannel(entry.id)) {
        const adapter = getAdapter(entry.id)!;
        social = {
          access: socialAccess(entry.id, process.env),
          redirectUri: currentAppUrl && entry.id !== 'tiktok' ? `${currentAppUrl}/api/channels/oauth/${entry.id}` : null,
          webhookUrl: currentAppUrl && entry.id !== 'linkedin' ? `${currentAppUrl}/api/channels/${entry.id}/webhook` : null,
          pollEveryMinutes: adapter.poll && adapter.capabilities.pollIntervalSeconds ? Math.round(adapter.capabilities.pollIntervalSeconds / 60) : null,
        };
      }
      cards.push({ ...entry, connection, manualWebhook, social });
    }

    const appId = process.env.META_APP_ID;
    const configId = process.env.META_WHATSAPP_CONFIG_ID;
    const origin = (await appUrl()) || '';
    return {
      success: true,
      overview: {
        cards,
        setupProblems,
        embeddedSignup:
          appId && configId && process.env.META_APP_SECRET
            ? { appId, configId, graphVersion: process.env.META_GRAPH_API_VERSION || 'v23.0' }
            : null,
        platformWebhookUrl: origin ? `${origin}/api/channels/whatsapp/webhook` : null,
        instagramLogin:
          process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET && origin
            ? { webhookUrl: `${origin}/api/channels/instagram/webhook` }
            : null,
      },
    };
  } catch (err) {
    return fail(err, 'Could not load channels.');
  }
}

/* ── Connecting ───────────────────────────────────────────────────────── */

export async function connectWhatsAppManualAction(
  workspaceId: string,
  input: { phoneNumberId: string; wabaId: string; accessToken: string; appSecret: string }
): Promise<Result<{ connection: ChannelConnection }>> {
  try {
    const { user } = await guard(workspaceId, 'manage_settings');
    await assertWorkspaceLimit(workspaceId, 'max_channels_connected');
    await assertWorkspaceFeature(workspaceId, 'channel_whatsapp');
    const appSecret = (input.appSecret || '').trim();
    if (!/^[0-9a-f]{32}$/i.test(appSecret)) {
      throw userError('The app secret is the 32-character value under App settings → Basic in your Meta app.');
    }
    // Reconnecting keeps the verify token, so the webhook set up in Meta keeps working.
    const existing = await loadConnection<WhatsAppCredentials>(workspaceId, 'whatsapp').catch(() => null);
    const credentials: WhatsAppCredentials = {
      accessToken: (input.accessToken || '').trim(),
      appSecret,
      verifyToken: existing?.credentials.verifyToken || randomToken(),
    };
    const adapter = getAdapter('whatsapp')!;
    const account = await adapter.connect({ phoneNumberId: input.phoneNumberId, wabaId: input.wabaId }, credentials);
    const connection = await saveConnection({
      workspaceId,
      channel: 'whatsapp',
      userId: user.id,
      setupMethod: 'manual',
      ...account,
      settings: { ...account.settings, webhook_verified_at: existing?.connection.settings?.webhook_verified_at ?? null },
      credentials,
    });
    return { success: true, connection };
  } catch (err) {
    return fail(err, 'Could not connect WhatsApp.');
  }
}

export async function completeWhatsAppSignupAction(
  workspaceId: string,
  input: { code: string; phoneNumberId: string; wabaId: string }
): Promise<Result<{ connection: ChannelConnection }>> {
  try {
    const { user } = await guard(workspaceId, 'manage_settings');
    await assertWorkspaceLimit(workspaceId, 'max_channels_connected');
    await assertWorkspaceFeature(workspaceId, 'channel_whatsapp');
    if (!input.code) throw userError('Meta did not return an authorisation code. Try connecting again.');
    const accessToken = await exchangeSignupCode(input.code);
    // Webhooks for embedded signup arrive at the platform URL, signed with the platform app secret.
    const credentials: WhatsAppCredentials = { accessToken };
    const account = await getAdapter('whatsapp')!.connect({ phoneNumberId: input.phoneNumberId, wabaId: input.wabaId }, credentials);
    const connection = await saveConnection({
      workspaceId,
      channel: 'whatsapp',
      userId: user.id,
      setupMethod: 'embedded_signup',
      ...account,
      credentials,
    });
    return { success: true, connection };
  } catch (err) {
    return fail(err, 'Could not finish connecting WhatsApp.');
  }
}

/* ── Testing, templates, disconnecting ────────────────────────────────── */

export async function sendChannelTestMessageAction(
  workspaceId: string,
  channel: string,
  input: { to: string; templateName: string; language: string }
): Promise<Result<{ providerMessageId: string }>> {
  try {
    await guard(workspaceId, 'manage_settings');
    if (!isChannelId(channel)) throw userError('Unknown channel.');
    if (isSocialChannel(channel)) throw userError('Test messages are not available for this channel: it only answers people who wrote to you.');
    if (channel === 'instagram') return await sendInstagramTest(workspaceId, input.to);
    const to = normalizePhone(input.to);
    if (to.length < 8) throw userError('Enter the full number with its country code, e.g. +1 650 555 1234.');
    const conn = await loadConnection<unknown>(workspaceId, channel);
    if (!conn || conn.connection.status === 'disconnected') throw userError('Connect the channel first.');
    // A test goes to someone who has not written in: WhatsApp only allows a template.
    const result = await getAdapter(channel)!.sendMessage(conn, to, {
      type: 'template',
      template: { name: input.templateName || 'hello_world', language: input.language || 'en_US' },
    });
    if (!result.ok) {
      await recordConnectionError(conn.connection.id, result.error, Boolean(result.needsAttention));
      return { success: false, error: result.error };
    }
    await updateConnection(conn.connection.id, {
      last_outbound_at: new Date().toISOString(),
      last_error: null,
      last_error_at: null,
      ...(conn.connection.status === 'needs_attention' ? { status: 'connected' as const } : {}),
    });
    return { success: true, providerMessageId: result.providerMessageId };
  } catch (err) {
    return fail(err, 'Could not send the test message.');
  }
}

/**
 * Instagram lets a business message only people who wrote in the last 24
 * hours, so the test goes to one of them, as plain text.
 */
async function sendInstagramTest(workspaceId: string, recipientId: string): Promise<Result<{ providerMessageId: string }>> {
  const recipients = await recentRecipients(workspaceId, 'instagram');
  if (!recipients.some((r) => r.id === recipientId)) {
    throw userError('Choose someone who messaged your Instagram account in the last 24 hours.');
  }
  const conn = await loadConnection<unknown>(workspaceId, 'instagram');
  if (!conn || conn.connection.status === 'disconnected') throw userError('Connect the channel first.');
  const result = await getAdapter('instagram')!.sendMessage(conn, recipientId, {
    type: 'text',
    text: 'Test message from Zentry: your Instagram inbox is connected.',
  });
  if (!result.ok) {
    await recordConnectionError(conn.connection.id, result.error, Boolean(result.needsAttention));
    return { success: false, error: result.error };
  }
  await updateConnection(conn.connection.id, {
    last_outbound_at: new Date().toISOString(),
    last_error: null,
    last_error_at: null,
    ...(conn.connection.status === 'needs_attention' ? { status: 'connected' as const } : {}),
  });
  return { success: true, providerMessageId: result.providerMessageId };
}

export interface TestRecipient {
  /** The customer's id on the channel (Instagram-scoped id). */
  id: string;
  name: string;
  lastInboundAt: string;
}

async function recentRecipients(workspaceId: string, channel: string): Promise<TestRecipient[]> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from('conversations')
    .select('channel_user_id, channel_last_inbound_at, visitor:visitors(name)')
    .eq('workspace_id', workspaceId)
    .eq('channel', channel)
    .gt('channel_last_inbound_at', since)
    .order('channel_last_inbound_at', { ascending: false })
    .limit(20);
  if (error) throw userError(`Could not load recent conversations: ${error.message}`);
  const seen = new Set<string>();
  const out: TestRecipient[] = [];
  for (const row of (data || []) as { channel_user_id: string | null; channel_last_inbound_at: string; visitor: { name: string | null } | { name: string | null }[] | null }[]) {
    if (!row.channel_user_id || seen.has(row.channel_user_id)) continue;
    seen.add(row.channel_user_id);
    const visitor = Array.isArray(row.visitor) ? row.visitor[0] : row.visitor;
    out.push({ id: row.channel_user_id, name: visitor?.name || row.channel_user_id, lastInboundAt: row.channel_last_inbound_at });
  }
  return out;
}

/** People a test message may go to on channels that only allow replies (Instagram). */
export async function listTestRecipientsAction(workspaceId: string, channel: string): Promise<Result<{ recipients: TestRecipient[] }>> {
  try {
    if (!isChannelId(channel)) throw userError('Unknown channel.');
    return { success: true, recipients: await recentRecipients(workspaceId, channel) };
  } catch (err) {
    return fail(err, 'Could not load recent conversations.');
  }
}

/* ── Instagram ────────────────────────────────────────────────────────── */

/** The Instagram Business Login URL to send the admin to. */
export async function startInstagramConnectAction(workspaceId: string): Promise<Result<{ url: string }>> {
  try {
    const { user } = await guard(workspaceId, 'manage_settings');
    await assertWorkspaceLimit(workspaceId, 'max_channels_connected');
    await assertWorkspaceFeature(workspaceId, 'channel_instagram');
    if (!process.env.INSTAGRAM_APP_ID || !process.env.INSTAGRAM_APP_SECRET) {
      throw userError('Instagram login is not set up on this server (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET). Use manual setup instead.');
    }
    const currentAppUrl = await appUrl();
    if (!currentAppUrl) throw userError('NEXT_PUBLIC_APP_URL must be set so Instagram can send you back.');
    return { success: true, url: authorizeUrl(currentAppUrl, createState(workspaceId, user.id)) };
  } catch (err) {
    return fail(err, 'Could not start connecting Instagram.');
  }
}

export async function connectInstagramManualAction(
  workspaceId: string,
  input: { accessToken: string; appSecret: string }
): Promise<Result<{ connection: ChannelConnection }>> {
  try {
    const { user } = await guard(workspaceId, 'manage_settings');
    await assertWorkspaceLimit(workspaceId, 'max_channels_connected');
    await assertWorkspaceFeature(workspaceId, 'channel_instagram');
    const appSecret = (input.appSecret || '').trim();
    if (!/^[0-9a-f]{32}$/i.test(appSecret)) {
      throw userError('The app secret is the 32-character Instagram app secret under Instagram → API setup with Instagram login → Business login settings.');
    }
    const existing = await loadConnection<InstagramCredentials>(workspaceId, 'instagram').catch(() => null);
    const credentials: InstagramCredentials = {
      accessToken: (input.accessToken || '').trim(),
      appSecret,
      verifyToken: existing?.credentials.verifyToken || randomToken(),
      // Dashboard-generated tokens are long-lived (60 days) and refreshable.
      expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    };
    const account = await getAdapter('instagram')!.connect({}, credentials);
    const connection = await saveConnection({
      workspaceId,
      channel: 'instagram',
      userId: user.id,
      setupMethod: 'manual',
      ...account,
      settings: {
        ...account.settings,
        human_agent: process.env.INSTAGRAM_HUMAN_AGENT_ENABLED === 'true',
        webhook_verified_at: existing?.connection.settings?.webhook_verified_at ?? null,
      },
      credentials,
    });
    return { success: true, connection };
  } catch (err) {
    return fail(err, 'Could not connect Instagram.');
  }
}

/* ── X, Threads, LinkedIn, TikTok ─────────────────────────────────────── */

/**
 * The sign-in URL to send the admin to for X, Threads or LinkedIn. Refuses
 * when the platform has not approved the app or the server lacks its
 * credentials, so the page can explain instead of sending someone to an error.
 */
export async function startSocialConnectAction(workspaceId: string, channel: string, input: { pageId?: string } = {}): Promise<Result<{ url: string }>> {
  try {
    const { user } = await guard(workspaceId, 'manage_settings');
    await assertWorkspaceLimit(workspaceId, 'max_channels_connected');
    await assertWorkspaceFeature(workspaceId, `channel_${channel}` as any);
    if (!isSocialChannel(channel) || channel === 'tiktok') throw userError('This channel does not use a sign-in.');
    const access = socialAccess(channel, process.env);
    if (access.state === 'requires_approval') throw userError('This channel needs approval from the platform first. Follow the steps on the card.');
    if (access.state === 'server_setup') throw userError(`The server is missing ${access.missing.join(', ')}.`);
    const currentAppUrl = await appUrl();
    if (!currentAppUrl) throw userError('NEXT_PUBLIC_APP_URL must be set so the platform can send you back.');

    if (channel === 'linkedin') {
      const pageId = (input.pageId || '').trim();
      if (!/^\d{3,15}$/.test(pageId)) throw userError('Enter your Page’s numeric id: the number in linkedin.com/company/<number>/admin.');
      return { success: true, url: linkedinAuthorizeUrl(currentAppUrl, createOAuthState('linkedin', { workspaceId, userId: user.id, extra: pageId })) };
    }
    const state = createOAuthState(channel, { workspaceId, userId: user.id });
    if (channel === 'threads') return { success: true, url: threadsAuthorizeUrl(currentAppUrl, state) };
    const nonce = readOAuthState('x', state)!.nonce;
    return { success: true, url: xAuthorizeUrl(currentAppUrl, state, pkceFor(nonce).challenge) };
  } catch (err) {
    return fail(err, 'Could not start connecting.');
  }
}

export async function connectTikTokAction(workspaceId: string, input: { businessId: string; accessToken: string }): Promise<Result<{ connection: ChannelConnection }>> {
  try {
    const { user } = await guard(workspaceId, 'manage_settings');
    await assertWorkspaceLimit(workspaceId, 'max_channels_connected');
    await assertWorkspaceFeature(workspaceId, 'channel_tiktok');
    if (socialAccess('tiktok', process.env).state === 'requires_approval') {
      throw userError('TikTok has to approve your app first. Follow the steps on the card.');
    }
    const credentials = { accessToken: (input.accessToken || '').trim() };
    const account = await tiktokAdapter.connect({ businessId: input.businessId }, credentials);
    const connection = await saveConnection({ workspaceId, channel: 'tiktok', userId: user.id, setupMethod: 'manual', ...account, credentials });
    return { success: true, connection };
  } catch (err) {
    return fail(err, 'Could not connect TikTok.');
  }
}

/**
 * X bills every event a DM poll returns, so reading DMs by polling is a
 * choice an admin makes with the cost in front of them.
 */
export async function setXDmPollingAction(workspaceId: string, enabled: boolean): Promise<Result> {
  try {
    await guard(workspaceId, 'manage_settings');
    const connection = await getConnection(workspaceId, 'x');
    if (!connection || connection.status === 'disconnected') throw userError('Connect X first.');
    await updateConnection(connection.id, { settings: { ...connection.settings, poll_dms: enabled } });
    return { success: true };
  } catch (err) {
    return fail(err, 'Could not change this setting.');
  }
}

/** "Check now": poll once, no more often than once a minute. */
export async function checkChannelNowAction(workspaceId: string, channel: string): Promise<Result<{ ingested: number; message: string }>> {
  try {
    await guard(workspaceId, 'manage_settings');
    if (!isSocialChannel(channel)) throw userError('This channel is not checked by polling.');
    const connection = await getConnection(workspaceId, channel);
    if (!connection || connection.status === 'disconnected') throw userError('Connect the channel first.');
    const origin = (await appUrl()) || '';
    const r = await pollConnection(connection, origin, { force: true });
    if (r.outcome === 'failed') throw userError(r.reason || 'Could not check for new items.');
    if (r.outcome === 'skipped') {
      return { success: true, ingested: 0, message: r.reason === 'Checked a moment ago.' ? `Checked less than ${MANUAL_POLL_MIN_SECONDS} seconds ago. Try again in a minute.` : r.reason || 'Nothing to check.' };
    }
    return { success: true, ingested: r.ingested, message: r.ingested ? `${r.ingested} new item${r.ingested === 1 ? '' : 's'} added as tickets.` : 'Nothing new.' };
  } catch (err) {
    return fail(err, 'Could not check for new items.');
  }
}

export async function listChannelTemplatesAction(workspaceId: string, channel: string): Promise<Result<{ templates: MessageTemplate[] }>> {
  try {
    await guard(workspaceId, 'reply');
    if (!isChannelId(channel)) throw userError('Unknown channel.');
    const conn = await loadConnection<unknown>(workspaceId, channel);
    if (!conn || conn.connection.status === 'disconnected') throw userError('This channel is not connected.');
    return { success: true, templates: await getAdapter(channel)!.listTemplates(conn) };
  } catch (err) {
    return fail(err, 'Could not load templates.');
  }
}

export async function disconnectChannelAction(workspaceId: string, channel: string): Promise<Result> {
  try {
    const { supabase } = await guard(workspaceId, 'manage_settings');
    if (!isChannelId(channel)) throw userError('Unknown channel.');
    const connection = await getConnection(workspaceId, channel);
    if (!connection) return { success: true };
    const loaded = await loadConnection<unknown>(workspaceId, channel).catch(() => null);
    if (loaded) {
      // Best effort: stop Meta sending this account's webhooks to us. A revoked
      // token must not stop the admin from disconnecting.
      await getAdapter(channel)!
        .disconnect(loaded)
        .catch((err) => console.warn('[Channels] Could not unsubscribe on disconnect:', (err as Error).message));
    }
    await deleteSecrets(connection.id);
    const { error } = await supabase
      .from('channel_connections')
      .update({ status: 'disconnected', last_error: null, last_error_at: null })
      .eq('id', connection.id)
      .eq('workspace_id', workspaceId);
    if (error) throw userError(`Could not disconnect: ${error.message}`);
    return { success: true };
  } catch (err) {
    return fail(err, 'Could not disconnect.');
  }
}
