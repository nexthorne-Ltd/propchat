'use server';

import { randomBytes } from 'node:crypto';
import { getWorkspaceAccess } from '@/lib/team/access';
import { isSafeWebhookUrl } from '@/lib/automation/rules';
import { deliverSignedWebhook } from '@/lib/automation/outbox';
import { WEBHOOK_EVENTS, type WebhookEvent } from '@/lib/webhooks';
import { userError } from '@/lib/errors/user-error';

/**
 * Settings → API & webhooks → Webhooks. Each endpoint gets ticket and message
 * events as signed JSON. Deliveries are queued by database triggers and sent
 * (with retries) by the automation outbox; see migration 20261105090000 and
 * docs/API.md.
 */

export interface WorkspaceWebhook {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  is_active: boolean;
  created_at: string;
  last_delivery_at: string | null;
  last_status: 'sent' | 'failed' | null;
  last_error: string | null;
}

const COLUMNS = 'id, name, url, secret, events, is_active, created_at, last_delivery_at, last_status, last_error';

function cleanInput(input: { name?: string; url?: string; events?: string[] }) {
  const url = (input.url || '').trim();
  if (!isSafeWebhookUrl(url)) throw userError('Use a public https:// address (not localhost or a private network).');
  if (url.length > 2000) throw userError('That address is too long.');
  const events = (input.events || []).filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (!events.length) throw userError('Choose at least one event.');
  return { name: (input.name || '').trim().slice(0, 80), url, events };
}

export async function listWebhooksAction(workspaceId: string): Promise<WorkspaceWebhook[]> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const { data, error } = await supabase
    .from('workspace_webhooks')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true });
  if (error) throw userError(error.message);
  return (data as WorkspaceWebhook[]) || [];
}

export async function createWebhookAction(
  workspaceId: string,
  input: { name?: string; url: string; events: string[] }
): Promise<WorkspaceWebhook> {
  const { supabase, user } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const clean = cleanInput(input);
  const { data, error } = await supabase
    .from('workspace_webhooks')
    .insert({ workspace_id: workspaceId, ...clean, created_by: user.id })
    .select(COLUMNS)
    .single();
  if (error) throw userError(error.message);
  return data as WorkspaceWebhook;
}

export async function updateWebhookAction(
  workspaceId: string,
  id: string,
  input: { name?: string; url?: string; events?: string[]; is_active?: boolean }
): Promise<WorkspaceWebhook> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const patch: Record<string, unknown> = {};
  if (input.url !== undefined || input.events !== undefined || input.name !== undefined) {
    const { data: current } = await supabase.from('workspace_webhooks').select('name, url, events').eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
    if (!current) throw userError('That webhook was not found.');
    Object.assign(patch, cleanInput({ name: input.name ?? current.name, url: input.url ?? current.url, events: input.events ?? current.events }));
  }
  if (input.is_active !== undefined) patch.is_active = Boolean(input.is_active);
  const { data, error } = await supabase
    .from('workspace_webhooks')
    .update(patch)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(COLUMNS)
    .single();
  if (error) throw userError(error.message);
  return data as WorkspaceWebhook;
}

/** A new signing secret; the old one stops being used at once. */
export async function rotateWebhookSecretAction(workspaceId: string, id: string): Promise<WorkspaceWebhook> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const { data, error } = await supabase
    .from('workspace_webhooks')
    .update({ secret: randomBytes(32).toString('hex') })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(COLUMNS)
    .single();
  if (error) throw userError(error.message);
  return data as WorkspaceWebhook;
}

export async function deleteWebhookAction(workspaceId: string, id: string): Promise<void> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const { error } = await supabase.from('workspace_webhooks').delete().eq('id', id).eq('workspace_id', workspaceId);
  if (error) throw userError(error.message);
}

/** Sends a sample event right now, so the endpoint can be checked before real traffic. */
export async function testWebhookAction(workspaceId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const { data: hook } = await supabase.from('workspace_webhooks').select('url, secret').eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
  if (!hook) throw userError('That webhook was not found.');
  const result = await deliverSignedWebhook(hook.url, hook.secret, 'ping', {
    id: `test_${Date.now()}`,
    event: 'ping',
    workspace_id: workspaceId,
    occurred_at: new Date().toISOString(),
    message: 'A test delivery from Settings → Webhooks.',
  });
  await supabase
    .from('workspace_webhooks')
    .update({ last_delivery_at: new Date().toISOString(), last_status: result.ok ? 'sent' : 'failed', last_error: result.ok ? null : result.error ?? 'Failed' })
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  return result.ok
    ? { ok: true, message: `Delivered (HTTP ${result.status}).` }
    : { ok: false, message: result.error || 'The test delivery failed.' };
}
