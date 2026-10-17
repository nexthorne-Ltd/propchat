import { serviceClient } from '@/lib/supabase/service';
import type { ChannelConnection } from '@/types/database';
import { decryptSecret, encryptSecret } from './crypto';
import type { ChannelContext } from './types';
import { userError } from '@/lib/errors/user-error';

/**
 * Reading and writing connections together with their encrypted secrets.
 * Server-only and service-role: callers (server actions, webhook routes, the
 * outbound worker) must already know the caller may touch this workspace.
 */

export interface LoadedConnection<C = Record<string, unknown>> extends ChannelContext<C> {
  connection: ChannelConnection;
}

async function withSecrets<C>(connection: ChannelConnection | null): Promise<LoadedConnection<C> | null> {
  if (!connection) return null;
  const { data, error } = await serviceClient()
    .from('channel_secrets')
    .select('ciphertext')
    .eq('connection_id', connection.id)
    .maybeSingle();
  if (error) throw userError(`[Channels] Could not read credentials: ${error.message}`);
  if (!data?.ciphertext) return null;
  return { connection, credentials: decryptSecret<C>(data.ciphertext) };
}

export async function getConnection(workspaceId: string, channel: string): Promise<ChannelConnection | null> {
  const { data, error } = await serviceClient()
    .from('channel_connections')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('channel', channel)
    .maybeSingle();
  if (error) throw userError(`[Channels] Could not read connection: ${error.message}`);
  return (data as ChannelConnection) || null;
}

export async function loadConnection<C>(workspaceId: string, channel: string): Promise<LoadedConnection<C> | null> {
  return withSecrets<C>(await getConnection(workspaceId, channel));
}

export async function loadConnectionById<C>(id: string): Promise<LoadedConnection<C> | null> {
  const { data } = await serviceClient().from('channel_connections').select('*').eq('id', id).maybeSingle();
  return withSecrets<C>((data as ChannelConnection) || null);
}

/** The live connection a provider account (WhatsApp phone number id) belongs to. */
export async function loadConnectionByAccount<C>(channel: string, accountId: string): Promise<LoadedConnection<C> | null> {
  const { data } = await serviceClient()
    .from('channel_connections')
    .select('*')
    .eq('channel', channel)
    .eq('external_account_id', accountId)
    .neq('status', 'disconnected')
    .maybeSingle();
  return withSecrets<C>((data as ChannelConnection) || null);
}

export async function saveConnection(params: {
  workspaceId: string;
  channel: string;
  userId: string;
  setupMethod: 'embedded_signup' | 'manual';
  externalAccountId: string;
  externalBusinessId: string | null;
  displayName: string;
  settings: Record<string, unknown>;
  credentials: unknown;
}): Promise<ChannelConnection> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from('channel_connections')
    .upsert(
      {
        workspace_id: params.workspaceId,
        channel: params.channel,
        status: 'connected',
        setup_method: params.setupMethod,
        external_account_id: params.externalAccountId,
        external_business_id: params.externalBusinessId,
        display_name: params.displayName,
        settings: params.settings,
        last_error: null,
        last_error_at: null,
        connected_at: new Date().toISOString(),
        connected_by: params.userId,
      },
      { onConflict: 'workspace_id,channel' }
    )
    .select('*')
    .single();
  if (error || !data) {
    if (error?.code === '23505') throw userError('This number is already connected to another workspace.');
    throw userError(`Could not save the connection: ${error?.message || 'unknown error'}`);
  }
  const { error: secretError } = await sb.from('channel_secrets').upsert(
    {
      connection_id: data.id,
      workspace_id: params.workspaceId,
      ciphertext: encryptSecret(params.credentials),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'connection_id' }
  );
  if (secretError) throw userError(`Could not store the credentials: ${secretError.message}`);
  return data as ChannelConnection;
}

export async function updateConnection(id: string, patch: Partial<ChannelConnection>): Promise<void> {
  const { error } = await serviceClient().from('channel_connections').update(patch).eq('id', id);
  if (error) console.error('[Channels] Could not update connection:', error.message);
}

/** A send or webhook failed; when the connection itself is broken an admin must reconnect. */
export async function recordConnectionError(id: string, message: string, needsAttention: boolean): Promise<void> {
  await updateConnection(id, {
    last_error: message.slice(0, 500),
    last_error_at: new Date().toISOString(),
    ...(needsAttention ? { status: 'needs_attention' as const } : {}),
  });
}

/** Replaces a connection's credentials (a refreshed token, say). */
export async function updateSecrets(connectionId: string, workspaceId: string, credentials: unknown): Promise<void> {
  const { error } = await serviceClient().from('channel_secrets').upsert(
    { connection_id: connectionId, workspace_id: workspaceId, ciphertext: encryptSecret(credentials), updated_at: new Date().toISOString() },
    { onConflict: 'connection_id' }
  );
  if (error) throw userError(`Could not store the credentials: ${error.message}`);
}

export async function deleteSecrets(connectionId: string): Promise<void> {
  const { error } = await serviceClient().from('channel_secrets').delete().eq('connection_id', connectionId);
  if (error) throw userError(`Could not remove the credentials: ${error.message}`);
}
