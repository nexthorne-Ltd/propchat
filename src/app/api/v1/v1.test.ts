/* eslint-disable @typescript-eslint/no-explicit-any -- an untyped in-memory stand-in for the Supabase client */
/**
 * The public chat API (/api/v1), run against an in-memory database: keys,
 * workspace isolation, validation, and the bot reply coming back in the
 * response. The auto-respond route is faked; its own rules are covered by
 * src/app/api/ai/auto-respond/route.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, clock: 0 }));

function field(row: Row, col: string): unknown {
  const [base, key] = col.split('->>');
  const value = row[base.trim()];
  return key ? (value as Row | null)?.[key.trim()] : value;
}

function insertRow(table: string, row: Row): Row {
  db.clock += 1000;
  const stored = { id: crypto.randomUUID(), created_at: new Date(Date.parse('2026-10-12T10:00:00Z') + db.clock).toISOString(), ...row };
  (db.tables[table] ||= []).push(stored);
  return stored;
}

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: 'select' | 'update' | 'insert' = 'select';
  let payload: Row | null = null;
  let order: [string, boolean] | null = null;
  let limit: number | null = null;
  const run = (): { data: any; error: any } => {
    if (op === 'insert') return { data: [insertRow(table, payload!)], error: null };
    let rows = (db.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    if (op === 'update') {
      for (const r of rows) Object.assign(r, payload);
      return { data: rows, error: null };
    }
    if (order) {
      const [col, asc] = order;
      rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : 1) * (asc ? 1 : -1));
    }
    if (limit != null) rows = rows.slice(0, limit);
    return { data: rows.map((r) => ({ ...r })), error: null };
  };
  const builder: any = {
    select: () => builder,
    eq: (col: string, v: unknown) => (filters.push((r) => field(r, col) === v), builder),
    is: (col: string, v: unknown) => (filters.push((r) => (field(r, col) ?? null) === v), builder),
    gt: (col: string, v: string) => (filters.push((r) => String(field(r, col)) > v), builder),
    order: (col: string, opts: { ascending: boolean }) => ((order = [col, opts.ascending]), builder),
    limit: (n: number) => ((limit = n), builder),
    update: (patch: Row) => ((op = 'update'), (payload = patch), builder),
    insert: (row: Row) => ((op = 'insert'), (payload = row), builder),
    single: async () => {
      const { data } = run();
      return data?.length ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116' } };
    },
    maybeSingle: async () => ({ data: run().data?.[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({ from: query }), hasServiceRole: () => true }));

const plan = vi.hoisted(() => ({ limitOk: true }));
vi.mock('@/lib/plans/enforce', () => ({
  checkWorkspaceLimit: async () => ({ allowed: plan.limitOk, upgradeMessage: 'API limit reached' }),
  incrementWorkspaceUsage: async () => {},
}));

/** Stands in for the auto-respond route: answers like the bot, plus an internal note. */
const bot = vi.hoisted(() => ({ calls: [] as Row[] }));
vi.mock('@/app/api/ai/auto-respond/route', () => ({
  POST: async (req: Request) => {
    const body = await req.json();
    bot.calls.push(body);
    insertRow('messages', { conversation_id: body.conversation_id, sender_type: 'ai', sender_id: null, content: 'You can reset it from the login page.', is_internal: false, reply_to_message_id: body.message_id, metadata: {} });
    insertRow('messages', { conversation_id: body.conversation_id, sender_type: 'ai', sender_id: null, content: 'INTERNAL: visitor asked about password', is_internal: true, metadata: {} });
    return new Response(JSON.stringify({ replied: true }), { status: 200 });
  },
}));

import { generateApiKey, hashApiKey } from '@/lib/api/keys';
import { POST as createConversation } from '@/app/api/v1/conversations/route';
import { GET as getConversation } from '@/app/api/v1/conversations/[id]/route';
import { GET as listMessages, POST as sendMessage } from '@/app/api/v1/conversations/[id]/messages/route';

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
let KEY = '';
let OTHER_KEY = '';

function addKey(workspaceId: string, opts: { revoked?: boolean } = {}) {
  const k = generateApiKey();
  insertRow('workspace_api_keys', { workspace_id: workspaceId, name: 'test', key_prefix: k.prefix, key_hash: k.hash, revoked_at: opts.revoked ? new Date().toISOString() : null, last_used_at: null });
  return k.key;
}

beforeEach(() => {
  db.tables = { workspace_api_keys: [], visitors: [], conversations: [], messages: [] };
  db.clock = 0;
  bot.calls = [];
  plan.limitOk = true;
  KEY = addKey(WS);
  OTHER_KEY = addKey(OTHER_WS);
});

const req = (url: string, init: { method?: string; key?: string | null; body?: unknown } = {}) =>
  new Request(`https://app.test${url}`, {
    method: init.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(init.key === null ? {} : { Authorization: `Bearer ${init.key ?? KEY}` }),
    },
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function start(body: Row = { visitor: { external_id: 'user-42', name: 'Sara' }, message: 'How do I reset my password?' }, key?: string) {
  const res = await createConversation(req('/api/v1/conversations', { method: 'POST', body, key }));
  return { status: res.status, body: (await res.json()) as Row };
}

describe('keys', () => {
  it('are random, prefixed, and stored only as a hash', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).toMatch(/^zk_live_[A-Za-z0-9_-]{43}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.hash).toBe(hashApiKey(a.key));
    expect(a.hash).not.toContain(a.key.slice(8));
    expect(db.tables.workspace_api_keys.some((k) => JSON.stringify(k).includes(KEY))).toBe(false);
  });

  it.each([
    ['no key', null],
    ['a malformed key', 'not-a-key'],
    ['an unknown key', generateApiKey().key],
  ])('rejects %s with 401', async (_label, key) => {
    const { status, body } = await start(undefined, key as any);
    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
    expect(db.tables.conversations).toHaveLength(0);
  });

  it('rejects a revoked key', async () => {
    const revoked = addKey(WS, { revoked: true });
    expect((await start(undefined, revoked)).status).toBe(401);
  });

  it('returns 429 when the plan API limit is used up', async () => {
    plan.limitOk = false;
    const { status, body } = await start();
    expect(status).toBe(429);
    expect(body.error.code).toBe('plan_limit_reached');
  });
});

describe('starting a conversation', () => {
  it('creates the visitor and conversation, and returns the bot reply without internal notes', async () => {
    const { status, body } = await start();
    expect(status).toBe(201);
    expect(body.conversation).toMatchObject({ status: 'open', answered_by: 'bot' });
    expect(body.message).toMatchObject({ role: 'customer', content: 'How do I reset my password?' });
    expect(body.replies).toEqual([expect.objectContaining({ role: 'bot', content: 'You can reset it from the login page.' })]);
    expect(JSON.stringify(body)).not.toContain('INTERNAL');

    const conv = db.tables.conversations[0];
    expect(conv).toMatchObject({ workspace_id: WS, ai_mode: 'autopilot' });
    expect(conv.channel_metadata).toMatchObject({ source: 'api' });
    expect(bot.calls[0]).toMatchObject({ conversation_id: conv.id, workspace_id: WS });
  });

  it('finds the same visitor again by external_id', async () => {
    const first = await start();
    const second = await start({ visitor: { external_id: 'user-42' }, message: 'hi again' });
    expect(second.body.visitor_id).toBe(first.body.visitor_id);
    expect(db.tables.visitors).toHaveLength(1);
  });

  it('can start without a message', async () => {
    const { status, body } = await start({ visitor: { name: 'Sara' } });
    expect(status).toBe(201);
    expect(body.message).toBeNull();
    expect(bot.calls).toHaveLength(0);
  });

  it.each([
    ['invalid JSON', '{not json', 'invalid_json'],
    ['an empty message', { message: '   ' }, 'invalid_content'],
    ['a message that is too long', { message: 'x'.repeat(4001) }, 'content_too_long'],
    ['a bad email', { visitor: { email: 'nope' }, message: 'hi' }, 'invalid_field'],
  ])('rejects %s with 400', async (_label, body, code) => {
    const res = await createConversation(req('/api/v1/conversations', { method: 'POST', body }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Row).error.code).toBe(code);
  });
});

describe('sending and reading messages', () => {
  it('sends the next message and returns the reply', async () => {
    const { body: started } = await start();
    const id = started.conversation.id;
    const res = await sendMessage(req(`/api/v1/conversations/${id}/messages`, { method: 'POST', body: { content: 'thanks' } }), ctx(id));
    const body = (await res.json()) as Row;
    expect(res.status).toBe(201);
    expect(body.message.content).toBe('thanks');
    expect(body.replies.map((m: Row) => m.role)).toEqual(['bot']);
  });

  it('does not wait for the bot when asked not to', async () => {
    const { body: started } = await start({ visitor: {} });
    const id = started.conversation.id;
    const res = await sendMessage(req(`/api/v1/conversations/${id}/messages`, { method: 'POST', body: { content: 'hello', wait_for_reply: false } }), ctx(id));
    const body = (await res.json()) as Row;
    expect(body.replies).toEqual([]);
    expect(body.bot.reason).toBe('not_waited');
  });

  it('lists messages after a cursor, shows agents as agents, and hides internal notes', async () => {
    const { body: started } = await start();
    const id = started.conversation.id;
    insertRow('messages', { conversation_id: id, sender_type: 'agent', sender_id: 'agent-1', content: 'Hi Sara, I am Ali from support.', is_internal: false, metadata: {} });
    insertRow('messages', { conversation_id: id, sender_type: 'agent', sender_id: 'agent-1', content: 'note: VIP', is_internal: true, metadata: {} });

    const all = (await (await listMessages(req(`/api/v1/conversations/${id}/messages`), ctx(id))).json()) as Row;
    expect(all.messages.map((m: Row) => m.role)).toEqual(['customer', 'bot', 'agent']);
    expect(JSON.stringify(all)).not.toContain('note: VIP');

    const lastSeen = all.messages[1].id;
    const newer = (await (await listMessages(req(`/api/v1/conversations/${id}/messages?after=${lastSeen}`), ctx(id))).json()) as Row;
    expect(newer.messages.map((m: Row) => m.content)).toEqual(['Hi Sara, I am Ali from support.']);
  });

  it('reports when the team has taken over', async () => {
    const { body: started } = await start();
    const id = started.conversation.id;
    Object.assign(db.tables.conversations[0], { ai_mode: 'disabled', ai_paused_reason: 'human_reply' });
    const body = (await (await getConversation(req(`/api/v1/conversations/${id}`), ctx(id))).json()) as Row;
    expect(body.conversation).toMatchObject({ answered_by: 'team', ai_paused_reason: 'human_reply' });
  });
});

describe('isolation', () => {
  it("another workspace's key cannot read or write the conversation", async () => {
    const { body: started } = await start();
    const id = started.conversation.id;
    const read = await listMessages(req(`/api/v1/conversations/${id}/messages`, { key: OTHER_KEY }), ctx(id));
    const write = await sendMessage(req(`/api/v1/conversations/${id}/messages`, { method: 'POST', key: OTHER_KEY, body: { content: 'hi' } }), ctx(id));
    const status = await getConversation(req(`/api/v1/conversations/${id}`, { key: OTHER_KEY }), ctx(id));
    expect([read.status, write.status, status.status]).toEqual([404, 404, 404]);
    expect(db.tables.messages.filter((m) => m.content === 'hi')).toHaveLength(0);
  });

  it("the workspace's own key cannot reach chats that did not start through the API", async () => {
    const widgetChat = insertRow('conversations', { workspace_id: WS, visitor_id: 'v', status: 'open', ai_mode: 'autopilot', channel_metadata: {} });
    insertRow('messages', { conversation_id: widgetChat.id, sender_type: 'visitor', content: 'private widget chat', is_internal: false, metadata: {} });
    const res = await listMessages(req(`/api/v1/conversations/${widgetChat.id}/messages`), ctx(widgetChat.id));
    expect(res.status).toBe(404);
  });

  it('rejects a cursor from another conversation', async () => {
    const a = (await start()).body.conversation.id;
    const b = await start({ visitor: { external_id: 'user-7' }, message: 'other' });
    const foreign = b.body.message.id;
    const res = await listMessages(req(`/api/v1/conversations/${a}/messages?after=${foreign}`), ctx(a));
    expect(res.status).toBe(400);
  });
});
