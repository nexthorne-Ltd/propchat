import { serviceClient } from '@/lib/supabase/service';
import { getAdapter } from './registry';
import { loadConnectionById, recordConnectionError, updateConnection, updateSecrets, type LoadedConnection } from './store';
import type { ChannelConnection } from '@/types/database';

/**
 * Channels whose access tokens last hours, not months (X: two hours) cannot
 * wait for the daily cron: renew the token just before it is used, and keep
 * the new one (X's refresh tokens rotate, so the old one stops working).
 * Channels without `refreshesOnUse` are left to the cron and pass through.
 */
export async function withFreshCredentials<C>(conn: LoadedConnection<C>): Promise<LoadedConnection<C>> {
  const adapter = getAdapter(conn.connection.channel);
  if (!adapter?.capabilities.refreshesOnUse || !adapter.refreshCredentials) return conn;
  const fresh = await adapter.refreshCredentials(conn);
  if (!fresh) return conn;
  await updateSecrets(conn.connection.id, conn.connection.workspace_id, fresh.credentials);
  await updateConnection(conn.connection.id, { settings: fresh.settings });
  return { connection: { ...conn.connection, settings: fresh.settings }, credentials: fresh.credentials as C };
}

/**
 * Renews expiring tokens (Instagram's last 60 days) from the daily cron. A
 * token that cannot be renewed marks the connection "needs attention" so an
 * admin reconnects before messages start failing.
 */
export async function refreshDueCredentials(): Promise<{ checked: number; refreshed: number; failed: number }> {
  const summary = { checked: 0, refreshed: 0, failed: 0 };
  const { data, error } = await serviceClient().from('channel_connections').select('id, channel').neq('status', 'disconnected');
  if (error) {
    console.error('[Channels] Could not list connections to refresh:', error.message);
    return summary;
  }
  for (const row of (data as Pick<ChannelConnection, 'id' | 'channel'>[]) || []) {
    const adapter = getAdapter(row.channel);
    if (!adapter?.refreshCredentials) continue;
    summary.checked++;
    try {
      const conn = await loadConnectionById<unknown>(row.id);
      if (!conn) continue;
      const fresh = await adapter.refreshCredentials(conn);
      if (!fresh) continue;
      await updateSecrets(conn.connection.id, conn.connection.workspace_id, fresh.credentials);
      await updateConnection(conn.connection.id, { settings: fresh.settings });
      summary.refreshed++;
    } catch (err) {
      summary.failed++;
      await recordConnectionError(row.id, `Could not renew the ${adapter.label} token: ${(err as Error).message}. Reconnect to keep receiving messages.`, true);
    }
  }
  return summary;
}
