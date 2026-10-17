import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, parseKey } from './crypto';
import { signMetaPayload } from './meta-signature';
import { contentForMessage, mediaKindForUrl } from './outbound';
import { serviceWindow, formatRemaining } from './window';
import textMessage from './whatsapp/fixtures/text-message.json';
import statuses from './whatsapp/fixtures/statuses.json';
import mediaMessages from './whatsapp/fixtures/media-messages.json';

/* ── Mocks: no database, no network ───────────────────────────────────── */

const rpc = vi.fn();
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => ({
    rpc,
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
  }),
}));

const connections = new Map<string, { connection: Record<string, unknown>; credentials: Record<string, unknown> }>();
vi.mock('./store', () => ({
  loadConnectionById: async (id: string) => connections.get(id) ?? null,
  loadConnectionByAccount: async (_channel: string, accountId: string) =>
    Array.from(connections.values()).find((c) => c.connection.external_account_id === accountId && c.connection.status !== 'disconnected') ?? null,
  loadConnection: async () => null,
  updateConnection: vi.fn(async () => undefined),
  recordConnectionError: vi.fn(async () => undefined),
}));

vi.mock('@/lib/cloudinary', () => ({ isCloudinaryConfigured: () => false, uploadToCloudinary: vi.fn() }));

const { handleWebhookPost, handleWebhookChallenge } = await import('./inbound');

const KEY = randomBytes(32).toString('base64');

describe('credential encryption', () => {
  it('round-trips and never stores the plain token', () => {
    const secret = { accessToken: 'EAAG-very-secret', appSecret: 'abc' };
    const sealed = encryptSecret(secret, KEY);
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain('very-secret');
    expect(decryptSecret(sealed, KEY)).toEqual(secret);
    expect(encryptSecret(secret, KEY)).not.toBe(sealed);
  });

  it('refuses the wrong key, tampering and a missing key', () => {
    const sealed = encryptSecret({ a: 1 }, KEY);
    expect(() => decryptSecret(sealed, randomBytes(32).toString('base64'))).toThrow(/decrypt/);
    const parts = sealed.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'), KEY)).toThrow(/decrypt/);
    expect(() => parseKey('')).toThrow(/not set/);
    expect(() => parseKey('c2hvcnQ=')).toThrow(/32 bytes/);
    expect(parseKey('a'.repeat(64))).toHaveLength(32);
  });
});

describe('the 24-hour window', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  it('is open for 24 hours after the customer last wrote', () => {
    expect(serviceWindow('2026-10-09T00:00:00Z', 24, now)).toMatchObject({ open: true, remainingMs: 12 * 3_600_000 });
    expect(serviceWindow('2026-10-08T11:59:00Z', 24, now)).toMatchObject({ open: false, remainingMs: 0 });
    expect(serviceWindow(null, 24, now)).toMatchObject({ open: false, expiresAt: null });
    expect(serviceWindow(null, null, now).open).toBe(true);
    expect(formatRemaining(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m');
    expect(formatRemaining(30_000)).toBe('under a minute');
  });
});

describe('what goes out for a stored message', () => {
  const base = { id: 'm1', content: 'Here you go', attachment_url: null, metadata: null, reply_to_message_id: null };
  it('sends templates, then files, then text', () => {
    expect(
      contentForMessage({ ...base, metadata: { channel_template: { name: 'order_update', language: 'en_US', body_params: ['Ana', 5512] } } })
    ).toEqual({ kind: 'content', content: { type: 'template', template: { name: 'order_update', language: 'en_US', bodyParams: ['Ana', '5512'] } } });
    expect(contentForMessage({ ...base, attachment_url: 'https://res.cloudinary.com/x/raw/upload/v1/invoice%20may.pdf' })).toEqual({
      kind: 'media',
      media: { kind: 'document', url: 'https://res.cloudinary.com/x/raw/upload/v1/invoice%20may.pdf', caption: 'Here you go', filename: 'invoice may.pdf' },
    });
    expect(contentForMessage(base, 'wamid.Q')).toEqual({ kind: 'content', content: { type: 'text', text: 'Here you go', replyToExternalId: 'wamid.Q' } });
  });

  it('picks the media kind from the file', () => {
    expect(mediaKindForUrl('https://x/photo.JPG')).toBe('image');
    expect(mediaKindForUrl('https://res.cloudinary.com/x/image/upload/v1/abc')).toBe('image');
    expect(mediaKindForUrl('https://res.cloudinary.com/x/image/upload/v1/anim.gif')).toBe('document');
    expect(mediaKindForUrl('https://x/clip.mp4?sig=1')).toBe('video');
    expect(mediaKindForUrl('https://x/note.ogg')).toBe('audio');
    expect(mediaKindForUrl('https://x/report.docx')).toBe('document');
  });
});

describe('handling a webhook', () => {
  const APP_SECRET = 'platform-app-secret';
  const PHONE_ID = '106540352242922';
  const post = (payload: unknown, opts: { secret?: string; connectionId?: string } = {}) => {
    const rawBody = JSON.stringify(payload);
    return handleWebhookPost({
      channel: 'whatsapp',
      rawBody,
      headers: new Headers({ 'x-hub-signature-256': signMetaPayload(rawBody, opts.secret ?? APP_SECRET) }),
      connectionId: opts.connectionId,
      origin: 'https://app.example',
    });
  };

  beforeEach(() => {
    vi.stubEnv('META_APP_SECRET', APP_SECRET);
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'platform-verify');
    rpc.mockReset();
    connections.clear();
    connections.set('conn-1', {
      connection: { id: 'conn-1', workspace_id: 'ws-1', channel: 'whatsapp', status: 'connected', external_account_id: PHONE_ID, settings: {} },
      credentials: { accessToken: 'tok' },
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('rejects an unsigned or mis-signed delivery before storing anything', async () => {
    expect((await post(textMessage, { secret: 'someone-else' })).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('routes a message to the workspace that owns the number and hands it to the bot afterwards', async () => {
    rpc.mockResolvedValue({ data: { duplicate: false, message_id: 'm1', conversation_id: 'c1', workspace_id: 'ws-1', ai_mode: 'autopilot' }, error: null });
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    const out = await post(textMessage);
    expect(out.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('fn_channel_ingest_inbound', expect.objectContaining({
      p_connection_id: 'conn-1',
      p_sender_id: '16505551234',
      p_sender_name: 'Sheena Nelson',
      p_external_id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
      p_content: 'Does it come in another color?',
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    await Promise.all(out.followUps.map((f) => f()));
    expect(fetchMock).toHaveBeenCalledWith('https://app.example/api/ai/auto-respond', expect.objectContaining({ method: 'POST' }));
  });

  it('does nothing more for a retried delivery the database has already seen', async () => {
    rpc.mockResolvedValue({ data: { duplicate: true, message_id: 'm1' }, error: null });
    const out = await post(textMessage);
    expect(out).toMatchObject({ status: 200, followUps: [] });
  });

  it('drops events for numbers no workspace has connected', async () => {
    connections.clear();
    const out = await post(textMessage);
    expect(out.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('asks Meta to retry when the database fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    expect((await post(textMessage)).status).toBe(500);
  });

  it('records receipts', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect((await post(statuses)).status).toBe(200);
    expect(rpc.mock.calls.map((c) => [c[0], c[1].p_channel_message_id, c[1].p_status])).toEqual([
      ['fn_channel_record_status', 'wamid.OUT1', 'delivered'],
      ['fn_channel_record_status', 'wamid.OUT1', 'read'],
      ['fn_channel_record_status', 'wamid.OUT2', 'failed'],
    ]);
  });

  it('stores media messages with their media reference', async () => {
    rpc.mockResolvedValue({ data: { duplicate: false, message_id: 'm', ai_mode: 'disabled' }, error: null });
    await post(mediaMessages);
    const image = rpc.mock.calls.find((c) => c[1].p_external_id === 'wamid.IMAGE1');
    expect(image?.[1].p_metadata).toEqual({ channel_type: 'image', channel_media: { id: '1003383421387256', kind: 'image', mimeType: 'image/jpeg', filename: undefined } });
  });

  it('uses a manually connected app’s own secret, and only for its own number', async () => {
    connections.set('conn-manual', {
      connection: { id: 'conn-manual', workspace_id: 'ws-2', channel: 'whatsapp', status: 'connected', external_account_id: '555', settings: {} },
      credentials: { accessToken: 'tok', appSecret: 'their-secret', verifyToken: 'their-verify' },
    });
    expect((await post(textMessage, { connectionId: 'conn-manual' })).status).toBe(401);
    rpc.mockResolvedValue({ data: { duplicate: false, message_id: 'm' }, error: null });
    // Signed correctly, but the message is for another number: not this connection's to store.
    expect((await post(textMessage, { connectionId: 'conn-manual', secret: 'their-secret' })).status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers the verification handshake with the right token only', async () => {
    const q = (token: string) => new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '42' });
    expect(await handleWebhookChallenge('whatsapp', q('platform-verify'))).toEqual({ status: 200, body: '42' });
    expect((await handleWebhookChallenge('whatsapp', q('nope'))).status).toBe(403);
    expect((await handleWebhookChallenge('messenger', q('platform-verify'))).status).toBe(404);
  });
});
