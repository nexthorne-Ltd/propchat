import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import {
  isPlatformHost,
  parseHelpBaseSubdomain,
  isHelpBaseHost,
  cleanDomain,
  HELP_BASE_DOMAIN,
} from '@/lib/domain';

// No hardcoded fallback: a deployment without these must not quietly talk to
// some other project's database.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

/**
 * Runs before every matched request, so every await here is paid by every
 * page view. It used to call auth.getUser() — a round trip to Supabase Auth —
 * on every request, API calls from the widget included, and then repeat the
 * super-admin lookup the /admin layout makes anyway. Now:
 *   - API routes skip the session entirely; each one authenticates itself.
 *   - Pages read the session with getClaims(), which verifies the JWT locally
 *     (and refreshes it when it has expired) instead of asking the server.
 *   - /admin is left to its layout, except the owner-only /admin/access.
 */
type HelpWorkspace = { id: string; slug: string | null; custom_domain: string | null; custom_domain_status: string | null };

/**
 * Address → workspace lookups, kept for a minute per server instance. On a
 * custom domain every request (the page, its data requests, scripts) used to
 * repeat the same database query before anything else could happen. A slug or
 * domain change shows up within a minute; misses are remembered too, so a
 * random host cannot make us query on every hit.
 */
const LOOKUP_TTL_MS = 60_000;
const lookupCache = new Map<string, { at: number; value: HelpWorkspace | null }>();

async function lookupWorkspace(
  key: string,
  query: () => PromiseLike<{ data: HelpWorkspace[] | null; error: unknown }>
): Promise<HelpWorkspace | null> {
  const hit = lookupCache.get(key);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.value;
  const { data, error } = await query();
  // A failed lookup is not cached: the next request tries again.
  if (error) return hit?.value ?? null;
  const value = data?.[0] ?? null;
  if (lookupCache.size > 5000) lookupCache.clear();
  lookupCache.set(key, { at: Date.now(), value });
  return value;
}

export async function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-next-pathname', request.nextUrl.pathname);

  let response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[Proxy] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.');
    return response;
  }

  const supabase = createServerClient(
    SUPABASE_URL,
    SUPABASE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({
            request: {
              headers: requestHeaders,
            },
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Host-based routing for Custom Domains and Help Center subdomains
  const host = request.headers.get('host')?.toLowerCase().split(':')[0] || '';
  const pathname = request.nextUrl.pathname;

  // Who is signed in, read only for pages (and only once). getClaims checks
  // the token's signature locally and refreshes an expired session.
  let userId: string | null | undefined;
  const currentUserId = async (): Promise<string | null> => {
    if (userId !== undefined) return userId;
    try {
      const { data } = await supabase.auth.getClaims();
      userId = (data?.claims?.sub as string | undefined) ?? null;
    } catch {
      userId = null;
    }
    return userId;
  };
  // 1. Ready-made Help Center Subdomain routing (<slug>.HELP_BASE_DOMAIN)
  const { isSubdomain, slug: helpSlug } = parseHelpBaseSubdomain(host);

  // The public help center has no sign-in, so its requests skip the session
  // check (a round trip to Supabase Auth when the token needs checking).
  const isHelpTraffic =
    isSubdomain || pathname.startsWith('/help') || (!isPlatformHost(host) && !isHelpBaseHost(host));
  if (!pathname.startsWith('/api/') && !isHelpTraffic) await currentUserId();

  if (isSubdomain && helpSlug) {
    const ws = await lookupWorkspace(`slug:${helpSlug}`, () =>
      supabase.from('public_workspaces').select('id, slug, custom_domain, custom_domain_status').eq('slug', helpSlug).limit(1)
    );

    if (ws) {
      // If the custom domain is live (verified), redirect the platform subdomain to it
      if (ws.custom_domain && (ws.custom_domain_status === 'live' || ws.custom_domain_status === 'verified')) {
        const liveDomain = cleanDomain(ws.custom_domain);
        const liveUrl = new URL(`https://${liveDomain}${pathname}`);
        liveUrl.search = request.nextUrl.search;
        return NextResponse.redirect(liveUrl, 308);
      }

      // Sitemap routing on subdomain (e.g. acme.zentryhelp.com/sitemap.xml)
      if (pathname === '/sitemap.xml') {
        const sitemapUrl = request.nextUrl.clone();
        sitemapUrl.pathname = `/help/${ws.id}/sitemap.xml`;
        return NextResponse.rewrite(sitemapUrl, {
          request: { headers: request.headers },
        });
      }

      // Root Help Center on subdomain (e.g. acme.zentryhelp.com/)
      if (pathname === '/' || pathname === '') {
        const helpUrl = request.nextUrl.clone();
        helpUrl.pathname = `/help/${ws.id}`;
        return NextResponse.rewrite(helpUrl, {
          request: { headers: request.headers },
        });
      }

      // If someone hit /help/<slug> on the subdomain itself, normalize to clean root
      if (pathname === `/help/${ws.slug}` || pathname === `/help/${ws.id}`) {
        const cleanUrl = request.nextUrl.clone();
        cleanUrl.pathname = '/';
        return NextResponse.redirect(cleanUrl, 308);
      }
      if (pathname.startsWith(`/help/${ws.slug}/`) || pathname.startsWith(`/help/${ws.id}/`)) {
        const subPath = pathname.replace(new RegExp(`^/help/(?:${ws.slug}|${ws.id})`), '');
        const cleanUrl = request.nextUrl.clone();
        cleanUrl.pathname = subPath || '/';
        return NextResponse.redirect(cleanUrl, 308);
      }

      // Direct article paths (e.g. acme.zentryhelp.com/getting-started)
      if (
        !pathname.startsWith('/api') &&
        !pathname.startsWith('/_next') &&
        !pathname.startsWith('/help')
      ) {
        const articleUrl = request.nextUrl.clone();
        articleUrl.pathname = `/help/${ws.id}${pathname}`;
        return NextResponse.rewrite(articleUrl, {
          request: { headers: request.headers },
        });
      }
    }
  }

  // 2. Custom Domain routing (e.g. support.mycompany.com)
  if (!isSubdomain && !isPlatformHost(host) && !isHelpBaseHost(host)) {
    const ws = await lookupWorkspace(`domain:${host}`, () =>
      supabase.from('public_workspaces').select('id, slug, custom_domain, custom_domain_status').ilike('custom_domain', host).limit(1)
    );

    if (ws) {
      // Sitemap routing
      if (pathname === '/sitemap.xml') {
        const sitemapUrl = request.nextUrl.clone();
        sitemapUrl.pathname = `/help/${ws.id}/sitemap.xml`;
        return NextResponse.rewrite(sitemapUrl, {
          request: { headers: request.headers },
        });
      }

      // Root Help Center
      if (pathname === '/' || pathname === '') {
        const helpUrl = request.nextUrl.clone();
        helpUrl.pathname = `/help/${ws.id}`;
        return NextResponse.rewrite(helpUrl, {
          request: { headers: request.headers },
        });
      }

      // Article direct path (e.g. support.mycompany.com/article-slug)
      if (
        !pathname.startsWith('/api') &&
        !pathname.startsWith('/_next') &&
        !pathname.startsWith('/help')
      ) {
        const articleUrl = request.nextUrl.clone();
        articleUrl.pathname = `/help/${ws.id}${pathname}`;
        return NextResponse.rewrite(articleUrl, {
          request: { headers: request.headers },
        });
      }
    }
  }

  // 3. Keep /help/<slug> working and redirect it to the subdomain (or verified custom domain).
  // Except for the design preview in Settings, which frames the help center
  // on this same origin so it can receive the unsaved design: the frame's
  // load (Sec-Fetch-Dest: iframe) and its in-page navigations (RSC fetches)
  // are same-origin requests. A visitor never makes those for /help here,
  // because their first load is redirected.
  const samePreviewFrame =
    request.headers.get('sec-fetch-site') === 'same-origin' &&
    (request.headers.get('sec-fetch-dest') === 'iframe' || request.headers.get('rsc') === '1');
  if (pathname.startsWith('/help') && !isSubdomain && !samePreviewFrame) {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 2 && segments[0] === 'help') {
      const slugOrId = segments[1];
      if (slugOrId !== 'api' && slugOrId !== '_next' && slugOrId !== 'sitemap.xml') {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
        const targetWs = await lookupWorkspace(`${isUuid ? 'id' : 'slug'}:${slugOrId.toLowerCase()}`, () =>
          supabase
            .from('public_workspaces')
            .select('id, slug, custom_domain, custom_domain_status')
            .eq(isUuid ? 'id' : 'slug', slugOrId)
            .limit(1)
        );

        if (targetWs) {
          const rest = segments.slice(2).join('/');
          const subPath = rest ? `/${rest}` : '';

          // If workspace has a live/verified custom domain, redirect to it
          if (targetWs.custom_domain && (targetWs.custom_domain_status === 'live' || targetWs.custom_domain_status === 'verified')) {
            const customUrl = new URL(`https://${cleanDomain(targetWs.custom_domain)}${subPath}`);
            customUrl.search = request.nextUrl.search;
            return NextResponse.redirect(customUrl, 308);
          }

          // Otherwise redirect to ready-made platform subdomain (<slug>.HELP_BASE_DOMAIN)
          if (HELP_BASE_DOMAIN) {
            const targetSlug = targetWs.slug || targetWs.id;
            const proto = HELP_BASE_DOMAIN.includes('localhost') ? 'http' : 'https';
            const redirectUrl = new URL(`${proto}://${targetSlug}.${HELP_BASE_DOMAIN}${subPath}`);
            redirectUrl.search = request.nextUrl.search;
            return NextResponse.redirect(redirectUrl, 308);
          }
        }
      }
    }
  }

  // Agent dashboard requires a session — send logged-out visitors to sign in
  // and bring them back afterwards.
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
    if (!(await currentUserId())) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', pathname + request.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }

    // An account with an authenticator app must finish the code step before
    // it sees the inbox. getAuthenticatorAssuranceLevel reads the session's
    // own token, so this costs no extra request.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('mfa', '1');
      loginUrl.searchParams.set('redirect', pathname + request.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
  }

  // /admin: the layout checks platform_access and renders the 403 page, and
  // every admin action checks it again, so only the sign-in redirect and the
  // owner-only section are decided here.
  if ((pathname === '/admin' || pathname.startsWith('/admin/')) && !pathname.startsWith('/admin/invite')) {
    const uid = await currentUserId();
    if (!uid) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', pathname + request.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
    if (pathname.startsWith('/admin/access')) {
      const { data: access } = await supabase.from('platform_access').select('role').eq('user_id', uid).maybeSingle();
      if (access?.role !== 'owner') return NextResponse.redirect(new URL('/admin', request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (widget.js, demo.html, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|widget.js|demo.html|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
