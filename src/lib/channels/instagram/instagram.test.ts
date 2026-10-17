import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { signMetaPayload } from '@/lib/channels/meta-signature';
import { buildInstagramMedia, buildInstagramText, eligibilityError, instagramAdapter } from './adapter';
import { classifyIgError } from './graph';
import { createState, readState } from './oauth';
import { parseInstagramWebhook } from './webhook';
import dmText from './fixtures/dm-text.json';
import dmMedia from './fixtures/dm-media.json';
import story from './fixtures/story.json';
import skipped from './fixtures/skipped.json';

const ACCOUNT = '17841400000000001';
const CUSTOMER = '1234567890123456';

describe('parsing Instagram webhooks', () => {
  it('reads a DM, routed by the business account it was sent to', () => {
    expect(parseInstagramWebhook(dmText)).toEqual([
      {
        kind: 'message',
        accountId: ACCOUNT,
        externalId: 'aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE3ODQx',
        from: CUSTOMER,
        sentAt: new Date(1760000000123),
        type: 'text',
        text: 'Is the blue one in stock?',
        replyToExternalId: undefined,
        story: undefined,
      },
    ]);
  });

  it('reads images, voice messages, shared reels and unsupported messages', () => {
    const byId = Object.fromEntries(parseInstagramWebhook(dmMedia).map((e) => [e.externalId, e]));
    expect(byId['mid.image1']).toMatchObject({ text: '[Image]', media: { kind: 'image', id: expect.stringContaining('photo.jpg') } });
    expect(byId['mid.audio1']).toMatchObject({ text: '[Voice message]', media: { kind: 'audio' } });
    expect(byId['mid.share1']).toMatchObject({ text: 'Shared a reel: https://www.instagram.com/reel/Cabc/' });
    expect(byId['mid.share1']).not.toHaveProperty('media.kind');
    expect(byId['mid.unsupported1']).toMatchObject({ type: 'unsupported' });
  });

  it('brings story replies and mentions in with their story context', () => {
    const [reply, mention] = parseInstagramWebhook(story);
    expect(reply).toMatchObject({
      type: 'story_reply',
      text: 'Love this colour!',
      story: { kind: 'reply', id: '17895695668004550', url: expect.stringContaining('asset_id=1789') },
    });
    expect(mention).toMatchObject({
      type: 'story_mention',
      text: 'Mentioned you in their story',
      story: { kind: 'mention', url: expect.stringContaining('asset_id=1790') },
    });
  });

  it('skips echoes, deleted messages and reactions, and turns "seen" into a read receipt', () => {
    expect(parseInstagramWebhook(skipped)).toEqual([
      { kind: 'status', accountId: ACCOUNT, externalId: 'mid.ourmessage1', status: 'read', at: new Date(1760000302000) },
    ]);
  });

  it('never throws on junk', () => {
    for (const junk of [null, 7, {}, { object: 'page', entry: [] }, { object: 'instagram', entry: [{ messaging: [{ message: {} }] }] }]) {
      expect(parseInstagramWebhook(junk)).toEqual([]);
    }
  });
});

describe('verification', () => {
  const raw = JSON.stringify(dmText);
  it('checks the signature over the raw body with the app secret', () => {
    const headers = new Headers({ 'x-hub-signature-256': signMetaPayload(raw, 'ig-secret') });
    expect(instagramAdapter.verifyWebhookSignature({ rawBody: raw, headers }, 'ig-secret')).toBe(true);
    expect(instagramAdapter.verifyWebhookSignature({ rawBody: raw, headers }, 'nope')).toBe(false);
    expect(instagramAdapter.verifyWebhookSignature({ rawBody: raw + ' ', headers }, 'ig-secret')).toBe(false);
    expect(instagramAdapter.verifyWebhookSignature({ rawBody: raw, headers: new Headers() }, 'ig-secret')).toBe(false);
  });

  it('echoes the challenge for the right verify token only', () => {
    const q = (t: string) => new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': t, 'hub.challenge': '99' });
    expect(instagramAdapter.verifyWebhookChallenge(q('tok'), 'tok')).toBe('99');
    expect(instagramAdapter.verifyWebhookChallenge(q('bad'), 'tok')).toBeNull();
  });
});

describe('sending', () => {
  it('builds text, with the human agent tag only when asked', () => {
    expect(buildInstagramText(CUSTOMER, { type: 'text', text: 'Yes!' })).toEqual({ recipient: { id: CUSTOMER }, message: { text: 'Yes!' } });
    expect(buildInstagramText(CUSTOMER, { type: 'text', text: 'Sorry', tag: 'HUMAN_AGENT' })).toEqual({
      recipient: { id: CUSTOMER },
      message: { text: 'Sorry' },
      messaging_type: 'MESSAGE_TAG',
      tag: 'HUMAN_AGENT',
    });
    expect(() => buildInstagramText(CUSTOMER, { type: 'template', template: { name: 'x', language: 'en' } })).toThrow(/templates/);
  });

  it('builds media attachments by link', () => {
    expect(buildInstagramMedia(CUSTOMER, { kind: 'image', url: 'https://x/a.jpg' })).toEqual({
      recipient: { id: CUSTOMER },
      message: { attachment: { type: 'image', payload: { url: 'https://x/a.jpg' } } },
    });
    expect(buildInstagramMedia(CUSTOMER, { kind: 'document', url: 'https://x/a.pdf' }).message).toEqual({
      attachment: { type: 'file', payload: { url: 'https://x/a.pdf' } },
    });
  });

  describe('against the API', () => {
    afterEach(() => vi.unstubAllGlobals());
    const ctx = {
      connection: { id: 'c', workspace_id: 'w', external_account_id: ACCOUNT, external_business_id: null, settings: {} },
      credentials: { accessToken: 'IGAA-token' },
    };

    it('posts to me/messages with the token and returns the message id', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ recipient_id: CUSTOMER, message_id: 'mid.out1' })));
      vi.stubGlobal('fetch', fetchMock);
      expect(await instagramAdapter.sendMessage(ctx, CUSTOMER, { type: 'text', text: 'Hi' })).toEqual({ ok: true, providerMessageId: 'mid.out1' });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
      expect(String(url)).toMatch(/^https:\/\/graph\.instagram\.com\/v\d+\.\d+\/me\/messages$/);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer IGAA-token');
    });

    it('sends the caption first, then the file', async () => {
      const bodies: unknown[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_u: URL, init: RequestInit) => {
          bodies.push(JSON.parse(init.body as string));
          return new Response(JSON.stringify({ message_id: `mid.${bodies.length}` }));
        })
      );
      const res = await instagramAdapter.sendMedia(ctx, CUSTOMER, { kind: 'image', url: 'https://x/a.jpg', caption: 'Here it is' });
      expect(res).toEqual({ ok: true, providerMessageId: 'mid.2' });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toMatchObject({ message: { text: 'Here it is' } });
    });

    it('reports a closed window as permanent and not a connection fault', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 10, error_subcode: 2534022, message: 'outside allowed window' } }), { status: 400 })));
      expect(await instagramAdapter.sendMessage(ctx, CUSTOMER, { type: 'text', text: 'late' })).toMatchObject({
        ok: false,
        retryable: false,
        windowClosed: true,
        needsAttention: false,
      });
    });
  });
});

describe('errors', () => {
  it('retries throttling, flags dead tokens, gives up on others', () => {
    expect(classifyIgError(400, { code: 4, message: 'rate' }).retryable).toBe(true);
    expect(classifyIgError(503, undefined).retryable).toBe(true);
    expect(classifyIgError(400, { code: 190, message: 'expired' })).toMatchObject({ retryable: false, needsAttention: true });
    expect(classifyIgError(400, { code: 10, message: 'no permission' }).needsAttention).toBe(true);
    expect(classifyIgError(400, { code: 551, message: 'x' })).toMatchObject({ retryable: false, needsAttention: false });
    expect(classifyIgError(400, { code: 100, message: 'bad param' })).toMatchObject({ retryable: false, needsAttention: false });
  });
});

describe('connecting an account', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('explains why a personal account cannot be connected', () => {
    expect(eligibilityError('BUSINESS')).toBeNull();
    expect(eligibilityError('MEDIA_CREATOR')).toBeNull();
    expect(eligibilityError('PERSONAL')).toMatch(/personal Instagram account.*professional account/);
    expect(eligibilityError(undefined)).toMatch(/professional/);
  });

  const mockApi = (me: Record<string, unknown>, subscribe: Response = new Response('{"success":true}')) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => (url.pathname.endsWith('/me') ? new Response(JSON.stringify(me)) : subscribe.clone()))
    );

  it('refuses a personal account before subscribing to anything', async () => {
    mockApi({ user_id: ACCOUNT, username: 'ana', account_type: 'PERSONAL' });
    await expect(instagramAdapter.connect({}, { accessToken: 'tok' })).rejects.toThrow(/personal Instagram account/);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('connects a professional account and subscribes to its messages', async () => {
    mockApi({ user_id: ACCOUNT, username: 'acme', name: 'Acme Shop', account_type: 'BUSINESS' });
    expect(await instagramAdapter.connect({}, { accessToken: 'tok', expiresAt: '2026-12-01T00:00:00.000Z' })).toMatchObject({
      externalAccountId: ACCOUNT,
      displayName: '@acme · Acme Shop',
      settings: { account_type: 'BUSINESS', token_expires_at: '2026-12-01T00:00:00.000Z' },
    });
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [URL, RequestInit][];
    expect(calls[1][0].pathname).toMatch(/me\/subscribed_apps$/);
    expect(calls[1][0].searchParams.get('subscribed_fields')).toBe('messages,messaging_seen');
  });

  it('points at the message-access setting when Instagram refuses the subscription', async () => {
    mockApi({ user_id: ACCOUNT, username: 'acme', account_type: 'BUSINESS' }, new Response(JSON.stringify({ error: { code: 10, message: 'No permission' } }), { status: 400 }));
    await expect(instagramAdapter.connect({}, { accessToken: 'tok' })).rejects.toThrow(/Allow access to messages/);
  });
});

describe('token refresh', () => {
  afterEach(() => vi.unstubAllGlobals());
  const base = { connection: { id: 'c', workspace_id: 'w', external_account_id: ACCOUNT, external_business_id: null, settings: {} } };
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

  it('leaves a fresh or expired token alone', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await instagramAdapter.refreshCredentials!({ ...base, credentials: { accessToken: 't', expiresAt: inDays(40) } })).toBeNull();
    expect(await instagramAdapter.refreshCredentials!({ ...base, credentials: { accessToken: 't', expiresAt: inDays(-1) } })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renews a token in its last 10 days and records the new expiry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 5_184_000 }))));
    const out = await instagramAdapter.refreshCredentials!({ ...base, credentials: { accessToken: 'old', appSecret: 's', expiresAt: inDays(5) } });
    expect(out?.credentials).toMatchObject({ accessToken: 'new', appSecret: 's' });
    expect(Date.parse(out!.credentials.expiresAt!)).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    expect(out!.settings.token_expires_at).toBe(out!.credentials.expiresAt);
  });
});

describe('login state', () => {
  beforeEach(() => vi.stubEnv('CHANNEL_ENCRYPTION_KEY', randomBytes(32).toString('base64')));
  afterEach(() => vi.unstubAllEnvs());

  it('round-trips who started the flow, and rejects tampering and expiry', () => {
    const state = createState('ws-1', 'user-1');
    expect(readState(state)).toMatchObject({ workspaceId: 'ws-1', userId: 'user-1' });
    const [payload, sig] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ w: 'ws-2', u: 'user-1', e: Date.now() + 60_000 })).toString('base64url');
    expect(readState(`${forged}.${sig}`)).toBeNull();
    expect(readState(`${payload}.x${sig}`)).toBeNull();
    expect(readState(createState('ws-1', 'user-1', -1))).toBeNull();
    expect(readState(null)).toBeNull();
  });
});
