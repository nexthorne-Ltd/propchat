import type { SupabaseClient } from '@supabase/supabase-js';

export interface SessionUser {
  id: string;
  email?: string;
}

/**
 * The signed-in user from the request's session, for server guards.
 *
 * getUser() asks Supabase Auth over the network every time; every server
 * action and agent API route paid that round trip (twice in
 * guardConversation). getClaims() verifies the session token's signature
 * locally with the project's published signing key, and only falls back to
 * the network for tokens it cannot verify that way. Revocation is still
 * honoured within the token's short lifetime, and membership, role and
 * deactivation are checked in the database by the guards that call this.
 *
 * getUser stays as the fallback for clients without getClaims (test mocks).
 */
export async function sessionUser(supabase: SupabaseClient): Promise<SessionUser | null> {
  if (typeof supabase.auth.getClaims === 'function') {
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims as { sub?: unknown; email?: unknown } | undefined;
    if (error || typeof claims?.sub !== 'string' || !claims.sub) return null;
    return { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
  }
  const { data } = await supabase.auth.getUser();
  return data?.user ? { id: data.user.id, email: data.user.email ?? undefined } : null;
}
