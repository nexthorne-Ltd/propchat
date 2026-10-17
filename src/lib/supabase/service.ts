import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * A Supabase client for server routes that act on their own behalf.
 *
 * Background jobs — the auto-responder above all — have no user session. They
 * were reaching for the anonymous key, which row level security correctly
 * refuses for tables like `workspaces`. The failure was silent: the settings
 * query returned an empty array, `ai_settings` came back undefined, and the
 * assistant quietly behaved as though no model were configured. Adding a valid
 * API key changed nothing, because the code never saw it.
 *
 * The service role key is the supported way for trusted server code to read
 * past RLS. It must never reach the browser, so this module is server-only.
 */

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  '';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

/** True when server routes can read workspace configuration. */
export function hasServiceRole(): boolean {
  return Boolean(SERVICE_KEY);
}

let warned = false;

/**
 * Returns a privileged client, or an anonymous one with a warning when the key
 * is missing. Callers still work in the degraded case — they just cannot read
 * anything RLS protects, which is worth saying out loud exactly once.
 */
export function serviceClient(): SupabaseClient {
  if (SERVICE_KEY) {
    return createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  if (!warned) {
    warned = true;
    console.warn(
      '[supabase] SUPABASE_SERVICE_ROLE_KEY is not set. Server routes fall back ' +
        'to the anonymous key, which row level security blocks from reading ' +
        'workspace settings — the AI assistant cannot see its own configuration, ' +
        'so no model will be called however valid your API key is. Add the key ' +
        'from Supabase → Project Settings → API → service_role.'
    );
  }

  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
