/**
 * What the firm is selling right now, read from its prop-firm backend: the
 * cheapest live plan, the running offers and the best active coupon. A new
 * chat opens with it (openingOffer in sales.ts) instead of the "how can I
 * help?" menu, so a visitor sees the price and the discount before they
 * have to ask, and the cheapest plan as the easy way to start.
 *
 * Same connection and the same narrow, read-only rules as the trader lookup
 * (prop-firm-supabase.ts): three SELECTs, public columns only. Offers scoped
 * to particular users or accounts are private and never shown. Cached per
 * workspace for a few minutes so every "hi" is not three queries, and any
 * failure (no connection, an HTTP endpoint, a slow backend) returns null,
 * which keeps the old menu.
 */
import { createClient } from '@supabase/supabase-js';
import { loadTraderDataConnection, traderDataActive } from './client';
import { checkSupabaseUrl } from './prop-firm-supabase';

export interface Storefront {
  cheapest: { model: string; size: number; price: number } | null;
  coupon: { code: string; discountPercent: number; expiresAt: string | null } | null;
  offers: Array<{ name: string; description: string | null; expiresAt: string | null }>;
}

const STOREFRONT_TIMEOUT_MS = 3_000;
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: Storefront | null }>();

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const live = (startsAt: unknown, expiresAt: unknown, now: number) =>
  (!startsAt || Date.parse(String(startsAt)) <= now) && (!expiresAt || Date.parse(String(expiresAt)) > now);
const isEmpty = (v: unknown) => !Array.isArray(v) || v.length === 0;

/** Exported for tests: turns the three result sets into a Storefront, or null when there is nothing to show. */
export function buildStorefront(
  plans: Array<Record<string, unknown>>,
  coupons: Array<Record<string, unknown>>,
  offers: Array<Record<string, unknown>>,
  now = Date.now()
): Storefront | null {
  const cheapest =
    plans
      .map((p) => ({ model: String(p.model || '').trim(), size: num(p.size), price: num(p.price) }))
      .filter((p): p is { model: string; size: number; price: number } => Boolean(p.model) && p.size !== null && p.price !== null && p.price > 0)
      .sort((a, b) => a.price - b.price)[0] ?? null;
  const coupon =
    coupons
      .filter((c) => String(c.status) === 'active' && live(null, c.expiresAt, now))
      .map((c) => ({ code: String(c.code || '').trim().toUpperCase(), discountPercent: num(c.discountPercent) ?? 0, expiresAt: c.expiresAt ? String(c.expiresAt) : null }))
      .filter((c) => c.code && c.discountPercent > 0 && c.discountPercent < 100)
      .sort((a, b) => b.discountPercent - a.discountPercent)[0] ?? null;
  const running = offers
    .filter((o) => String(o.status) === 'active' && live(o.startsAt, o.expiresAt, now) && isEmpty(o.userIds) && isEmpty(o.accountIds))
    .map((o) => ({ name: String(o.name || '').trim(), description: o.description ? String(o.description).trim() : null, expiresAt: o.expiresAt ? String(o.expiresAt) : null }))
    .filter((o) => o.name)
    .slice(0, 2);
  if (!cheapest && !coupon && !running.length) return null;
  return { cheapest, coupon, offers: running };
}

export async function loadStorefront(workspaceId: string): Promise<Storefront | null> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value: Storefront | null = null;
  try {
    const conn = await loadTraderDataConnection(workspaceId);
    if (traderDataActive(conn) && conn.kind === 'supabase' && conn.secret) {
      const target = checkSupabaseUrl(conn.url);
      if (target.ok) {
        const db = createClient(target.url, conn.secret, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: {
            fetch: (input, init) => fetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(STOREFRONT_TIMEOUT_MS) }),
            headers: { 'User-Agent': 'Zentry-Trader-Data/1' },
          },
        });
        const [plans, coupons, offers] = await Promise.all([
          db.from('pricing_plans').select('model, size, price').eq('status', 'active').order('price', { ascending: true }).limit(5),
          db.from('coupons').select('code, discountPercent, status, expiresAt').eq('status', 'active').limit(20),
          db
            .from('offers')
            .select('name, description, status, startsAt, expiresAt, userIds, accountIds')
            .eq('status', 'active')
            .limit(10),
        ]);
        for (const [what, r] of [['pricing_plans', plans], ['coupons', coupons], ['offers', offers]] as const) {
          if (r.error) console.warn(`[Storefront] Reading ${what} failed:`, r.error.message);
        }
        value = buildStorefront(plans.data ?? [], coupons.data ?? [], offers.data ?? []);
      }
    }
  } catch (err) {
    console.warn('[Storefront] Could not load the current offers:', (err as Error)?.message);
    value = null;
  }
  cache.set(workspaceId, { at: Date.now(), value });
  return value;
}
