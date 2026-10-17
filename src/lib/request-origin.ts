import { headers } from 'next/headers';

/**
 * Resolves the application origin dynamically:
 * 1. From an explicit Request or Headers object (if passed from an API route)
 * 2. From incoming request headers via `headers()` (in Next.js Server Actions / Server Components)
 *    - header `origin` (e.g. "https://zen-try.site")
 *    - header `x-forwarded-host` + `x-forwarded-proto` (standard Vercel / reverse proxy)
 *    - header `host` + `x-forwarded-proto`
 *    - header `referer` origin
 * 3. From environment variables:
 *    - NEXT_PUBLIC_APP_URL
 *    - APP_URL
 *    - VERCEL_PROJECT_PRODUCTION_URL
 *    - VERCEL_URL
 * 4. Fallback to production platform URL ('https://zen-try.site')
 */
export async function getRequestOrigin(req?: Request | Headers | null): Promise<string> {
  // 1. Explicit request or headers object
  if (req) {
    const h = req instanceof Headers ? req : req.headers;
    const origin = h.get('origin');
    if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
      return origin.replace(/\/+$/, '');
    }
    const forwardedHost = h.get('x-forwarded-host');
    const forwardedProto = h.get('x-forwarded-proto') || 'https';
    if (forwardedHost && !forwardedHost.includes('localhost') && !forwardedHost.includes('127.0.0.1')) {
      return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '');
    }
    const host = h.get('host');
    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      return `${forwardedProto}://${host}`.replace(/\/+$/, '');
    }
    const referer = h.get('referer');
    if (referer) {
      try {
        const refUrl = new URL(referer);
        if (refUrl.origin && !refUrl.origin.includes('localhost') && !refUrl.origin.includes('127.0.0.1')) {
          return refUrl.origin.replace(/\/+$/, '');
        }
      } catch {}
    }
    // If request genuinely originated from localhost (local development)
    if (origin) return origin.replace(/\/+$/, '');
    if (forwardedHost) return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '');
    if (host) return `${forwardedProto}://${host}`.replace(/\/+$/, '');
  }

  // 2. Next.js server context via headers()
  try {
    const h = await headers();
    const origin = h.get('origin');
    if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
      return origin.replace(/\/+$/, '');
    }
    const forwardedHost = h.get('x-forwarded-host');
    const forwardedProto = h.get('x-forwarded-proto') || 'https';
    if (forwardedHost && !forwardedHost.includes('localhost') && !forwardedHost.includes('127.0.0.1')) {
      return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '');
    }
    const host = h.get('host');
    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      return `${forwardedProto}://${host}`.replace(/\/+$/, '');
    }
    const referer = h.get('referer');
    if (referer) {
      try {
        const refUrl = new URL(referer);
        if (refUrl.origin && !refUrl.origin.includes('localhost') && !refUrl.origin.includes('127.0.0.1')) {
          return refUrl.origin.replace(/\/+$/, '');
        }
      } catch {}
    }
    // If request genuinely originated from localhost (local development)
    if (origin) return origin.replace(/\/+$/, '');
    if (forwardedHost) return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '');
    if (host) return `${forwardedProto}://${host}`.replace(/\/+$/, '');
  } catch {
    // Outside request context (e.g. tests or background jobs)
  }

  // 3. Fallbacks from Environment variables
  const envUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (envUrl && !envUrl.includes('localhost') && !envUrl.includes('127.0.0.1')) {
    return envUrl.replace(/\/+$/, '');
  }

  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`.replace(/\/+$/, '');
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`.replace(/\/+$/, '');
  }

  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }

  return 'https://zen-try.site';
}

/** Synchronous fallback helper for non-async contexts */
export function getStaticAppOrigin(): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (envUrl && !envUrl.includes('localhost') && !envUrl.includes('127.0.0.1')) {
    return envUrl.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`.replace(/\/+$/, '');
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) {
      return window.location.origin;
    }
  }
  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }
  return 'https://zen-try.site';
}
