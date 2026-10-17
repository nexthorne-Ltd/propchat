/**
 * X, Threads, LinkedIn and TikTok adapters, with sample payloads: webhook
 * signatures and handshakes, parsing, polling (with the HTTP layer faked),
 * public and private replies, and the rules that keep public and private
 * apart. Nothing here calls a real platform.
 *
 * The sample payloads in each `fixtures/` folder follow the platforms'
 * published formats. X's, LinkedIn's and Threads' are checked against their
 * documentation; TikTok's comment event is a reconstruction (its business
 * events are only documented to approved developers) and must be compared
 * with a real delivery.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signMetaPayload } from './meta-signature';
import { audienceOf, authorOf, charCount, clip, isPublicSender, publicSender } from './public';
import { createOAuthState, pkceFor, readOAuthState } from './oauth-state';
import { SOCIAL_CHANNELS, SOCIAL_IDS, socialAccess } from './social-info';
import { classifyXError } from './x/api';
import { buildXReply, tweetEvent, xAdapter, type XCredentials } from './x/adapter';
import { parseXWebhook, signXPayload, verifyXSignature, xCrcResponse } from './x/webhook';
import { threadsAdapter } from './threads/adapter';
import { parseThreadsWebhook } from './threads/webhook';
import { buildLinkedInComment, commentEvent, linkedinAdapter } from './linkedin/adapter';
import { tiktokAdapter } from './tiktok/adapter';
import { parseTikTokWebhook, signTikTokPayload, verifyTikTokSignature } from './tiktok/webhook';
import type { ChannelContext, InboundMessageEvent } from './types';

const fixture = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(fixture(name));
const messages = (events: unknown[]) => events as InboundMessageEvent[];

/* ── A fake fetch that records requests and answers from a route table ── */

type Handler = (url: URL, init: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> };
let calls: { url: URL; init: RequestInit }[] = [];

function fakeFetch(routes: Record<string, Handler>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      const key = `${init.method || 'GET'} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) return new Response(JSON.stringify({ message: `no fake for ${key}` }), { status: 599 });
      const r = handler(url, init);
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
    })
  );
}

const ctx = <C>(credentials: C, over: Partial<ChannelContext<C>['connection']> = {}): ChannelContext<C> => ({
  connection: { id: 'conn-1', workspace_id: 'ws-1', external_account_id: '2244994945', external_business_id: null, settings: {}, ...over },
  credentials,
});

beforeEach(() => {
  process.env.CHANNEL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ── Public versus private ─────────────────────────────────────────────── */

describe('public and private senders', () => {
  it('marks public authors with a prefix that cannot be mistaken for a DM sender', () => {
    expect(publicSender('9001')).toBe('pub:9001');
    expect(isPublicSender('pub:9001')).toBe(true);
    expect(isPublicSender('9001')).toBe(false);
    expect(isPublicSender(null)).toBe(false);
    expect(authorOf('pub:9001')).toBe('9001');
    expect(authorOf('9001')).toBe('9001');
    expect(audienceOf('pub:abc')).toBe('public');
    expect(audienceOf('abc')).toBe('private');
  });

  it('counts and clips by characters, not UTF-16 units', () => {
    expect(charCount('héllo 👋')).toBe(7);
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 4)).toBe('abc');
    expect(Array.from(clip('👋👋👋👋', 3))).toHaveLength(3);
  });
});

/* ── Sign-in state ─────────────────────────────────────────────────────── */

describe('OAuth state', () => {
  it('round-trips, and carries what the flow needs back', () => {
    const state = createOAuthState('linkedin', { workspaceId: 'w', userId: 'u', extra: '12345678' });
    expect(readOAuthState('linkedin', state)).toMatchObject({ workspaceId: 'w', userId: 'u', extra: '12345678' });
  });

  it('rejects a forged, tampered, expired or wrong-channel state', () => {
    const state = createOAuthState('x', { workspaceId: 'w', userId: 'u' });
    const [body, sig] = state.split('.');
    expect(readOAuthState('threads', state)).toBeNull();
    expect(readOAuthState('x', `${body}.${sig.slice(0, -2)}AA`)).toBeNull();
    const evil = Buffer.from(JSON.stringify({ w: 'other', u: 'u', c: 'x', e: Date.now() + 1e6, n: 'n' })).toString('base64url');
    expect(readOAuthState('x', `${evil}.${sig}`)).toBeNull();
    expect(readOAuthState('x', createOAuthState('x', { workspaceId: 'w', userId: 'u' }, -1))).toBeNull();
    expect(readOAuthState('x', null)).toBeNull();
    expect(readOAuthState('x', 'garbage')).toBeNull();
  });

  it('derives a PKCE verifier only the server can recompute, with its S256 challenge', () => {
    const a = pkceFor('nonce-1');
    expect(pkceFor('nonce-1')).toEqual(a);
    expect(pkceFor('nonce-2').verifier).not.toBe(a.verifier);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'));
  });
});

/* ── What each channel is honest about ─────────────────────────────────── */

describe('channel facts and access', () => {
  it('describes every social channel with capabilities, requirements and steps', () => {
    for (const id of SOCIAL_IDS) {
      const info = SOCIAL_CHANNELS[id];
      expect(info.capabilities.length).toBeGreaterThan(2);
      expect(info.requirements.length).toBeGreaterThan(0);
      expect(info.steps.length).toBeGreaterThan(2);
      expect(info.docs.length).toBeGreaterThan(0);
    }
    // The headline limits are stated, not hidden.
    expect(SOCIAL_CHANNELS.threads.capabilities.find((c) => c.label === 'Direct messages')?.support).toBe('no');
    expect(SOCIAL_CHANNELS.linkedin.capabilities.find((c) => c.label === 'Direct messages')?.support).toBe('no');
    expect(SOCIAL_CHANNELS.x.requirements.join(' ')).toMatch(/paid X API plan/);
    expect(SOCIAL_CHANNELS.linkedin.requirements.join(' ')).toMatch(/Requires LinkedIn approval/);
  });

  it('shows approval-gated channels as requiring approval until the operator says it was granted', () => {
    expect(socialAccess('linkedin', {})).toEqual({ state: 'requires_approval', missing: ['LINKEDIN_APPROVED', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'] });
    expect(socialAccess('linkedin', { LINKEDIN_APPROVED: 'true' }).state).toBe('server_setup');
    expect(socialAccess('linkedin', { LINKEDIN_APPROVED: 'true', LINKEDIN_CLIENT_ID: 'a', LINKEDIN_CLIENT_SECRET: 'b' }).state).toBe('ready');
    expect(socialAccess('tiktok', { TIKTOK_CLIENT_SECRET: 'x' }).state).toBe('requires_approval');
    expect(socialAccess('tiktok', { TIKTOK_CLIENT_SECRET: 'x', TIKTOK_APPROVED: 'true' }).state).toBe('ready');
  });

  it('needs only the sign-in credentials for self-serve channels', () => {
    expect(socialAccess('x', {}).state).toBe('server_setup');
    expect(socialAccess('x', { X_CLIENT_ID: 'a', X_CLIENT_SECRET: 'b' }).state).toBe('ready');
    expect(socialAccess('threads', { THREADS_APP_ID: 'a', THREADS_APP_SECRET: 'b' }).state).toBe('ready');
  });
});

/* ── X ─────────────────────────────────────────────────────────────────── */

describe('X webhooks', () => {
  const secret = 'consumer-secret';

  it('answers the CRC check with the documented HMAC', () => {
    const answer = xCrcResponse(new URLSearchParams({ crc_token: 'challenge-123' }), secret)!;
    const expected = `sha256=${createHmac('sha256', secret).update('challenge-123').digest('base64')}`;
    expect(answer.contentType).toBe('application/json');
    expect(JSON.parse(answer.body)).toEqual({ response_token: expected });
    expect(xCrcResponse(new URLSearchParams(), secret)).toBeNull();
  });

  it('verifies the signature over the raw bytes, and nothing else', () => {
    const raw = fixture('x/fixtures/activity-dm-and-mentions.json');
    const sig = signXPayload(raw, secret);
    expect(sig).toMatch(/^sha256=[A-Za-z0-9+/]+=*$/);
    expect(verifyXSignature(raw, sig, secret)).toBe(true);
    expect(verifyXSignature(raw + ' ', sig, secret)).toBe(false);
    expect(verifyXSignature(raw, sig, 'other-secret')).toBe(false);
    expect(verifyXSignature(raw, null, secret)).toBe(false);
    expect(verifyXSignature(raw, 'sha256=', secret)).toBe(false);
    expect(verifyXSignature(raw, sig, '')).toBe(false);
    expect(xAdapter.verifyWebhookSignature({ rawBody: raw, headers: new Headers({ 'x-twitter-webhooks-signature': sig }) }, secret)).toBe(true);
    expect(xAdapter.verifyWebhookSignature({ rawBody: raw, headers: new Headers() }, secret)).toBe(false);
  });

  it('turns DMs, mentions and replies into events and skips echoes, retweets and strangers', () => {
    const events = messages(parseXWebhook(json('x/fixtures/activity-dm-and-mentions.json')));
    expect(events.map((e) => e.externalId)).toEqual(['x:dm:1904', 'x:tweet:7001', 'x:tweet:7002']);

    const [dm, mention, reply] = events;
    expect(dm).toMatchObject({ accountId: '2244994945', from: '9001', fromName: 'Dana Lee (@dana_lee)', type: 'dm', text: 'Hi, is my refund approved?' });
    expect(dm.public).toBeUndefined();
    expect(mention).toMatchObject({ from: 'pub:9002', type: 'mention', public: { kind: 'mention', itemId: '7001', permalink: 'https://x.com/sam_r/status/7001', handle: '@sam_r' } });
    expect(reply).toMatchObject({ from: 'pub:9003', type: 'reply', public: { kind: 'reply', itemId: '7002', parentId: '6999' } });
    expect(mention.sentAt.toISOString()).toBe('2025-10-12T09:00:00.000Z');
  });

  it('ignores payloads that are not for an account', () => {
    expect(parseXWebhook({})).toEqual([]);
    expect(parseXWebhook(null)).toEqual([]);
    expect(parseXWebhook({ for_user_id: '1', favorite_events: [{}] })).toEqual([]);
  });
});

describe('X errors', () => {
  it('says what to do about each failure', () => {
    expect(classifyXError(402, { title: 'CreditsDepleted' }, null)).toMatchObject({ needsAttention: true, retryable: false });
    expect(classifyXError(402, {}, null).error).toMatch(/credits have run out/);
    expect(classifyXError(401, { detail: 'Unauthorized' }, null)).toMatchObject({ needsAttention: true });
    expect(classifyXError(403, { detail: 'You are not allowed to reply' }, null)).toMatchObject({ needsAttention: false, retryable: false });
    expect(classifyXError(403, { type: 'https://api.x.com/2/problems/client-forbidden', detail: 'client-not-enrolled' }, null)).toMatchObject({ needsAttention: true });
    expect(classifyXError(429, {}, new Headers({ 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 600) }))).toMatchObject({ retryable: true });
    expect(classifyXError(503, {}, null).retryable).toBe(true);
    expect(classifyXError(null, { message: 'down' }, null).retryable).toBe(true);
  });
});

describe('X sending', () => {
  const creds: XCredentials = { accessToken: 'tok' };

  it('posts a public reply under the item, and a DM to the person', async () => {
    fakeFetch({
      'POST /2/tweets': () => ({ status: 201, body: { data: { id: '8001' } } }),
      'POST /2/dm_conversations/with/9001/messages': () => ({ status: 201, body: { data: { dm_event_id: '5501' } } }),
    });
    const target = { kind: 'mention' as const, itemId: '7001', rootId: '7001' };
    const pub = await xAdapter.sendMessage(ctx(creds), 'pub:9002', { type: 'text', text: 'Hi Sam, your order shipped.', publicTarget: target });
    expect(pub).toEqual({ ok: true, providerMessageId: 'x:tweet:8001' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual(buildXReply('Hi Sam, your order shipped.', '7001'));
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');

    const dm = await xAdapter.sendMessage(ctx(creds), '9001', { type: 'text', text: 'Your refund is approved.' });
    expect(dm).toEqual({ ok: true, providerMessageId: 'x:dm:5501' });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ text: 'Your refund is approved.' });
  });

  it('never sends a private message to a public sender, or the reverse', async () => {
    fakeFetch({});
    // A DM to "pub:9002" would go to user 9002 only if the prefix were not stripped: it is, and it is a DM path.
    await xAdapter.sendMessage(ctx(creds), 'pub:9002', { type: 'text', text: 'hello' }).catch(() => undefined);
    expect(calls[0].url.pathname).toBe('/2/dm_conversations/with/9002/messages');
    // And a public target always goes to /2/tweets, whatever the recipient looks like.
    fakeFetch({ 'POST /2/tweets': () => ({ status: 201, body: { data: { id: '1' } } }) });
    await xAdapter.sendMessage(ctx(creds), '9001', { type: 'text', text: 'hello', publicTarget: { kind: 'reply', itemId: '1' } });
    expect(calls[0].url.pathname).toBe('/2/tweets');
  });

  it('refuses an over-long public reply before calling X, counting characters', async () => {
    fakeFetch({});
    const r = await xAdapter.sendMessage(ctx(creds), 'pub:1', { type: 'text', text: '👋'.repeat(281), publicTarget: { kind: 'mention', itemId: '1' } });
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect((r as { error: string }).error).toMatch(/281 characters; X allows 280/);
    expect(calls).toHaveLength(0);
    const fits = await xAdapter.sendMessage(ctx(creds), 'pub:1', { type: 'text', text: '👋'.repeat(280), publicTarget: { kind: 'mention', itemId: '1' } });
    expect(fits.ok).toBe(false); // no fake route: it was attempted
    expect(calls).toHaveLength(1);
  });

  it('reports credits running out as a connection that needs an admin, not a retry', async () => {
    fakeFetch({ 'POST /2/tweets': () => ({ status: 402, body: { title: 'CreditsDepleted' } }) });
    const r = await xAdapter.sendMessage(ctx(creds), 'pub:1', { type: 'text', text: 'hi', publicTarget: { kind: 'mention', itemId: '1' } });
    expect(r).toMatchObject({ ok: false, retryable: false, needsAttention: true });
  });

  it('retries a rate limit later', async () => {
    fakeFetch({ 'POST /2/tweets': () => ({ status: 429, body: {} }) });
    const r = await xAdapter.sendMessage(ctx(creds), 'pub:1', { type: 'text', text: 'hi', publicTarget: { kind: 'mention', itemId: '1' } });
    expect(r).toMatchObject({ ok: false, retryable: true });
  });

  it('does not send files', async () => {
    expect(await xAdapter.sendMedia(ctx(creds), '1', { kind: 'image', url: 'https://x/y.png' })).toMatchObject({ ok: false, retryable: false });
  });
});

describe('X polling', () => {
  const creds: XCredentials = { accessToken: 'tok' };
  const mentionsBody = {
    data: [
      { id: '7002', text: '@acme thanks!', author_id: '9003', created_at: '2026-10-12T09:01:40.000Z', conversation_id: '6999', in_reply_to_user_id: '2244994945', referenced_tweets: [{ type: 'replied_to', id: '6999' }] },
      { id: '7001', text: '@acme still waiting', author_id: '9002', created_at: '2026-10-12T09:00:00.000Z', conversation_id: '7001' },
      { id: '7000', text: 'a self-mention', author_id: '2244994945', created_at: '2026-10-12T08:59:00.000Z', conversation_id: '7000' },
    ],
    includes: { users: [{ id: '9003', username: 'pat', name: 'Pat' }, { id: '9002', username: 'sam_r', name: 'Sam' }] },
    meta: { newest_id: '7002', result_count: 3 },
  };

  it('reads new mentions oldest first, remembers where it got to, and skips its own posts', async () => {
    fakeFetch({ 'GET /2/users/2244994945/mentions': () => ({ body: mentionsBody }) });
    const r = await xAdapter.poll!(ctx(creds), { startTime: '2026-10-12T08:00:00.000Z' });
    expect(messages(r.events).map((e) => e.externalId)).toEqual(['x:tweet:7001', 'x:tweet:7002']);
    expect(messages(r.events)[1].public).toMatchObject({ kind: 'reply', parentId: '6999', handle: '@pat' });
    expect(r.state.mentionsSinceId).toBe('7002');
    // First poll asks from the connect time, not from the beginning of history.
    expect(calls[0].url.searchParams.get('start_time')).toBe('2026-10-12T08:00:00.000Z');
    expect(calls[0].url.searchParams.get('since_id')).toBeNull();
    expect(calls).toHaveLength(1); // DMs are off by default
  });

  it('asks only for what is newer than the last poll', async () => {
    fakeFetch({ 'GET /2/users/2244994945/mentions': () => ({ body: { meta: { result_count: 0 } } }) });
    const r = await xAdapter.poll!(ctx(creds), { startTime: '2026-10-12T08:00:00.000Z', mentionsSinceId: '7002' });
    expect(calls[0].url.searchParams.get('since_id')).toBe('7002');
    expect(calls[0].url.searchParams.get('start_time')).toBeNull();
    expect(r.events).toEqual([]);
    expect(r.state.mentionsSinceId).toBe('7002');
  });

  it('when DM polling is on, probes with one event and reads more only if it is new', async () => {
    const dm = (id: string, at: string, sender = '9001') => ({ id, text: `dm ${id}`, created_at: at, sender_id: sender, event_type: 'MessageCreate' });
    fakeFetch({
      'GET /2/users/2244994945/mentions': () => ({ body: { meta: { result_count: 0 } } }),
      'GET /2/dm_events': (url) =>
        url.searchParams.get('max_results') === '1'
          ? { body: { data: [dm('2', '2026-10-12T09:30:00.000Z')] } }
          : { body: { data: [dm('2', '2026-10-12T09:30:00.000Z'), dm('1', '2026-10-12T09:10:00.000Z'), dm('0', '2026-10-12T07:00:00.000Z'), dm('9', '2026-10-12T09:20:00.000Z', '2244994945')], includes: { users: [{ id: '9001', username: 'dana_lee', name: 'Dana Lee' }] } } },
    });
    const withDms = ctx(creds, { settings: { poll_dms: true } });
    const r = await xAdapter.poll!(withDms, { startTime: '2026-10-12T08:00:00.000Z' });
    expect(r.state.lastDmProbeAt).toBeDefined();
    expect(messages(r.events).map((e) => e.externalId)).toEqual(['x:dm:1', 'x:dm:2']);
    expect(messages(r.events)[0]).toMatchObject({ from: '9001', fromName: 'Dana Lee (@dana_lee)', type: 'dm' });
    expect(r.state.lastDmAt).toBe('2026-10-12T09:30:00.000Z');

    // Nothing new: only the one-event probe is made (and billed).
    fakeFetch({
      'GET /2/users/2244994945/mentions': () => ({ body: { meta: { result_count: 0 } } }),
      'GET /2/dm_events': () => ({ body: { data: [dm('2', '2026-10-12T09:30:00.000Z')] } }),
    });
    const idle = await xAdapter.poll!(withDms, { ...r.state, lastDmProbeAt: new Date(Date.now() - 16 * 60_000).toISOString() });
    expect(idle.events).toEqual([]);
    expect(calls.filter((c) => c.url.pathname === '/2/dm_events')).toHaveLength(1);

    // Polled again two minutes later: DMs are not even probed (and so not billed).
    fakeFetch({ 'GET /2/users/2244994945/mentions': () => ({ body: { meta: { result_count: 0 } } }) });
    await xAdapter.poll!(withDms, { ...r.state, lastDmProbeAt: new Date(Date.now() - 2 * 60_000).toISOString() });
    expect(calls.filter((c) => c.url.pathname === '/2/dm_events')).toHaveLength(0);
  });

  it('surfaces a rate limit as a retryable error so the poller waits', async () => {
    fakeFetch({ 'GET /2/users/2244994945/mentions': () => ({ status: 429, body: {} }) });
    await expect(xAdapter.poll!(ctx(creds), {})).rejects.toMatchObject({ failure: { retryable: true } });
  });

  it('renews the 2-hour token just before it lapses, keeping the rotated refresh token', async () => {
    process.env.X_CLIENT_ID = 'cid';
    process.env.X_CLIENT_SECRET = 'csecret';
    fakeFetch({ 'POST /2/oauth2/token': () => ({ body: { access_token: 'new', refresh_token: 'r2', expires_in: 7200 } }) });
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const fresh = await xAdapter.refreshCredentials!(ctx({ accessToken: 'old', refreshToken: 'r1', expiresAt: soon }));
    expect(fresh?.credentials).toMatchObject({ accessToken: 'new', refreshToken: 'r2' });
    expect(String(calls[0].init.body)).toContain('refresh_token=r1');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    const later = new Date(Date.now() + 90 * 60_000).toISOString();
    expect(await xAdapter.refreshCredentials!(ctx({ accessToken: 'old', refreshToken: 'r1', expiresAt: later }))).toBeNull();
  });

  it('maps a mention that quotes nobody and a plain reply', () => {
    const users = new Map([['9', { id: '9', username: 'z', name: 'Zed' }]]);
    expect(tweetEvent({ id: '1', text: 'hello', author_id: '9' }, 'me', users)).toMatchObject({ type: 'mention', fromName: 'Zed (@z)' });
    expect(tweetEvent({ id: '1', text: 'hello', author_id: 'me' }, 'me', users)).toBeNull();
  });
});

/* ── Threads ───────────────────────────────────────────────────────────── */

describe('Threads webhooks', () => {
  const secret = 'threads-app-secret';

  it('verifies the Meta signature and the hub handshake', () => {
    const raw = fixture('threads/fixtures/replies-and-mentions.json');
    const headers = new Headers({ 'x-hub-signature-256': signMetaPayload(raw, secret) });
    expect(threadsAdapter.verifyWebhookSignature({ rawBody: raw, headers }, secret)).toBe(true);
    expect(threadsAdapter.verifyWebhookSignature({ rawBody: raw + 'x', headers }, secret)).toBe(false);
    expect(threadsAdapter.verifyWebhookSignature({ rawBody: raw, headers: new Headers() }, secret)).toBe(false);
    const q = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.challenge': '12345', 'hub.verify_token': 'tok' });
    expect(threadsAdapter.verifyWebhookChallenge(q, 'tok')).toBe('12345');
    expect(threadsAdapter.verifyWebhookChallenge(q, 'nope')).toBeNull();
  });

  it('turns replies and mentions into public events and skips other fields', () => {
    const events = messages(parseThreadsWebhook(json('threads/fixtures/replies-and-mentions.json')));
    expect(events.map((e) => e.externalId)).toEqual(['threads:18000000000000001', 'threads:18000000000000002']);
    expect(events[0]).toMatchObject({
      accountId: '17841400000000000',
      from: 'pub:jo_k',
      fromName: '@Jo_K',
      type: 'reply',
      text: 'Does this ship to Canada?',
      public: { kind: 'reply', itemId: '18000000000000001', rootId: '17900000000000009', parentId: '17900000000000009', handle: '@Jo_K' },
    });
    expect(events[0].sentAt.toISOString()).toBe('2026-10-12T09:00:00.000Z');
    expect(events[1]).toMatchObject({ type: 'mention', public: { kind: 'mention', parentId: undefined } });
  });

  it('also reads the standard entry/changes envelope', () => {
    const events = messages(parseThreadsWebhook(json('threads/fixtures/entry-changes.json')));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accountId: '17841400000000000', from: 'pub:lee', public: { parentId: '18000000000000001' } });
  });

  it('shrugs at anything else', () => {
    expect(parseThreadsWebhook(null)).toEqual([]);
    expect(parseThreadsWebhook({ values: [{ field: 'replies', value: {} }] })).toEqual([]);
    expect(parseThreadsWebhook({ entry: [{ changes: [{ field: 'replies', value: { id: '1', username: 'u' } }] }] })).toEqual([]);
  });
});

describe('Threads sending and polling', () => {
  const creds = { accessToken: 'tok' };
  const me = '17841400000000000';

  it('replies in two steps: create a container under the item, then publish it', async () => {
    fakeFetch({
      [`POST /v1.0/${me}/threads`]: () => ({ body: { id: 'container-1' } }),
      [`POST /v1.0/${me}/threads_publish`]: () => ({ body: { id: 'post-9' } }),
    });
    const r = await threadsAdapter.sendMessage(ctx(creds, { external_account_id: me }), 'pub:jo_k', {
      type: 'text',
      text: 'Yes, we ship to Canada.',
      publicTarget: { kind: 'reply', itemId: '18000000000000001' },
    });
    expect(r).toEqual({ ok: true, providerMessageId: 'threads:post-9' });
    const first = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(first)).toEqual({ media_type: 'TEXT', text: 'Yes, we ship to Canada.', reply_to_id: '18000000000000001' });
    expect(Object.fromEntries(new URLSearchParams(String(calls[1].init.body)))).toEqual({ creation_id: 'container-1' });
  });

  it('has no direct messages and caps replies at 500 characters', async () => {
    fakeFetch({});
    const dm = await threadsAdapter.sendMessage(ctx(creds, { external_account_id: me }), 'jo', { type: 'text', text: 'hi' });
    expect(dm).toMatchObject({ ok: false, retryable: false });
    expect((dm as { error: string }).error).toMatch(/no direct messages/);
    const long = await threadsAdapter.sendMessage(ctx(creds, { external_account_id: me }), 'pub:jo', { type: 'text', text: 'a'.repeat(501), publicTarget: { kind: 'reply', itemId: '1' } });
    expect((long as { error: string }).error).toMatch(/501 characters; Threads allows 500/);
    expect(calls).toHaveLength(0);
  });

  it('polls replies on recent posts, skipping its own and old ones, and compares real instants', async () => {
    const now = Date.now();
    const recent = new Date(now - 2 * 86_400_000).toISOString();
    const old = new Date(now - 30 * 86_400_000).toISOString();
    fakeFetch({
      'GET /v1.0/me/threads': () => ({ body: { data: [{ id: 'p1', timestamp: recent }, { id: 'p2', timestamp: old }] } }),
      'GET /v1.0/p1/replies': () => ({
        body: {
          data: [
            { id: 'r2', text: 'newer', username: 'Jo_K', timestamp: '2026-10-12T09:30:00+0000', permalink: 'https://threads.com/r2' },
            { id: 'r1', text: 'older than the cursor', username: 'lee', timestamp: '2026-10-12T08:00:00+0000' },
            { id: 'r3', text: 'ours', username: 'acme', timestamp: '2026-10-12T09:40:00+0000' },
            { id: 'r4', text: 'also ours', username: 'someone', timestamp: '2026-10-12T09:41:00+0000', is_reply_owned_by_me: true },
          ],
        },
      }),
    });
    const r = await threadsAdapter.poll!(ctx(creds, { external_account_id: me, settings: { username: 'acme' } }), { lastReplyAt: '2026-10-12T09:00:00.000Z' });
    expect(messages(r.events).map((e) => e.externalId)).toEqual(['threads:r2']);
    expect(messages(r.events)[0]).toMatchObject({ from: 'pub:jo_k', public: { kind: 'reply', itemId: 'r2', rootId: 'p1' } });
    expect(r.state.lastReplyAt).toBe('2026-10-12T09:30:00.000Z');
    // The month-old post is not read: one posts call and one replies call.
    expect(calls).toHaveLength(2);
  });

  it('renews a token in its last ten days, and leaves a fresh one alone', async () => {
    fakeFetch({ 'GET /refresh_access_token': () => ({ body: { access_token: 'renewed', expires_in: 5_184_000 } }) });
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const fresh = await threadsAdapter.refreshCredentials!(ctx({ accessToken: 'old', expiresAt: soon }));
    expect(fresh?.credentials.accessToken).toBe('renewed');
    expect(await threadsAdapter.refreshCredentials!(ctx({ accessToken: 'old', expiresAt: new Date(Date.now() + 40 * 86_400_000).toISOString() }))).toBeNull();
  });
});

/* ── LinkedIn ──────────────────────────────────────────────────────────── */

describe('LinkedIn', () => {
  const creds = { accessToken: 'tok' };
  const pageCtx = ctx(creds, { external_account_id: '5555' });

  it('polls comments on the Page’s posts, skipping the Page’s own and those before connecting', async () => {
    fakeFetch({
      'GET /rest/posts': () => ({ body: json('linkedin/fixtures/posts.json') }),
      'GET /rest/socialActions/urn%3Ali%3Aactivity%3A111/comments': () => ({ body: json('linkedin/fixtures/comments.json') }),
      'GET /rest/socialActions/urn%3Ali%3Ashare%3A222/comments': () => ({ body: { elements: [] } }),
    });
    const r = await linkedinAdapter.poll!(pageCtx, { lastCommentAt: new Date(1760100000000).toISOString() });
    const events = messages(r.events);
    expect(events.map((e) => e.externalId)).toEqual(['linkedin:urn:li:comment:(urn:li:activity:111,7001)']);
    expect(events[0]).toMatchObject({
      from: 'pub:urn:li:person:abc123',
      type: 'comment',
      text: 'Great post. Are you hiring in Lisbon?',
      public: { kind: 'comment', itemId: 'urn:li:comment:(urn:li:activity:111,7001)', rootId: 'urn:li:activity:111' },
    });
    expect(r.state.lastCommentAt).toBe(new Date(1760259600000).toISOString());
    // Headers LinkedIn requires on every call.
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['X-Restli-Protocol-Version']).toBe('2.0.0');
    expect(h['LinkedIn-Version']).toMatch(/^\d{6}$/);
    expect(calls[0].url.searchParams.get('author')).toBe('urn:li:organization:5555');
  });

  it('comments as the Page under the comment it answers', async () => {
    fakeFetch({
      'POST /rest/socialActions/urn%3Ali%3Aactivity%3A111/comments': () => ({ status: 201, body: {}, headers: { 'x-restli-id': 'urn:li:comment:(urn:li:activity:111,7003)' } }),
    });
    const r = await linkedinAdapter.sendMessage(pageCtx, 'pub:urn:li:person:abc123', {
      type: 'text',
      text: 'Yes! See our careers page.',
      publicTarget: { kind: 'comment', itemId: 'urn:li:comment:(urn:li:activity:111,7001)', rootId: 'urn:li:activity:111' },
    });
    expect(r).toEqual({ ok: true, providerMessageId: 'linkedin:urn:li:comment:(urn:li:activity:111,7003)' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual(
      buildLinkedInComment('urn:li:organization:5555', 'urn:li:activity:111', 'Yes! See our careers page.', 'urn:li:comment:(urn:li:activity:111,7001)')
    );
  });

  it('has no direct messages, and tells the agent why', async () => {
    fakeFetch({});
    const r = await linkedinAdapter.sendMessage(pageCtx, 'urn:li:person:abc', { type: 'text', text: 'hi' });
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect((r as { error: string }).error).toMatch(/no direct messages/);
  });

  it('turns an expired token and a missing approval into “needs attention”', async () => {
    fakeFetch({ 'POST /rest/socialActions/urn%3Ali%3Aactivity%3A1/comments': () => ({ status: 401, body: { message: 'EXPIRED_ACCESS_TOKEN' } }) });
    const expired = await linkedinAdapter.sendMessage(pageCtx, 'x', { type: 'text', text: 'hi', publicTarget: { kind: 'comment', itemId: 'c', rootId: 'urn:li:activity:1' } });
    expect(expired).toMatchObject({ ok: false, needsAttention: true, retryable: false });
    fakeFetch({ 'GET /rest/posts': () => ({ status: 403, body: { message: 'Not enough permissions' } }) });
    await expect(linkedinAdapter.connect({ pageId: '5555' }, creds)).rejects.toThrow(/administrator of the Page.*Community Management API/);
  });

  it('validates the Page id and rejects a comment with no text or author', async () => {
    await expect(linkedinAdapter.connect({ pageId: 'acme' }, creds)).rejects.toThrow(/numeric id/);
    expect(commentEvent({ actor: 'urn:li:organization:5555', message: { text: 'x' }, commentUrn: 'c' }, 'p', '5555', 'urn:li:organization:5555')).toBeNull();
    expect(commentEvent({ actor: 'urn:li:person:1', commentUrn: 'c' }, 'p', '5555', 'urn:li:organization:5555')).toBeNull();
  });

  it('rejects every webhook: LinkedIn push notifications are not used', () => {
    expect(linkedinAdapter.verifyWebhookSignature({ rawBody: '{}', headers: new Headers() }, 's')).toBe(false);
    expect(linkedinAdapter.parseWebhook({})).toEqual([]);
  });
});

/* ── TikTok ────────────────────────────────────────────────────────────── */

describe('TikTok webhooks', () => {
  const secret = 'client-secret';
  const raw = () => fixture('tiktok/fixtures/comment-created.json');

  it('verifies the t=…,s=… signature over "<t>.<body>"', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = signTikTokPayload(raw(), secret, t);
    expect(header).toMatch(/^t=\d+,s=[0-9a-f]{64}$/);
    expect(verifyTikTokSignature(raw(), header, secret)).toBe(true);
    expect(verifyTikTokSignature(raw() + ' ', header, secret)).toBe(false);
    expect(verifyTikTokSignature(raw(), header, 'other')).toBe(false);
    expect(verifyTikTokSignature(raw(), null, secret)).toBe(false);
    expect(verifyTikTokSignature(raw(), 't=abc,s=zz', secret)).toBe(false);
    expect(tiktokAdapter.verifyWebhookSignature({ rawBody: raw(), headers: new Headers({ 'tiktok-signature': header }) }, secret)).toBe(true);
  });

  it('refuses a validly signed request that is too old (replay) or from the future', () => {
    const now = 1_760_000_000;
    const header = signTikTokPayload(raw(), secret, now - 301);
    expect(verifyTikTokSignature(raw(), header, secret, now)).toBe(false);
    expect(verifyTikTokSignature(raw(), signTikTokPayload(raw(), secret, now - 299), secret, now)).toBe(true);
    expect(verifyTikTokSignature(raw(), signTikTokPayload(raw(), secret, now + 400), secret, now)).toBe(false);
  });

  it('turns a new comment into a public event and ignores edits, deletions and the account’s own comments', () => {
    const events = messages(parseTikTokWebhook(json('tiktok/fixtures/comment-created.json')));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId: 'biz-123',
      externalId: 'tiktok:c-1',
      from: 'pub:u-9',
      fromName: '@fan_account',
      type: 'comment',
      text: 'Where can I buy this?',
      public: { kind: 'comment', itemId: 'c-1', rootId: 'v-1', handle: '@fan_account' },
    });
    const body = (patch: Record<string, unknown>) => {
      const base = json('tiktok/fixtures/comment-created.json');
      return { ...base, content: JSON.stringify({ ...JSON.parse(base.content), ...patch }) };
    };
    expect(parseTikTokWebhook(body({ action: 'delete' }))).toEqual([]);
    expect(parseTikTokWebhook(body({ user_id: 'biz-123' }))).toEqual([]);
    expect(parseTikTokWebhook(body({ text: '' }))).toEqual([]);
    expect(parseTikTokWebhook({ event: 'authorization.removed', content: '{}' })).toEqual([]);
    expect(parseTikTokWebhook({ event: 'comment.update', content: 'not json' })).toEqual([]);
  });
});

describe('TikTok replying', () => {
  const creds = { accessToken: 'tok' };
  const target = { kind: 'comment' as const, itemId: 'c-1', rootId: 'v-1' };

  it('replies to the comment on the video', async () => {
    fakeFetch({ 'POST /open_api/v1.3/business/comment/reply/create/': () => ({ body: { code: 0, message: 'OK', data: { comment_id: 'c-2' } } }) });
    const r = await tiktokAdapter.sendMessage(ctx(creds, { external_account_id: 'biz-123' }), 'pub:u-9', { type: 'text', text: 'Link in bio!', publicTarget: target });
    expect(r).toEqual({ ok: true, providerMessageId: 'tiktok:c-2' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ business_id: 'biz-123', video_id: 'v-1', comment_id: 'c-1', text: 'Link in bio!' });
    expect((calls[0].init.headers as Record<string, string>)['Access-Token']).toBe('tok');
  });

  it('treats a non-zero code in a 200 answer as a failure, and an expired token as needing an admin', async () => {
    fakeFetch({ 'POST /open_api/v1.3/business/comment/reply/create/': () => ({ body: { code: 40105, message: 'Access token expired' } }) });
    const r = await tiktokAdapter.sendMessage(ctx(creds, { external_account_id: 'biz-123' }), 'pub:u-9', { type: 'text', text: 'hi', publicTarget: target });
    expect(r).toMatchObject({ ok: false, needsAttention: true, retryable: false });
  });

  it('answers only comments: no direct messages, and no more than 150 characters', async () => {
    fakeFetch({});
    const dm = await tiktokAdapter.sendMessage(ctx(creds, { external_account_id: 'biz-123' }), 'u-9', { type: 'text', text: 'hi' });
    expect((dm as { error: string }).error).toMatch(/can only answer TikTok comments/);
    const long = await tiktokAdapter.sendMessage(ctx(creds, { external_account_id: 'biz-123' }), 'pub:u-9', { type: 'text', text: 'a'.repeat(151), publicTarget: target });
    expect((long as { error: string }).error).toMatch(/151 characters; TikTok comments allow 150/);
    expect(calls).toHaveLength(0);
  });
});
