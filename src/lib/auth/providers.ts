'use client';

import { useEffect, useState } from 'react';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  '';
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  '';

export type SocialProvider = 'google';

/**
 * Which social providers the Supabase project actually has switched on.
 *
 * `signInWithOAuth` navigates the browser straight to Supabase, so a disabled
 * provider never surfaces as a JS error — the visitor just lands on a raw
 * `{"code":400,…"provider is not enabled"}` JSON page with no way back. Asking
 * the public `/auth/v1/settings` endpoint up front lets the UI hide the button
 * instead, and it starts working on its own the moment the provider is enabled.
 */
let cache: Promise<Record<string, boolean>> | null = null;

function fetchProviders(): Promise<Record<string, boolean>> {
  if (!cache) {
    cache = fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_KEY },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => (json?.external as Record<string, boolean>) ?? {})
      .catch(() => ({}));
  }
  return cache;
}

export async function isProviderEnabled(
  provider: SocialProvider
): Promise<boolean> {
  const external = await fetchProviders();
  return external[provider] === true;
}

/**
 * `undefined` while the check is in flight, so callers can render nothing
 * rather than flashing a button that may be about to disappear.
 */
export function useProviderEnabled(
  provider: SocialProvider
): boolean | undefined {
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let active = true;
    fetchProviders().then((external) => {
      if (active) setEnabled(external[provider] === true);
    });
    return () => {
      active = false;
    };
  }, [provider]);

  return enabled;
}
