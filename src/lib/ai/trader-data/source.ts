/**
 * One trader lookup, by whichever kind of connection the workspace has: its
 * prop-firm backend on Supabase, or its own HTTPS endpoint.
 */
import { callTraderData, TraderDataError, type TraderDataConnection, type TraderLookupRequest, type TraderRecord } from './client';
import { lookupInPropFirmSupabase } from './prop-firm-supabase';

export async function fetchTraderRecord(
  connection: TraderDataConnection & { url: string },
  req: TraderLookupRequest,
  timeoutMs?: number
): Promise<{ record: TraderRecord; latencyMs: number }> {
  if (connection.kind === 'supabase') {
    if (!connection.secret) throw new TraderDataError('No service_role key is saved.');
    return lookupInPropFirmSupabase({ url: connection.url, key: connection.secret }, req, timeoutMs);
  }
  return callTraderData({ url: connection.url, apiKey: connection.secret }, req, timeoutMs);
}
