import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
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

/**
 * Creates a server-side Supabase client for Server Components, Server Actions,
 * and Route Handlers with Next.js cookie persistence.
 */
export async function createClient<T = any>() {
  assertEnv();
  const cookieStore = await cookies();

  return createServerClient<T>(
    SUPABASE_URL,
    SUPABASE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method was called from a Server Component.
          }
        },
      },
    }
  );
}

export type { Database };
