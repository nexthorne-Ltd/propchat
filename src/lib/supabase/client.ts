import { createBrowserClient } from '@supabase/ssr';
import { Database } from '@/types/database';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// No fallback project: a build without these must fail loudly rather than
// quietly talk to some other (production) database.
function assertEnv() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.');
  }
}

let clientInstance: any = null;

/**
 * Creates or reuses a browser-side Supabase client for React client components.
 * Reusing a singleton instance prevents multiple duplicate WebSocket connections
 * and realtime channel thrashing across components.
 */
export function createClient<T = any>() {
  assertEnv();
  if (typeof window === 'undefined') {
    return createBrowserClient<T>(SUPABASE_URL, SUPABASE_KEY);
  }
  if (!clientInstance) {
    clientInstance = createBrowserClient<T>(SUPABASE_URL, SUPABASE_KEY);
  }
  return clientInstance;
}

export type { Database };

