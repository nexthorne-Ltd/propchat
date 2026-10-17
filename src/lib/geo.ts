/**
 * Where a request comes from, worked out on the server.
 *
 * The widget used to ask ipwho.is / ipapi.co from the visitor's browser. Ad
 * blockers block those, ipapi.co rate-limits, and when both failed the visitor
 * kept the timezone-based guess (every Asia/Karachi visitor became "Karachi,
 * Pakistan"). The hosting edge already knows the caller's country and city
 * from the IP, for free and without a third party, so that is used first.
 */

export interface GeoResult {
  city: string | null;
  country: string | null;
  countryCode: string | null;
  source: 'edge' | 'lookup' | null;
}

const EMPTY: GeoResult = { city: null, country: null, countryCode: null, source: null };

function decode(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return value.trim() || null;
  }
}

export function countryNameFor(code: string | null | undefined): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) || null;
  } catch {
    return null;
  }
}

export function clientIpOf(headers: Headers): string | null {
  const ip =
    headers.get('x-real-ip') ||
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('cf-connecting-ip') ||
    null;
  return ip || null;
}

function isPrivateIp(ip: string): boolean {
  return (
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('::ffff:127.')
  );
}

// Lookups are cached per IP for the life of the server instance: a visitor
// sends this on every page load, and the answer does not change.
const lookupCache = new Map<string, { at: number; geo: GeoResult }>();
const LOOKUP_TTL_MS = 6 * 60 * 60 * 1000;

async function lookupIp(ip: string): Promise<GeoResult> {
  const hit = lookupCache.get(ip);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.geo;

  let geo: GeoResult = EMPTY;
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,country,country_code`, {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const d = await res.json();
      if (d?.success !== false && (d?.country_code || d?.country)) {
        const code = d.country_code ? String(d.country_code).toUpperCase() : null;
        geo = {
          city: d.city || null,
          country: countryNameFor(code) || d.country || null,
          countryCode: code,
          source: 'lookup',
        };
      }
    }
  } catch {}

  if (lookupCache.size > 5000) lookupCache.clear();
  lookupCache.set(ip, { at: Date.now(), geo });
  return geo;
}

export async function geoFromRequest(headers: Headers): Promise<GeoResult> {
  const code = (headers.get('x-vercel-ip-country') || headers.get('cf-ipcountry') || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1') {
    return {
      city: decode(headers.get('x-vercel-ip-city')),
      country: countryNameFor(code),
      countryCode: code,
      source: 'edge',
    };
  }

  // Not behind Vercel/Cloudflare (local dev, self-hosting): look the IP up.
  const ip = clientIpOf(headers);
  if (!ip || isPrivateIp(ip)) return EMPTY;
  return lookupIp(ip);
}
