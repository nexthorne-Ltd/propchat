/**
 * Reading a firm's trader records straight from its prop-firm backend
 * (the Supabase project every firm on this platform runs; schema in the
 * prop-firm backend's database-schema.sql).
 *
 * The firm gives its project URL and service-role key in Settings → AI bot →
 * Trader data. That key bypasses the firm's RLS, so everything here is
 * deliberately narrow: only SELECTs, only on the tables a lookup needs, only
 * the columns a trader may see (never passwordHash, passwordMaster,
 * passwordInvestor, document URLs or payment details), always filtered by the
 * user the verified email belongs to, and a few rows at most. A login or
 * order id the visitor typed only narrows that user's own rows.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { TraderLookupAction } from '@/lib/ai/sub-agents';
import { TRADER_DATA_TIMEOUT_MS, TraderDataError, type TraderLookupRequest, type TraderRecord } from './client';
import { checkAgentUrl } from '@/lib/agent/external-agent';

const MAX_ROWS = 5;

/**
 * Whether a key can read the backend: a service-role key. An anon or
 * publishable key reads nothing (RLS is on with no policies), so it is
 * refused when saving rather than failing quietly on every lookup.
 */
export function checkServiceRoleKey(raw: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  const key = String(raw || '').trim();
  if (!key) return { ok: false, reason: 'Paste the service_role key (Supabase → Project Settings → API).' };
  if (key.startsWith('sb_secret_')) return { ok: true };
  if (key.startsWith('sb_publishable_')) return { ok: false, reason: 'That is the publishable key. Paste the secret (service_role) key instead.' };
  const parts = key.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'That does not look like a Supabase key.' };
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (payload?.role === 'service_role') return { ok: true };
    if (payload?.role === 'anon') return { ok: false, reason: 'That is the anon key. Paste the service_role key instead: the anon key cannot read your backend.' };
  } catch {
    return { ok: false, reason: 'That does not look like a Supabase key.' };
  }
  return { ok: false, reason: 'That key is not a service_role key.' };
}

/** https://<ref>.supabase.co (or a custom domain), held to the same public-host rules as other outbound calls. */
export function checkSupabaseUrl(raw: string | null | undefined): { ok: true; url: string } | { ok: false; reason: string } {
  const checked = checkAgentUrl(raw);
  if (!checked.ok) return { ok: false, reason: checked.reason.replace('agent URL', 'Supabase URL').replace('The agent', 'Your Supabase project') };
  return { ok: true, url: checked.url.origin };
}

function clientFor(url: string, key: string, timeoutMs: number): SupabaseClient {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }),
      headers: { 'User-Agent': 'Zentry-Trader-Data/1' },
    },
  });
}

/** Turns a Supabase error into one an admin can act on. */
function fail(what: string, error: { message?: string; code?: string } | null | undefined): never {
  const msg = error?.message || 'unknown error';
  if (/abort|timeout/i.test(msg)) throw new TraderDataError(`Your Supabase did not answer within ${TRADER_DATA_TIMEOUT_MS / 1000} s.`);
  if (error?.code === 'PGRST205' || error?.code === '42P01') {
    throw new TraderDataError(`Your Supabase has no ${what} table. Is this the prop-firm backend's project?`);
  }
  if (/invalid api key|jwt|401/i.test(msg)) throw new TraderDataError('Your Supabase refused the key. Paste the service_role key again.');
  throw new TraderDataError(`Reading ${what} failed: ${msg.slice(0, 160)}`);
}

/** Accounts shown in full; the summary counts all of them. */
const ACCOUNT_DETAIL_ROWS = 10;
/** Room for ten accounts, four dashboards, breach reasons and a few orders. */
const MAX_RECORD_CHARS = 12_000;

const record = (data: unknown): TraderRecord => {
  const text = JSON.stringify({ record: data });
  return { found: true, text: text.length > MAX_RECORD_CHARS ? `${text.slice(0, MAX_RECORD_CHARS)}…(cut)` : text };
};

/**
 * The user with exactly this email, whatever its case. The backend stores
 * new signups in lower case, but older rows may not be: an exact match is
 * tried first, then a case-insensitive one with LIKE's wildcards escaped
 * ("a_b@x.com" must not match "axb@x.com"), and the result is compared
 * again here, so a lookup can only ever reach the verified address.
 */
async function findUserByEmail(db: SupabaseClient, email: string): Promise<Record<string, unknown> | null> {
  const cols = 'id, name, status, createdAt, email';
  const exact = await db.from('users').select(cols).eq('email', email).limit(1);
  if (exact.error) fail('users', exact.error);
  if (exact.data?.length) return exact.data[0] as Record<string, unknown>;
  const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`);
  const loose = await db.from('users').select(cols).ilike('email', pattern).limit(5);
  if (loose.error) fail('users', loose.error);
  const match = ((loose.data || []) as Record<string, unknown>[]).filter((u) => String(u.email || '').trim().toLowerCase() === email);
  return match.length === 1 ? match[0] : null;
}

/** A case-insensitive exact match on one column, LIKE wildcards escaped, compared again here. */
async function findOneByText(db: SupabaseClient, table: string, column: string, value: string, cols: string): Promise<Record<string, unknown> | null> {
  const want = value.trim().toLowerCase();
  const pattern = value.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data, error } = await db.from(table).select(cols).ilike(column, pattern).limit(3);
  if (error) fail(table, error);
  const rows = ((data || []) as unknown as Record<string, unknown>[]).filter((r) => String(r[column] ?? '').trim().toLowerCase() === want);
  return rows.length === 1 ? rows[0] : null;
}

async function userById(db: SupabaseClient, id: unknown): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  const { data, error } = await db.from('users').select('id, name, status, createdAt, email').eq('id', String(id)).maybeSingle();
  if (error) fail('users', error);
  return (data as Record<string, unknown> | null) ?? null;
}

/** The trader who placed this order ("O-2681" matches "o-2681"). */
async function findUserByOrderId(db: SupabaseClient, orderId: string): Promise<Record<string, unknown> | null> {
  const order = await findOneByText(db, 'orders', 'id', orderId, 'id, userId');
  return order ? userById(db, order.userId) : null;
}

/** The trader who holds this trading login. */
async function findUserByLogin(db: SupabaseClient, login: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.from('trading_accounts').select('userId').eq('login', login.trim()).limit(2);
  if (error) fail('trading_accounts', error);
  const owners = [...new Set(((data || []) as Record<string, unknown>[]).map((r) => String(r.userId)))];
  return owners.length === 1 ? userById(db, owners[0]) : null;
}

/**
 * The user's latest orders with their plan and whether each one's account
 * was delivered: for Order lookup, and beside the accounts in Account status
 * ("I paid but have no account"). Only this user's orders; an order id from
 * the chat only narrows them.
 */
async function recentOrders(db: SupabaseClient, userId: string, orderId: string | null, limit: number) {
  let q = db
    .from('orders')
    .select('id, planId, amountPaid, couponUsed, paymentMethod, status, createdAt, updatedAt')
    .eq('userId', userId)
    .order('createdAt', { ascending: false })
    .limit(limit);
  // Ids are typed in any case ("O-2681" for o-2681); LIKE wildcards escaped.
  if (orderId) q = q.ilike('id', orderId.trim().replace(/[\\%_]/g, (c) => `\\${c}`));
  const { data: orders, error } = await q;
  if (error) fail('orders', error);
  const list = (orders || []) as Record<string, unknown>[];
  if (!list.length) return [];
  const orderIds = list.map((o) => String(o.id));
  const planIds = [...new Set(list.map((o) => o.planId).filter(Boolean).map(String))];
  const [{ data: accounts, error: accErr }, { data: plans, error: planErr }] = await Promise.all([
    db.from('trading_accounts').select('orderId, deliveryStatus, deliveredAt, phase, status').eq('userId', userId).in('orderId', orderIds),
    planIds.length ? db.from('challenge_plans').select('id, name, size').in('id', planIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (accErr) fail('trading_accounts', accErr);
  if (planErr) fail('challenge_plans', planErr);
  const planOf = new Map(((plans || []) as Record<string, unknown>[]).map((p) => [String(p.id), p]));
  return list.map((o) => {
    const plan = planOf.get(String(o.planId));
    const acc = ((accounts || []) as Record<string, unknown>[]).filter((a) => a.orderId === o.id);
    return {
      order_id: o.id,
      plan: plan ? `${plan.name} ${plan.size}` : o.planId,
      amount_paid: o.amountPaid,
      coupon: o.couponUsed,
      payment_method: o.paymentMethod,
      status: o.status,
      ordered_at: o.createdAt,
      updated_at: o.updatedAt,
      accounts: acc.length
        ? acc.map((a) => ({
            phase: a.phase,
            status: a.status,
            credentials: a.deliveryStatus === 'delivered' ? `delivered ${a.deliveredAt ?? ''}`.trim() : 'not delivered yet',
          }))
        : 'no account created for this order yet',
    };
  });
}

/** A row's breach reason as the backend stores it (accountTradingRules.ts). */
export function breachReason(payload: unknown): { rule: string | null; title: string; message: string; recorded_at: string | null } | null {
  if (!payload || typeof payload !== 'object') return null;
  // The compliance block is "_<brand>Compliance"; firms rebrand the prefix.
  const block = Object.entries(payload as Record<string, unknown>).find(([k]) => /^_\w*Compliance$/i.test(k))?.[1] as
    | { breachReason?: { id?: unknown; title?: unknown; message?: unknown; recordedAt?: unknown } }
    | undefined;
  const r = block?.breachReason;
  if (!r || !r.title || !r.message) return null;
  return {
    // e.g. "daily-drawdown-breach": the rule the account broke.
    rule: r.id ? String(r.id) : null,
    title: String(r.title),
    message: String(r.message),
    recorded_at: r.recordedAt ? String(r.recordedAt) : null,
  };
}

/** Accounts whose dashboard (stats) goes into the record: the latest, or the one asked about. */
const STATS_ACCOUNTS = 4;
/** Days of the equity curve shown: enough for "how did this week go". */
const CURVE_DAYS = 7;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * The trader's dashboard for one account, from statisticsPayload (the stats
 * API's response, refreshed every 30 minutes): the numbers a trader sees on
 * the account page, so the bot can answer "what is my drawdown / win rate /
 * profit this week / best day" with the same figures. Only a compact
 * summary: the full payload holds every trade.
 */
export function dashboardOf(payload: unknown, updatedAt?: unknown): Record<string, unknown> | null {
  const stats = obj(obj(payload).statistics);
  if (!Object.keys(stats).length) return null;
  const acc = obj(stats.account_stats);
  const adv = obj(stats.advanced_statistics);
  const periods = obj(obj(stats.monthly_yearly_performance).period_returns);
  const period = (k: string) => {
    const p = obj(periods[k]);
    return Object.keys(p).length ? { profit: num(p.profit), trades: num(p.trades_count), win_rate: num(p.win_rate) } : null;
  };
  const days = (Array.isArray(obj(stats.equity_curve).daily_performance) ? (obj(stats.equity_curve).daily_performance as unknown[]) : [])
    .map(obj)
    .slice(-CURVE_DAYS)
    .map((d) => ({ date: d.date, balance: num(d.cumulative_balance), profit_so_far: num(d.cumulative_profit), drawdown: num(d.drawdown), trades: num(d.trades_count) }));
  const symbols = Object.entries(obj(stats.by_symbol))
    .map(([symbol, v]) => ({ symbol, trades: num(obj(v).trades), profit: num(obj(v).profit), win_rate: num(obj(v).won_percentage) }))
    .sort((a, b) => (b.trades ?? 0) - (a.trades ?? 0))
    .slice(0, 3);
  const best = obj(adv.best_trade_profit);
  const worst = obj(adv.worst_trade_profit);
  return {
    stats_updated_at: updatedAt ?? null,
    balance: num(acc.balance),
    equity: num(acc.equity),
    profit: num(acc.profit),
    gain_percent: num(acc.abs_gain_percent),
    drawdown_percent: num(acc.drawdown_percent),
    worst_drop_from_peak: num(acc.worst_drop_from_peak),
    peak_balance: num(acc.peak_balance),
    lowest_balance: num(acc.lowest_balance),
    trading_days: num(acc.trading_days),
    best_day: acc.best_day_date ? { date: acc.best_day_date, profit: num(acc.best_day_profit) } : null,
    total_trades: num(adv.total_trades),
    win_rate: num(adv.win_rate),
    profit_factor: num(adv.profit_factor),
    avg_win: num(obj(adv.avg_win).profit),
    avg_loss: num(obj(adv.avg_loss).profit),
    best_trade: best.date ? { date: best.date, profit: num(best.value) } : null,
    worst_trade: worst.date ? { date: worst.date, profit: num(worst.value) } : null,
    avg_trade_hours: num(adv.avg_trade_length_hours),
    today: period('today'),
    this_week: period('this_week'),
    this_month: period('this_month'),
    last_days: days,
    top_symbols: symbols,
    open_trades: num(obj(obj(payload).open_trades).count),
  };
}

export async function lookupInPropFirmSupabase(
  conn: { url: string; key: string },
  req: TraderLookupRequest,
  timeoutMs = TRADER_DATA_TIMEOUT_MS
): Promise<{ record: TraderRecord; latencyMs: number }> {
  const target = checkSupabaseUrl(conn.url);
  if (!target.ok) throw new TraderDataError(target.reason);
  const started = Date.now();
  const db = clientFor(target.url, conn.key, timeoutMs);
  const done = (r: TraderRecord) => ({ record: r, latencyMs: Date.now() - started });

  if (req.action === 'test') {
    const { error } = await db.from('users').select('id', { head: true, count: 'exact' }).limit(1);
    if (error) fail('users', error);
    return done({ found: true, text: '' });
  }

  if (req.action === 'coupon_check') {
    const code = (req.hints.coupon_code || '').trim().toUpperCase();
    if (!code) return done({ found: false, text: JSON.stringify({ message: 'The customer did not name a code.' }) });
    const { data, error } = await db.from('coupons').select('code, discountPercent, status, expiresAt').eq('code', code).maybeSingle();
    if (error) fail('coupons', error);
    if (!data) return done({ found: false, text: JSON.stringify({ message: `There is no coupon ${code}.` }) });
    const expired = data.expiresAt ? Date.parse(String(data.expiresAt)) < Date.now() : false;
    return done(
      record({
        code: data.code,
        discount_percent: data.discountPercent,
        status: expired ? 'expired' : data.status,
        expires_at: data.expiresAt,
      })
    );
  }

  // Everything else is one user's own rows. Who: with the code, only the
  // verified email; without it, an order id or account login the trader
  // typed finds them first, then the email they gave.
  const email = (req.verifiedEmail || '').trim().toLowerCase();
  let user: Record<string, unknown> | null = null;
  let foundBy = 'email';
  if (req.findByIds && req.hints.order_id) {
    user = await findUserByOrderId(db, req.hints.order_id);
    if (user) foundBy = `order ${req.hints.order_id}`;
  }
  if (!user && req.findByIds && req.hints.account_login) {
    user = await findUserByLogin(db, req.hints.account_login);
    if (user) foundBy = `account login ${req.hints.account_login}`;
  }
  if (!user && email) user = await findUserByEmail(db, email);
  if (!user && !email && !(req.findByIds && (req.hints.order_id || req.hints.account_login))) {
    throw new TraderDataError('A personal lookup needs an email, or an order id or login.');
  }
  if (!user) {
    const tried = [req.hints.order_id && `order ${req.hints.order_id}`, req.hints.account_login && `login ${req.hints.account_login}`, email && `email ${email}`].filter(Boolean).join(', ');
    return done({ found: false, text: JSON.stringify({ message: `No trader was found for ${tried}.` }) });
  }
  const userId = String(user.id);
  const who = { name: user.name, account_status: user.status, member_since: user.createdAt, found_by: foundBy };
  // Found by the order or login: that user's rows, and the id is no longer a filter.
  const hints = foundBy.startsWith('order') ? { ...req.hints, account_login: undefined } : req.hints;

  const action: TraderLookupAction = req.action;
  switch (action) {
    case 'account_status': {
      // Every account first, light columns only: the trader asks "how many
      // accounts do I have and which are live", so the totals must cover all
      // of them, not just the few shown in detail.
      const { data: all, error: allErr } = await db
        .from('trading_accounts')
        .select('status, deliveryStatus')
        .eq('userId', userId)
        .limit(500);
      if (allErr) fail('trading_accounts', allErr);
      const allRows = (all || []) as Record<string, unknown>[];
      const byStatus: Record<string, number> = {};
      for (const a of allRows) byStatus[String(a.status)] = (byStatus[String(a.status)] || 0) + 1;
      const summary = {
        total_accounts: allRows.length,
        by_status: byStatus,
        credentials_not_delivered: allRows.filter((a) => a.deliveryStatus !== 'delivered').length,
      };

      let q = db
        .from('trading_accounts')
        .select('id, orderId, login, platform, phase, status, balance, equity, totalPl, profitTarget, deliveryStatus, deliveredAt, createdAt')
        .eq('userId', userId)
        .order('createdAt', { ascending: false })
        .limit(ACCOUNT_DETAIL_ROWS);
      if (hints.account_login) q = q.eq('login', hints.account_login);
      const { data, error } = await q;
      if (error) fail('trading_accounts', error);
      // statisticsPayload holds the dashboard (the stats API's response) and
      // the stored breach reason. Read it for every failed account (its
      // reason) and for the first few accounts (their dashboard), not for
      // all: it is the heaviest column.
      const rows = (data || []) as Record<string, unknown>[];
      const failedIds = rows.filter((a) => a.status === 'Failed').map((a) => String(a.id));
      const statsIds = rows.slice(0, STATS_ACCOUNTS).map((a) => String(a.id));
      const payloadIds = [...new Set([...failedIds, ...statsIds])];
      const payloads = new Map<string, { payload: unknown; updatedAt: unknown }>();
      if (payloadIds.length) {
        const { data: got, error: payloadErr } = await db
          .from('trading_accounts')
          .select('id, statisticsPayload, statisticsUpdatedAt')
          .eq('userId', userId)
          .in('id', payloadIds);
        if (payloadErr) fail('trading_accounts', payloadErr);
        for (const p of (got || []) as Record<string, unknown>[]) payloads.set(String(p.id), { payload: p.statisticsPayload, updatedAt: p.statisticsUpdatedAt });
      }
      const accounts = rows.map((a) => {
        const p = payloads.get(String(a.id));
        return {
          login: a.login,
          platform: a.platform,
          phase: a.phase,
          status: a.status,
          balance: a.balance,
          equity: a.equity,
          total_pl: a.totalPl,
          profit_target: a.profitTarget,
          credentials: a.deliveryStatus === 'delivered' ? `delivered ${a.deliveredAt ?? ''}`.trim() : 'not delivered yet',
          failed_reason: a.status === 'Failed' ? (breachReason(p?.payload) ?? 'not recorded') : null,
          dashboard: statsIds.includes(String(a.id)) ? dashboardOf(p?.payload, p?.updatedAt) : undefined,
          order_id: a.orderId,
          created_at: a.createdAt,
        };
      });
      if (!accounts.length && hints.account_login) {
        return done({ found: false, text: JSON.stringify({ message: `No account with login ${hints.account_login} belongs to this email.` }) });
      }
      // Recent orders too: "I paid but got no account" is answered by an
      // order without a delivered account.
      const orders = await recentOrders(db, userId, null, 3);
      return done(record({ ...who, summary, accounts, recent_orders: orders }));
    }

    case 'kyc_status': {
      const { data, error } = await db.from('kyc').select('documentType, status, rejectReason, updatedAt').eq('userId', userId).maybeSingle();
      if (error) fail('kyc', error);
      return done(
        record({
          ...who,
          kyc: data
            ? { method: data.documentType, status: data.status, reject_reason: data.rejectReason, updated_at: data.updatedAt }
            : { status: 'not submitted' },
        })
      );
    }

    case 'order_status': {
      const orders = await recentOrders(db, userId, hints.order_id ?? null, MAX_ROWS);
      if (!orders.length && hints.order_id) {
        return done({ found: false, text: JSON.stringify({ message: `No order ${hints.order_id} belongs to this email.` }) });
      }
      return done(record({ ...who, orders }));
    }

    case 'affiliate_stats': {
      const [{ data: aff, error: affErr }, { data: refs, error: refErr }] = await Promise.all([
        db.from('affiliates').select('referralCode, commissionRate').eq('userId', userId).maybeSingle(),
        db.from('referrals').select('commissionAmount, status, createdAt').eq('affiliateId', userId).order('createdAt', { ascending: false }).limit(200),
      ]);
      if (affErr) fail('affiliates', affErr);
      if (refErr) fail('referrals', refErr);
      const rows = (refs || []) as { commissionAmount: number; status: string; createdAt: string }[];
      const sum = (s: string) => Math.round(rows.filter((r) => r.status === s).reduce((t, r) => t + Number(r.commissionAmount || 0), 0) * 100) / 100;
      return done(
        record({
          ...who,
          affiliate: aff ? { referral_code: aff.referralCode, commission_rate_percent: aff.commissionRate } : null,
          referred_sales: rows.length,
          commission: { pending: sum('pending'), approved: sum('approved'), paid: sum('paid') },
          latest: rows.slice(0, MAX_ROWS).map((r) => ({ amount: r.commissionAmount, status: r.status, at: r.createdAt })),
        })
      );
    }
  }
  throw new TraderDataError(`Unknown lookup ${String(action)}.`);
}
