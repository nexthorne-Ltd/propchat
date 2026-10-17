/* eslint-disable @typescript-eslint/no-explicit-any -- an untyped in-memory stand-in for the Supabase client */
/**
 * The routes the widget and tracker.js call from customers' sites
 * (/api/tracking, /api/visitor/geo, /api/csat/rate) act for one visitor, so
 * they need that visitor's session token (docs/AUDIT.md H-3): a visitor or
 * conversation id alone must change nothing. Supabase is an in-memory
 * stand-in whose fn_widget_auth / fn_widget_session behave like the SQL
 * (widget-session.db.test.ts covers the SQL itself).
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  sessions: new Map<string, { token: string; workspace_id: string }>(),
}));

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: 'select' | 'update' | 'insert' = 'select';
  let payload: Row | null = null;
  const run = () => {
    if (op === 'insert') {
      (db.tables[table] ||= []).push({ ...payload });
      return { data: [payload], error: null };
    }
    const rows = (db.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    if (op === 'update') rows.forEach((r) => Object.assign(r, payload));
    return { data: rows, error: null };
  };
  const builder: any = {
    select: () => builder,
    eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), builder),
    lt: (col: string, v: string) => (filters.push((r) => String(r[col]) < v), builder),
    order: () => builder,
    limit: () => builder,
    update: (patch: Row) => ((op = 'update'), (payload = patch), builder),
    insert: (row: Row) => ((op = 'insert'), (payload = row), builder),
    maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}

async function rpc(fn: string, args: Row) {
  if (fn === 'fn_rate_limit') {
    return { data: true, error: null };
  }
  if (fn === 'fn_widget_auth') {
    const s = db.sessions.get(args.p_visitor_id);
    if (!s || s.token !== args.p_token) return { data: null, error: { message: 'visitor_session_invalid' } };
    return { data: { visitor_id: args.p_visitor_id, workspace_id: s.workspace_id }, error: null };
  }
  if (fn === 'fn_widget_session') {
    const s = db.sessions.get(args.p_visitor_id);
    if (!s) {
      const token = 'a'.repeat(63) + String(db.sessions.size % 10);
      db.sessions.set(args.p_visitor_id, { token, workspace_id: args.p_workspace_id });
      (db.tables.visitors ||= []).push({ id: args.p_visitor_id, workspace_id: args.p_workspace_id });
      return { data: { token }, error: null };
    }
    if (s.token !== args.p_token || s.workspace_id !== args.p_workspace_id) {
      return { data: null, error: { message: 'visitor_session_invalid' } };
    }
    return { data: { token: null }, error: null };
  }
  throw new Error(`unexpected rpc ${fn}`);
}

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({ from: query, rpc }) }));
vi.mock('@/lib/geo', () => ({
  geoFromRequest: async () => ({ city: 'Lahore', country: 'Pakistan', countryCode: 'PK' }),
  clientIpOf: () => '203.0.113.9',
}));
vi.mock('@/lib/csat/token', () => ({ verifyCsatToken: (_t: string, _w: string, token: string) => token === 'signed' }));

import { POST as tracking } from './route';
import { POST as geo } from '../visitor/geo/route';
import { POST as csat } from '../csat/rate/route';

const WS = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';
const MALLORY = '33333333-3333-4333-8333-333333333333';
const ALICE_TOKEN = 'b'.repeat(64);
const MALLORY_TOKEN = 'c'.repeat(64);

const post = (handler: (r: NextRequest) => Promise<Response>, body: unknown) =>
  handler(new NextRequest('http://localhost/api/x', { method: 'POST', body: JSON.stringify(body) }));
const visitor = (id: string) => db.tables.visitors.find((v) => v.id === id)!;

beforeEach(() => {
  db.sessions.clear();
  db.sessions.set(ALICE, { token: ALICE_TOKEN, workspace_id: WS });
  db.sessions.set(MALLORY, { token: MALLORY_TOKEN, workspace_id: WS });
  db.tables = {
    visitors: [
      { id: ALICE, workspace_id: WS, is_online: true, current_page_url: '/home' },
      { id: MALLORY, workspace_id: WS, is_online: true },
    ],
    visitor_page_history: [],
    conversations: [{ id: 'conv-alice', visitor_id: ALICE, current_ticket_id: 'ticket-alice' }],
    tickets: [{ id: 'ticket-alice', workspace_id: WS, conversation_id: 'conv-alice', tags: [] }],
    reporting_events: [],
  };
});

describe('/api/tracking', () => {
  it("ignores another visitor's id without their token", async () => {
    for (const body of [
      { event: 'offline', visitor_id: ALICE },
      { event: 'offline', visitor_id: ALICE, visitor_token: MALLORY_TOKEN },
      { event: 'heartbeat', visitor_id: ALICE, visitor_token: 'nope', current_page_url: 'https://evil.test' },
      { event: 'pageview', visitor_id: ALICE, url: 'https://evil.test' },
    ]) {
      expect((await post(tracking, body)).status).toBe(401);
    }
    expect(visitor(ALICE)).toMatchObject({ is_online: true, current_page_url: '/home' });
    expect(db.tables.visitor_page_history).toHaveLength(0);
  });

  it("works with the visitor's own token, filing pages under the session workspace", async () => {
    const res = await post(tracking, {
      event: 'pageview',
      visitor_id: ALICE,
      visitor_token: ALICE_TOKEN,
      url: 'https://shop.test/p',
      workspace_id: '99999999-9999-4999-8999-999999999999',
    });
    expect(res.status).toBe(200);
    expect(db.tables.visitor_page_history).toEqual([expect.objectContaining({ visitor_id: ALICE, workspace_id: WS, url: 'https://shop.test/p' })]);
    expect((await post(tracking, { event: 'offline', visitor_id: ALICE, visitor_token: ALICE_TOKEN })).status).toBe(200);
    expect(visitor(ALICE).is_online).toBe(false);
  });

  it('init issues a token to a new visitor, and refuses an id someone else holds', async () => {
    const fresh = '44444444-4444-4444-8444-444444444444';
    const res = await post(tracking, { event: 'init', visitor_id: fresh, workspace_id: WS, current_page_url: 'https://shop.test/' });
    expect(res.status).toBe(200);
    expect((await res.json()).visitor_token).toMatch(/^[0-9a-f]{64}$/);
    expect(visitor(fresh)).toMatchObject({ workspace_id: WS, ip_location_city: 'Lahore' });

    const stolen = await post(tracking, { event: 'init', visitor_id: ALICE, workspace_id: WS });
    expect(stolen.status).toBe(401);
    expect(await post(tracking, { event: 'init', visitor_id: fresh }).then((r) => r.status)).toBe(400);
  });
});

describe('/api/visitor/geo', () => {
  it("only locates the visitor whose token it is", async () => {
    expect((await post(geo, { visitor_id: ALICE })).status).toBe(401);
    expect((await post(geo, { visitor_id: ALICE, visitor_token: MALLORY_TOKEN })).status).toBe(401);
    expect(visitor(ALICE).ip_address).toBeUndefined();
    expect((await post(geo, { visitor_id: ALICE, visitor_token: ALICE_TOKEN })).status).toBe(200);
    expect(visitor(ALICE)).toMatchObject({ ip_address: '203.0.113.9', location: 'Lahore, Pakistan' });
  });
});

describe('/api/csat/rate', () => {
  it("the widget may rate only the visitor's own conversation", async () => {
    expect((await post(csat, { conversation_id: 'conv-alice', rating: 'bad' })).status).toBe(404);
    expect(
      (await post(csat, { conversation_id: 'conv-alice', rating: 'bad', visitor_id: MALLORY, visitor_token: MALLORY_TOKEN })).status
    ).toBe(404);
    expect(db.tables.tickets[0].csat_rating).toBeUndefined();

    const ok = await post(csat, { conversation_id: 'conv-alice', rating: 'good', visitor_id: ALICE, visitor_token: ALICE_TOKEN });
    expect(ok.status).toBe(200);
    expect(db.tables.tickets[0].csat_rating).toBe('good');
    expect(db.tables.conversations[0].csat_rating).toBe(5);
  });

  it('the emailed survey needs its signed token', async () => {
    expect((await post(csat, { ticket_id: 'ticket-alice', rating: 'bad' })).status).toBe(403);
    expect((await post(csat, { ticket_id: 'ticket-alice', rating: 'bad', token: 'forged' })).status).toBe(403);
    expect((await post(csat, { ticket_id: 'ticket-alice', rating: 'bad', token: 'signed' })).status).toBe(200);
    expect(db.tables.tickets[0].csat_rating).toBe('bad');
  });
});
