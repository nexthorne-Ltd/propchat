import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The verification and lookup flow, with the database, email and endpoint
 * faked: a lookup question asks for the email, the email gets a code, a
 * wrong code is refused, the right one fetches the record for that email and
 * answers the first question; nothing is looked up without a connection.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const sent: { to: string; text: string }[] = [];
const calls: Record<string, unknown>[] = [];
let smtpReady = true;
let endpoint: (body: Record<string, unknown>) => Response = () => Response.json({ found: true, record: { status: 'breached', breach_reason: 'Daily loss limit' } });

function table(name: string) {
  db[name] ||= [];
  const filters: [string, unknown][] = [];
  const q = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return q;
    },
    // A copy, like a real query: later writes must not change what was read.
    maybeSingle: async () => {
      const found = db[name].find((r) => filters.every(([c, v]) => r[c] === v));
      return { data: found ? { ...found } : null, error: null };
    },
    upsert: async (row: Row, opts: { onConflict: string }) => {
      const key = opts.onConflict;
      const existing = db[name].find((r) => r[key] === row[key]);
      if (existing) Object.assign(existing, row);
      else db[name].push({ ...row });
      return { error: null };
    },
    insert: async () => ({ error: null }),
  };
  return q;
}

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({ from: table, rpc: async () => ({ data: true, error: null }) }) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: async () => true }));
vi.mock('@/lib/email/workspace-smtp', () => ({ loadTeamAlertSmtp: async () => (smtpReady ? { smtp: { host: 'smtp' }, source: 'workspace' } : null) }));
vi.mock('@/lib/email/smtp', () => ({
  sendSmtpEmail: async (_c: unknown, o: { to: string; text: string }) => {
    sent.push({ to: o.to, text: o.text });
    return { success: true };
  },
}));
vi.mock('@/lib/ai/bot-control', () => ({ logAiEvent: async () => {} }));

process.env.CHANNEL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { prepareTraderLookup, MAX_CODE_ATTEMPTS } = await import('./lookup');
const { encryptSecret } = await import('@/lib/channels/crypto');

const WS = 'ws-1';
const CONV = 'conv-1';
const ask = (message: string, routedAgent: Parameters<typeof prepareTraderLookup>[0]['routedAgent'] = 'general') =>
  prepareTraderLookup({ workspaceId: WS, conversationId: CONV, message, routedAgent, enabled: () => true, lang: 'en', brand: 'Acme' });
const lastCode = () => sent.at(-1)!.text.match(/\b(\d{6})\b/)![1];

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  sent.length = 0;
  calls.length = 0;
  smtpReady = true;
  db.trader_data_connections = [
    // The code-mode suite below; the no-code suite switches require_code off.
    { workspace_id: WS, enabled: true, kind: 'http', url: 'https://api.firm.example.com/lookup', secret_encrypted: encryptSecret('k'), require_code: true },
  ];
  db.workspaces = [{ id: WS, name: 'Acme Funding' }];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body);
    calls.push({ ...body, auth: init.headers.Authorization });
    return endpoint(body);
  });
});

describe('prepareTraderLookup with the email code switched on', () => {
  it('without a connection nothing changes', async () => {
    db.trader_data_connections = [];
    expect(await ask('mera account breach kyun hua?', 'account_status')).toEqual({ kind: 'none' });
    expect(calls).toHaveLength(0);
  });

  it('asks for the email, sends a code, refuses a wrong one, and answers the first question with the record', async () => {
    const first = await ask('mera account breach kyun hua?', 'account_status');
    expect(first).toMatchObject({ kind: 'reply', subAgent: 'account_status' });
    expect(calls).toHaveLength(0);

    // The router makes nothing of an email; the verification takes it.
    const second = await ask('ali.khan@gmail.com');
    expect(second).toMatchObject({ kind: 'reply' });
    expect((second as { text: string }).text).toMatch(/al•+@gmail.com/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ali.khan@gmail.com');
    // Only a hash is stored.
    const row = db.trader_identity_verifications[0];
    expect(row.code_hash).not.toContain(lastCode());
    expect(JSON.stringify(row)).not.toContain(`"${lastCode()}"`);

    const wrong = lastCode() === '111111' ? '222222' : '111111';
    expect(await ask(wrong)).toMatchObject({ kind: 'reply', text: expect.stringContaining(`${MAX_CODE_ATTEMPTS - 1} tries left`) });
    expect(calls).toHaveLength(0);

    const done = await ask(lastCode());
    expect(done).toMatchObject({
      kind: 'answer',
      subAgent: 'account_status',
      question: 'mera account breach kyun hua?',
      verifiedEmail: 'ali.khan@gmail.com',
      justVerified: true,
      record: { found: true },
    });
    expect(calls).toEqual([
      expect.objectContaining({ action: 'account_status', email: 'ali.khan@gmail.com', email_verified: true, auth: 'Bearer k' }),
    ]);

    // Verified: the next lookup in the conversation goes straight through.
    expect(await ask('aur mera kyc status?', 'kyc_status')).toMatchObject({ kind: 'answer', subAgent: 'kyc_status', justVerified: false });
    expect(calls.at(-1)).toMatchObject({ action: 'kyc_status', email: 'ali.khan@gmail.com' });
  });

  it('an email typed with the question is used for the code, never for the lookup itself', async () => {
    const r = await ask('my order with ali@x.com, paid but account nahi mila', 'order_lookup');
    expect(r).toMatchObject({ kind: 'reply' });
    expect(sent[0].to).toBe('ali@x.com');
    expect(calls).toHaveLength(0);
  });

  it('too many wrong codes hand over, and the code stops working', async () => {
    await ask('kyc status kya hai', 'kyc_status');
    await ask('ali@x.com');
    const right = lastCode();
    const wrong = right === '111111' ? '222222' : '111111';
    let r;
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) r = await ask(wrong);
    expect(r).toMatchObject({ kind: 'reply', handover: expect.any(String) });
    expect(await ask(right)).not.toMatchObject({ kind: 'answer' });
    expect(calls).toHaveLength(0);
  });

  it('a coupon check needs no identity and sends no email', async () => {
    const r = await ask('SAVE20 code apply nahi ho raha', 'coupon_check');
    expect(r).toMatchObject({ kind: 'answer', subAgent: 'coupon_check', verifiedEmail: null });
    expect(calls[0]).toMatchObject({ action: 'coupon_check', email: null, coupon_code: 'SAVE20' });
    expect(sent).toHaveLength(0);
  });

  it('a failing endpoint answers without the record', async () => {
    endpoint = () => new Response('boom', { status: 500 });
    const r = await ask('SAVE20 code invalid', 'coupon_check');
    expect(r).toMatchObject({ kind: 'answer', record: null });
    endpoint = () => Response.json({ found: true, record: { status: 'breached' } });
  });

  it('without a way to email a code, nothing personal is looked up', async () => {
    smtpReady = false;
    await ask('mera account breach kyun hua?', 'account_status');
    expect(await ask('ali@x.com')).toEqual({ kind: 'none' });
    expect(calls).toHaveLength(0);
  });

  it('a specialist the workspace switched off is not looked up', async () => {
    const r = await prepareTraderLookup({
      workspaceId: WS,
      conversationId: CONV,
      message: 'mera account breach kyun hua?',
      routedAgent: 'account_status',
      enabled: () => false,
      lang: 'en',
      brand: 'Acme',
    });
    expect(r).toEqual({ kind: 'none' });
  });
});

describe('prepareTraderLookup without the code (the default)', () => {
  beforeEach(() => {
    db.trader_data_connections[0].require_code = false;
    db.conversations = [{ id: CONV, workspace_id: WS, visitor: { email: null } }];
  });

  it('asks only for the email, sends no code, then answers the first question for that email', async () => {
    const first = await ask('mere kitne accounts hain aur kaun sa fail hua?', 'account_status');
    expect(first).toMatchObject({ kind: 'reply', text: expect.stringContaining('email') });
    expect(first).not.toMatchObject({ text: expect.stringContaining('code') });
    expect(calls).toHaveLength(0);

    const r = await ask('ravi@example.com');
    expect(r).toMatchObject({ kind: 'answer', subAgent: 'account_status', question: 'mere kitne accounts hain aur kaun sa fail hua?', verifiedEmail: 'ravi@example.com' });
    expect(calls[0]).toMatchObject({ action: 'account_status', email: 'ravi@example.com' });
    expect(sent).toHaveLength(0);

    // Remembered for the conversation: no email asked again.
    expect(await ask('aur mera order?', 'order_lookup')).toMatchObject({ kind: 'answer', verifiedEmail: 'ravi@example.com' });
  });

  it('an email in the question is used at once, and a new one replaces the old', async () => {
    expect(await ask('ravi@example.com ke accounts check karo', 'account_status')).toMatchObject({ kind: 'answer', verifiedEmail: 'ravi@example.com' });
    expect(await ask('sorry, asif@example.com pe check karo', 'account_status')).toMatchObject({ kind: 'answer', verifiedEmail: 'asif@example.com' });
    expect(calls.at(-1)).toMatchObject({ email: 'asif@example.com' });
  });

  it('the pre-chat email is used without asking', async () => {
    db.conversations = [{ id: CONV, workspace_id: WS, visitor: { email: 'Pre.Chat@Example.com' } }];
    expect(await ask('mera account status?', 'account_status')).toMatchObject({ kind: 'answer', verifiedEmail: 'pre.chat@example.com' });
  });

  it('works without SMTP: nothing is emailed in this mode', async () => {
    smtpReady = false;
    expect(await ask('ravi@example.com mera account', 'account_status')).toMatchObject({ kind: 'answer' });
  });
});
