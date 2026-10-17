import { serviceClient } from '@/lib/supabase/service';
import type { ChannelConnection } from '@/types/database';
import { ChannelApiError } from './http';
import { withFreshCredentials } from './refresh';
import { getAdapter } from './registry';
import { storeEvent } from './inbound';
import { getConnection, loadConnectionById, recordConnectionError, updateConnection } from './store';

/**
 * Pulls new items from channels that cannot (or do not yet) push: X mentions,
 * Threads replies, LinkedIn comments. Run by /api/cron/channel-poll every few
 * minutes and by the "Check now" button.
 *
 * Rate limits are kept by being slow and by never polling twice at once:
 *   - each adapter names its own minimum interval (capabilities.pollIntervalSeconds);
 *   - `last_polled_at` is written *before* the platform is called, so a second
 *     cron run, or a click on "Check now", that overlaps simply skips the
 *     connection instead of doubling the API calls;
 *   - a platform rate-limit answer is not an error to alarm anyone with: the
 *     poll is skipped and the cursor is left where it was, so nothing is lost.
 *
 * Duplicates are harmless: a message id the database has already stored is
 * ignored (fn_channel_ingest_inbound), so a retry after a crash re-reads at
 * worst.
 */

export interface PollSummary {
  checked: number;
  polled: number;
  ingested: number;
  skipped: number;
  failed: number;
}

/** The shortest gap a person can force with "Check now". */
export const MANUAL_POLL_MIN_SECONDS = 60;

export type PollOutcome = 'polled' | 'skipped' | 'failed';

export async function pollConnection(
  connection: ChannelConnection,
  origin: string,
  opts: { force?: boolean } = {}
): Promise<{ outcome: PollOutcome; ingested: number; reason?: string }> {
  const adapter = getAdapter(connection.channel);
  if (!adapter?.poll || connection.status === 'disconnected') return { outcome: 'skipped', ingested: 0 };

  const interval = (opts.force ? MANUAL_POLL_MIN_SECONDS : adapter.capabilities.pollIntervalSeconds ?? 300) * 1000;
  const last = typeof connection.settings?.last_polled_at === 'string' ? Date.parse(connection.settings.last_polled_at) : 0;
  if (Date.now() - last < interval) return { outcome: 'skipped', ingested: 0, reason: 'Checked a moment ago.' };

  // Claim this poll before calling out (see the note above).
  const claimedAt = new Date().toISOString();
  await updateConnection(connection.id, { settings: { ...connection.settings, last_polled_at: claimedAt } });

  try {
    const loaded = await loadConnectionById<unknown>(connection.id);
    if (!loaded) return { outcome: 'skipped', ingested: 0, reason: 'The connection has no stored credentials.' };
    const conn = await withFreshCredentials(loaded);
    const state = (conn.connection.settings?.poll_state as Record<string, unknown> | undefined) ?? {};
    const result = await adapter.poll(conn, state);

    let ingested = 0;
    for (const event of result.events) {
      const followUp = await storeEvent(adapter, conn as never, event, origin);
      if (followUp) {
        ingested++;
        await followUp().catch((err) => console.error('[Channel Poll Follow-up Error]:', err));
      }
    }

    // Settings may have changed while we were polling (a toggle): merge into the latest.
    const latest = (await getConnection(connection.workspace_id, connection.channel)) ?? connection;
    await updateConnection(connection.id, {
      settings: { ...latest.settings, poll_state: result.state, last_polled_at: claimedAt },
      last_inbound_at: ingested ? new Date().toISOString() : latest.last_inbound_at,
      // A successful poll proves a connection that needed attention works again.
      ...(latest.status === 'needs_attention' ? { status: 'connected' as const, last_error: null, last_error_at: null } : {}),
    });
    return { outcome: 'polled', ingested };
  } catch (err) {
    const failure = err instanceof ChannelApiError ? err.failure : null;
    const message = failure?.error || (err as Error).message || 'Could not check for new items.';
    // Rate limited or a platform outage: try again next time, quietly.
    if (failure?.retryable) return { outcome: 'skipped', ingested: 0, reason: message };
    console.error(`[Channel Poll Error]: ${connection.channel} ${connection.id}:`, message);
    await recordConnectionError(connection.id, message, Boolean(failure?.needsAttention));
    return { outcome: 'failed', ingested: 0, reason: message };
  }
}

export async function pollDueConnections(origin: string, limit = 25): Promise<PollSummary> {
  const summary: PollSummary = { checked: 0, polled: 0, ingested: 0, skipped: 0, failed: 0 };
  const { data, error } = await serviceClient().from('channel_connections').select('*').neq('status', 'disconnected').limit(500);
  if (error) {
    console.error('[Channel Poll Error]: could not list connections:', error.message);
    return summary;
  }
  const due = ((data as ChannelConnection[]) || []).filter((c) => getAdapter(c.channel)?.poll);
  for (const connection of due.slice(0, limit)) {
    summary.checked++;
    const r = await pollConnection(connection, origin);
    summary.ingested += r.ingested;
    if (r.outcome === 'polled') summary.polled++;
    else if (r.outcome === 'failed') summary.failed++;
    else summary.skipped++;
  }
  return summary;
}
