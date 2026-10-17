import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Reading a firm's prop-firm backend: only the verified user's rows, never a
 * password or document column, ids from the chat only narrow those rows, and
 * the breach reason is found however the firm rebranded its compliance key.
 * The Supabase client is faked: it records every query and answers from the
 * tables below.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const queries: { table: string; columns: string; filters: [string, string, unknown][] }[] = [];

function builder(table: string) {
  const q = { table, columns: '', filters: [] as [string, string, unknown][] };
  queries.push(q);
  const rows = () =>
    (tables[table] || []).filter((r) =>
      q.filters.every(([op, col, v]) =>
        op === 'eq'
          ? r[col] === v
          : op === 'ilike'
          ? String(r[col] ?? '').toLowerCase() === String(v).replace(/\\([\\%_])/g, '$1').toLowerCase()
          : (v as unknown[]).includes(r[col])
      )
    );
  const pick = (r: Row) =>
    q.columns === 'id' ? { id: r.id } : Object.fromEntries(q.columns.split(',').map((c) => c.trim()).filter((c) => c in r).map((c) => [c, r[c]]));
  const b = {
    select(cols: string) {
      q.columns = cols;
      return b;
    },
    eq(col: string, v: unknown) {
      q.filters.push(['eq', col, v]);
      return b;
    },
    ilike(col: string, v: unknown) {
      q.filters.push(['ilike', col, v]);
      return b;
    },
    in(col: string, v: unknown[]) {
      q.filters.push(['in', col, v]);
      return b;
    },
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({ data: rows()[0] ? pick(rows()[0]) : null, error: null }),
    then(resolve: (v: { data: Row[]; error: null }) => void) {
      resolve({ data: rows().map(pick), error: null });
    },
  };
  return b;
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: builder }) }));

const { lookupInPropFirmSupabase, checkServiceRoleKey, checkSupabaseUrl, breachReason, dashboardOf } = await import('./prop-firm-supabase');

const CONN = { url: 'https://abcd.supabase.co', key: 'sb_secret_x' };
const req = (action: 'account_status' | 'kyc_status' | 'order_status' | 'affiliate_stats' | 'coupon_check', extra: Record<string, unknown> = {}) =>
  lookupInPropFirmSupabase(CONN, {
    action,
    workspaceId: 'ws',
    conversationId: 'c',
    verifiedEmail: 'ali@x.com',
    hints: {},
    question: 'q',
    ...extra,
  });

const FORBIDDEN = /passwordHash|passwordMaster|passwordInvestor|frontUrl|backUrl|selfieUrl|addressUrl|paymentDetails/;

beforeEach(() => {
  queries.length = 0;
  tables = {
    users: [
      { id: 'u-1', email: 'ali@x.com', name: 'Ali', status: 'active', createdAt: '2026-01-01', passwordHash: 'HASH' },
      { id: 'u-2', email: 'sara@x.com', name: 'Sara', status: 'active', createdAt: '2026-01-01', passwordHash: 'HASH' },
    ],
    trading_accounts: [
      {
        id: 'a1', userId: 'u-1', orderId: 'o-1', login: '50012345', platform: 'MT5', phase: 'Phase 1 (Evaluation)', status: 'Failed',
        balance: 9480, equity: 9480, todayPl: -520, totalPl: -520, profitTarget: 800, deliveryStatus: 'delivered', deliveredAt: '2026-10-01',
        passwordMaster: 'SECRET', passwordInvestor: 'SECRET', createdAt: '2026-10-01',
        statisticsPayload: { trades: [1, 2, 3], _acmeCompliance: { breachReason: { title: 'Daily drawdown', message: 'Lost 5.2% in one day', recordedAt: '2026-10-16' } } },
      },
      { id: 'a2', userId: 'u-2', orderId: 'o-2', login: '50099999', status: 'Active', deliveryStatus: 'pending', passwordMaster: 'SECRET', createdAt: '2026-10-02' },
    ],
    kyc: [{ userId: 'u-1', documentType: 'didit', status: 'rejected', rejectReason: 'Blurry photo', frontUrl: 'https://doc', updatedAt: '2026-10-10' }],
    orders: [{ id: 'o-1', userId: 'u-1', planId: 'p-10', amountPaid: 99, paymentMethod: 'Crypto QR', status: 'Active', createdAt: '2026-10-01' }],
    challenge_plans: [{ id: 'p-10', name: 'Two Step', size: 10000, password: 'SECRET' }],
    affiliates: [{ userId: 'u-1', referralCode: 'ALI10', commissionRate: 10 }],
    referrals: [
      { affiliateId: 'u-1', commissionAmount: 9.9, status: 'pending', createdAt: '2026-10-05' },
      { affiliateId: 'u-1', commissionAmount: 20, status: 'paid', createdAt: '2026-09-05' },
    ],
    coupons: [{ code: 'SAVE20', discountPercent: 20, status: 'active', expiresAt: '2020-01-01' }],
  };
});

describe('lookupInPropFirmSupabase', () => {
  it('account status: the verified user\'s accounts with the breach reason, never credentials', async () => {
    const { record } = await req('account_status');
    expect(record.found).toBe(true);
    expect(record.text).toContain('50012345');
    expect(record.text).toContain('Lost 5.2% in one day');
    expect(record.text).not.toContain('50099999');
    expect(record.text).not.toContain('SECRET');
    expect(record.text).not.toContain('trades');
    for (const q of queries) expect(q.columns, q.table).not.toMatch(FORBIDDEN);
    expect(queries.find((q) => q.table === 'trading_accounts')!.filters).toContainEqual(['eq', 'userId', 'u-1']);
  });

  it('a login typed in the chat that belongs to someone else finds nothing', async () => {
    const { record } = await req('account_status', { hints: { account_login: '50099999' } });
    expect(record.found).toBe(false);
    expect(record.text).not.toContain('Active');
  });

  it('an email stored in other case is found; a look-alike never is', async () => {
    tables.users.push({ id: 'u-3', email: 'Old.User@X.com', name: 'Old', status: 'active', createdAt: '2025-01-01' });
    tables.trading_accounts.push({ id: 'a3', userId: 'u-3', login: '70000001', status: 'Active', deliveryStatus: 'delivered', createdAt: '2025-02-01' });
    expect((await req('account_status', { verifiedEmail: 'old.user@x.com' })).record.text).toContain('70000001');
    tables.users.push({ id: 'u-4', email: 'axb@x.com', name: 'Other', status: 'active', createdAt: '2025-01-01' });
    expect((await req('account_status', { verifiedEmail: 'a_b@x.com' })).record.found).toBe(false);
  });

  it('account status counts every account and lists failed reasons and recent orders', async () => {
    const r = JSON.parse((await req('account_status')).record.text).record;
    expect(r.summary).toEqual({ total_accounts: 1, by_status: { Failed: 1 }, credentials_not_delivered: 0 });
    expect(r.accounts[0]).toMatchObject({ login: '50012345', status: 'Failed', failed_reason: { title: 'Daily drawdown' } });
    expect(r.recent_orders[0]).toMatchObject({ order_id: 'o-1', plan: 'Two Step 10000' });
  });

  it('without the code, an order id (any case) or a login finds the trader with no email', async () => {
    const byOrder = JSON.parse((await req('order_status', { verifiedEmail: null, hints: { order_id: 'O-1' }, findByIds: true })).record.text).record;
    expect(byOrder).toMatchObject({ found_by: 'order O-1', orders: [{ order_id: 'o-1' }] });
    const byLogin = JSON.parse((await req('account_status', { verifiedEmail: null, hints: { account_login: '50012345' }, findByIds: true })).record.text).record;
    expect(byLogin.found_by).toBe('account login 50012345');
    expect(byLogin.accounts[0].login).toBe('50012345');
  });

  it('with the code, an order id never finds another trader', async () => {
    const r = await req('order_status', { verifiedEmail: 'sara@x.com', hints: { order_id: 'o-1' }, findByIds: false });
    expect(r.record.found).toBe(false);
  });

  it('an unknown order id says what was tried', async () => {
    const r = await req('order_status', { verifiedEmail: null, hints: { order_id: 'o-999' }, findByIds: true });
    expect(r.record).toMatchObject({ found: false, text: expect.stringContaining('order o-999') });
  });

  it('an email with no user is not found', async () => {
    expect((await req('kyc_status', { verifiedEmail: 'nobody@x.com' })).record.found).toBe(false);
  });

  it('kyc, orders and affiliate numbers, without documents or plan secrets', async () => {
    const kyc = (await req('kyc_status')).record.text;
    expect(kyc).toContain('Blurry photo');
    expect(kyc).not.toContain('https://doc');
    const orders = (await req('order_status')).record.text;
    expect(orders).toContain('Two Step 10000');
    expect(orders).toContain('delivered');
    expect(orders).not.toContain('SECRET');
    const aff = JSON.parse((await req('affiliate_stats')).record.text).record;
    expect(aff).toMatchObject({ referred_sales: 2, commission: { pending: 9.9, approved: 0, paid: 20 }, affiliate: { referral_code: 'ALI10' } });
    for (const q of queries) expect(q.columns, q.table).not.toMatch(FORBIDDEN);
  });

  it('a coupon is checked by code alone, upper-cased, and an old expiry reads as expired', async () => {
    const { record } = await req('coupon_check', { verifiedEmail: null, hints: { coupon_code: 'save20' } });
    expect(JSON.parse(record.text).record).toMatchObject({ code: 'SAVE20', status: 'expired' });
    expect(queries.some((q) => q.table === 'users')).toBe(false);
  });

  it('a personal lookup without a verified email is refused', async () => {
    await expect(req('order_status', { verifiedEmail: null })).rejects.toThrow(/needs an email/);
  });
});

describe('connection checks', () => {
  const jwt = (role: string) => `x.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.y`;
  it('only a service_role key is accepted', () => {
    expect(checkServiceRoleKey(jwt('service_role')).ok).toBe(true);
    expect(checkServiceRoleKey('sb_secret_abc').ok).toBe(true);
    expect(checkServiceRoleKey(jwt('anon'))).toMatchObject({ ok: false, reason: expect.stringContaining('anon') });
    expect(checkServiceRoleKey('sb_publishable_abc').ok).toBe(false);
    expect(checkServiceRoleKey('hello').ok).toBe(false);
  });

  it('the project URL must be public https', () => {
    expect(checkSupabaseUrl('https://abcd.supabase.co/rest/v1')).toEqual({ ok: true, url: 'https://abcd.supabase.co' });
    expect(checkSupabaseUrl('http://abcd.supabase.co').ok).toBe(false);
    expect(checkSupabaseUrl('https://localhost:54321').ok).toBe(false);
  });

  it('the breach reason is read whatever the compliance key is called', () => {
    expect(breachReason({ _range4exCompliance: { breachReason: { title: 'T', message: 'M' } } })).toMatchObject({ title: 'T', message: 'M' });
    expect(breachReason({ other: 1 })).toBeNull();
  });
});

describe('dashboardOf and the exact breach reason', () => {
  const payload = {
    statistics: {
      account_stats: { balance: 9480.123, equity: 9480, profit: -520, drawdown_percent: 5.2, trading_days: 3, best_day_date: '2026-10-14', best_day_profit: 120 },
      advanced_statistics: { total_trades: 12, win_rate: 41.67, profit_factor: 0.8, avg_win: { profit: 60 }, avg_loss: { profit: -80 }, best_trade_profit: { date: '2026-10-14', value: 90 } },
      monthly_yearly_performance: { period_returns: { today: { profit: -520, trades_count: 4, win_rate: 0 } } },
      equity_curve: { daily_performance: Array.from({ length: 10 }, (_, i) => ({ date: `2026-10-0${i}`, cumulative_balance: 10000 - i, cumulative_profit: -i, drawdown: i, trades_count: 1 })) },
      by_symbol: { EURUSD: { trades: 8, profit: -300, won_percentage: 37.5 }, XAUUSD: { trades: 4, profit: -220, won_percentage: 50 } },
    },
    open_trades: { count: 0 },
    _range4exCompliance: { breachReason: { id: 'daily-drawdown-breach', title: 'Daily drawdown breached', message: 'Lost 5.2% on 16 Oct', recordedAt: '2026-10-16T14:02:00Z' } },
  };

  it('summarises the dashboard with exact figures and the last 7 days', () => {
    const d = dashboardOf(payload, '2026-10-17T10:00:00Z')!;
    expect(d).toMatchObject({ balance: 9480.12, drawdown_percent: 5.2, trading_days: 3, total_trades: 12, win_rate: 41.67, avg_loss: -80, best_day: { date: '2026-10-14', profit: 120 }, today: { profit: -520, trades: 4 }, open_trades: 0, stats_updated_at: '2026-10-17T10:00:00Z' });
    expect((d.last_days as unknown[]).length).toBe(7);
    expect((d.top_symbols as { symbol: string }[])[0].symbol).toBe('EURUSD');
    expect(dashboardOf({ id: 'x' })).toBeNull();
  });

  it('keeps the rule id, title and message as written', () => {
    expect(breachReason(payload)).toEqual({ rule: 'daily-drawdown-breach', title: 'Daily drawdown breached', message: 'Lost 5.2% on 16 Oct', recorded_at: '2026-10-16T14:02:00Z' });
  });
});
