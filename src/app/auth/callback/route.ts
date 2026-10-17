import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Sanitizes the `next` redirect parameter.
 * Accepts `next` only if it starts with exactly one `/`; rejects `//`, `/\`,
 * and anything containing `://` or `@`. Falls back to `/dashboard`.
 */
export function sanitizeNextPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '/dashboard';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/dashboard';
  }
  if (raw.includes('://') || raw.includes('@')) {
    return '/dashboard';
  }
  return raw;
}

/**
 * Resolves the base URL for redirects.
 * Uses `x-forwarded-host` only if it is listed in `NEXT_PUBLIC_PLATFORM_HOSTS`
 * (comma-separated); otherwise uses the request origin.
 */
export function resolveBaseUrl(request: Request, origin: string): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedHost) {
    const allowedHosts = (process.env.NEXT_PUBLIC_PLATFORM_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    const host = forwardedHost.trim().toLowerCase();
    if (allowedHosts.includes(host)) {
      return `https://${forwardedHost.trim()}`;
    }
  }
  return origin;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');
  const next = sanitizeNextPath(searchParams.get('next'));
  const baseUrl = resolveBaseUrl(request, origin);

  if (error) {
    const errorMsg = errorDescription || error;
    return NextResponse.redirect(`${baseUrl}/login?error=${encodeURIComponent(errorMsg)}`);
  }

  if (code) {
    try {
      const supabase = await createClient();
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

      if (exchangeError) {
        console.error('Error exchanging OAuth code:', exchangeError.message);
        return NextResponse.redirect(
          `${baseUrl}/login?error=${encodeURIComponent(exchangeError.message)}`
        );
      }

      // Check if user has an existing workspace
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session?.user?.id) {
        const { data: agent } = await supabase
          .from('agents')
          .select('workspace_id')
          .eq('id', session.user.id)
          .maybeSingle();

        const { data: ownedWs } = await supabase
          .from('workspaces')
          .select('id')
          .eq('owner_id', session.user.id)
          .limit(1)
          .maybeSingle();

        // If new user with no workspace, send to onboarding
        if (!agent?.workspace_id && !ownedWs?.id) {
          return NextResponse.redirect(`${baseUrl}/onboarding`);
        }
      }

      return NextResponse.redirect(`${baseUrl}${next}`);
    } catch (err: any) {
      console.error('Unexpected auth callback error:', err);
      return NextResponse.redirect(
        `${baseUrl}/login?error=${encodeURIComponent(err.message || 'Authentication callback failed')}`
      );
    }
  }

  return NextResponse.redirect(`${baseUrl}/login?error=no_auth_code`);
}
