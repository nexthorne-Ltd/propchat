import { afterEach, describe, expect, it, vi } from 'vitest';
import { signMetaPayload } from '@/lib/channels/meta-signature';
import { buildMediaPayload, buildTextPayload, normalizePhone, renderTemplate, templateParamCount, whatsappAdapter } from './adapter';
import { classifyGraphError } from './graph';
import { parseWhatsAppWebhook } from './webhook';
import textMessage from './fixtures/text-message.json';
import mediaMessages from './fixtures/media-messages.json';
import statuses from './fixtures/statuses.json';

const PHONE_ID = '106540352242922';

describe('parsing WhatsApp webhooks', () => {
  it('reads a text message with the sender name and the number it was sent to', () => {
    expect(parseWhatsAppWebhook(textMessage)).toEqual([
      {
        kind: 'message',
        accountId: PHONE_ID,
        externalId: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
        from: '16505551234',
        fromName: 'Sheena Nelson',
        sentAt: new Date(1749416383 * 1000),
        text: 'Does it come in another color?',
        media: undefined,
        type: 'text',
        replyToExternalId: undefined,
      },
    ]);
  });

  it('turns media, locations, buttons and reactions into readable lines, and skips system notices', () => {
    const events = parseWhatsAppWebhook(mediaMessages);
    const byId = Object.fromEntries(events.map((e) => [e.externalId, e]));
    expect(Object.keys(byId)).toEqual(['wamid.IMAGE1', 'wamid.DOC1', 'wamid.AUDIO1', 'wamid.LOC1', 'wamid.BTN1', 'wamid.REACT1', 'wamid.UNSUP1']);
    expect(byId['wamid.IMAGE1']).toMatchObject({
      text: 'This is the broken part',
      media: { id: '1003383421387256', kind: 'image', mimeType: 'image/jpeg' },
    });
    expect(byId['wamid.DOC1']).toMatchObject({ text: '[Document] invoice-5512.pdf', media: { kind: 'document', filename: 'invoice-5512.pdf' } });
    expect(byId['wamid.AUDIO1']).toMatchObject({ text: '[Voice message]', media: { kind: 'audio' } });
    expect(byId['wamid.LOC1']).toMatchObject({ text: '[Location] Philz Coffee, 101 Forest Ave, Palo Alto (37.483307,122.148981)' });
    expect(byId['wamid.BTN1']).toMatchObject({ text: 'Track my order', replyToExternalId: 'wamid.TEMPLATE_SENT' });
    expect(byId['wamid.REACT1']).toMatchObject({ text: 'Reacted 👍' });
    expect(byId['wamid.UNSUP1'].kind).toBe('message');
  });

  it('reads delivery, read and failure receipts and ignores other fields and unknown statuses', () => {
    expect(parseWhatsAppWebhook(statuses)).toEqual([
      { kind: 'status', accountId: PHONE_ID, externalId: 'wamid.OUT1', status: 'delivered', at: new Date(1750263773000), error: undefined },
      { kind: 'status', accountId: PHONE_ID, externalId: 'wamid.OUT1', status: 'read', at: new Date(1750263800000), error: undefined },
      {
        kind: 'status',
        accountId: PHONE_ID,
        externalId: 'wamid.OUT2',
        status: 'failed',
        at: new Date(1750263900000),
        error: 'Re-engagement message: Message failed to send because more than 24 hours have passed since the customer last replied to this number.',
      },
    ]);
  });

  it('never throws on junk', () => {
    for (const junk of [null, 42, 'x', {}, { object: 'page', entry: [] }, { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {} }] }] }]) {
      expect(parseWhatsAppWebhook(junk)).toEqual([]);
    }
  });
});

describe('webhook verification', () => {
  const raw = JSON.stringify(textMessage);

  it('accepts Meta’s signature over the raw body and rejects anything else', () => {
    const headers = new Headers({ 'x-hub-signature-256': signMetaPayload(raw, 'app-secret') });
    expect(whatsappAdapter.verifyWebhookSignature({ rawBody: raw, headers }, 'app-secret')).toBe(true);
    expect(whatsappAdapter.verifyWebhookSignature({ rawBody: raw, headers }, 'other-secret')).toBe(false);
    expect(whatsappAdapter.verifyWebhookSignature({ rawBody: raw + ' ', headers }, 'app-secret')).toBe(false);
    expect(whatsappAdapter.verifyWebhookSignature({ rawBody: raw, headers: new Headers() }, 'app-secret')).toBe(false);
    expect(whatsappAdapter.verifyWebhookSignature({ rawBody: raw, headers: new Headers({ 'x-hub-signature-256': 'sha256=zz' }) }, 'app-secret')).toBe(false);
  });

  it('echoes the challenge only for the right verify token', () => {
    const q = (token: string, mode = 'subscribe') => new URLSearchParams({ 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': '1158201444' });
    expect(whatsappAdapter.verifyWebhookChallenge(q('secret-token'), 'secret-token')).toBe('1158201444');
    expect(whatsappAdapter.verifyWebhookChallenge(q('wrong'), 'secret-token')).toBeNull();
    expect(whatsappAdapter.verifyWebhookChallenge(q('secret-token', 'unsubscribe'), 'secret-token')).toBeNull();
    expect(whatsappAdapter.verifyWebhookChallenge(q(''), '')).toBeNull();
  });
});

describe('building messages', () => {
  it('sends text, quoting the customer’s message when replying to one', () => {
    expect(buildTextPayload('+1 (650) 555-1234', { type: 'text', text: 'Yes, in blue.', replyToExternalId: 'wamid.X' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '16505551234',
      type: 'text',
      text: { body: 'Yes, in blue.', preview_url: false },
      context: { message_id: 'wamid.X' },
    });
  });

  it('sends a template with its body parameters', () => {
    expect(
      buildTextPayload('16505551234', { type: 'template', template: { name: 'order_update', language: 'en_US', bodyParams: ['Ana', '#5512'] } })
    ).toMatchObject({
      type: 'template',
      template: {
        name: 'order_update',
        language: { code: 'en_US' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: '#5512' }] }],
      },
    });
    expect(buildTextPayload('1', { type: 'template', template: { name: 'hello_world', language: 'en_US' } }).template).toEqual({
      name: 'hello_world',
      language: { code: 'en_US' },
    });
  });

  it('sends media by link; audio has no caption, documents keep their name', () => {
    expect(buildMediaPayload('1', { kind: 'image', url: 'https://x/a.jpg', caption: 'Look' })).toMatchObject({ type: 'image', image: { link: 'https://x/a.jpg', caption: 'Look' } });
    expect(buildMediaPayload('1', { kind: 'audio', url: 'https://x/a.ogg', caption: 'ignored' })).toMatchObject({ type: 'audio', audio: { link: 'https://x/a.ogg' } });
    expect(buildMediaPayload('1', { kind: 'document', url: 'https://x/f.pdf', filename: 'f.pdf' })).toMatchObject({ document: { link: 'https://x/f.pdf', filename: 'f.pdf' } });
  });

  it('counts and fills template placeholders', () => {
    expect(templateParamCount('Hi {{1}}, order {{2}} ships {{ 2 }}')).toBe(2);
    expect(templateParamCount('No params')).toBe(0);
    expect(renderTemplate('Hi {{1}}, order {{2}}', ['Ana'])).toBe('Hi Ana, order {{2}}');
    expect(normalizePhone('+44 20 7946-0958')).toBe('442079460958');
  });
});

describe('Graph errors', () => {
  it('retries throttling, outages and network failures', () => {
    expect(classifyGraphError(400, { code: 130429, message: 'Rate limit hit' }).retryable).toBe(true);
    expect(classifyGraphError(503, { message: 'Service unavailable' }).retryable).toBe(true);
    expect(classifyGraphError(null, { message: 'ECONNRESET' }).retryable).toBe(true);
    expect(classifyGraphError(429, undefined).retryable).toBe(true);
  });

  it('flags a broken connection for an admin', () => {
    expect(classifyGraphError(401, { code: 190, message: 'Error validating access token' })).toMatchObject({ retryable: false, needsAttention: true });
    expect(classifyGraphError(400, { code: 100, error_subcode: 33, message: 'Object does not exist' })).toMatchObject({ needsAttention: true });
  });

  it('explains the closed 24-hour window instead of retrying', () => {
    expect(classifyGraphError(400, { code: 131047, message: 'Re-engagement message' })).toMatchObject({
      retryable: false,
      windowClosed: true,
      error: expect.stringContaining('approved template'),
    });
  });

  it('gives up on a bad request, with Meta’s details', () => {
    expect(classifyGraphError(400, { code: 131026, message: 'Message undeliverable', error_data: { details: 'Recipient is not a WhatsApp user.' } })).toEqual({
      error: 'Message undeliverable Recipient is not a WhatsApp user.',
      retryable: false,
      needsAttention: false,
      windowClosed: false,
      code: 131026,
    });
  });
});

describe('sending through the Cloud API', () => {
  afterEach(() => vi.unstubAllGlobals());
  const ctx = {
    connection: { id: 'c1', workspace_id: 'w1', external_account_id: PHONE_ID, external_business_id: '102290129340398', settings: {} },
    credentials: { accessToken: 'EAAG-token' },
  };

  it('posts to the phone number’s messages endpoint with the token and returns the wamid', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.SENT' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await whatsappAdapter.sendMessage(ctx, '16505551234', { type: 'text', text: 'Hi' });
    expect(res).toEqual({ ok: true, providerMessageId: 'wamid.SENT' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toMatch(new RegExp(`graph\\.facebook\\.com/v\\d+\\.\\d+/${PHONE_ID}/messages$`));
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer EAAG-token');
    expect(JSON.parse(init.body as string)).toMatchObject({ to: '16505551234', type: 'text' });
  });

  it('reports a closed window as a permanent, non-connection failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }), { status: 400 })));
    const res = await whatsappAdapter.sendMessage(ctx, '1', { type: 'text', text: 'late' });
    expect(res).toMatchObject({ ok: false, retryable: false, windowClosed: true, needsAttention: false });
  });

  it('lists only approved templates with their placeholder count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { name: 'order_update', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}} shipped.' }] },
              { name: 'promo', language: 'en_US', status: 'REJECTED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Sale!' }] },
            ],
          }),
          { status: 200 }
        )
      )
    );
    expect(await whatsappAdapter.listTemplates(ctx)).toEqual([
      { name: 'order_update', language: 'en_US', category: 'UTILITY', status: 'APPROVED', body: 'Hi {{1}}, order {{2}} shipped.', paramCount: 2 },
    ]);
  });

  it('checks the number belongs to the account and subscribes the app when connecting', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push(`${init?.method || 'GET'} ${url.pathname}`);
        if (url.pathname.endsWith(`/${PHONE_ID}`)) {
          return new Response(JSON.stringify({ id: PHONE_ID, display_phone_number: '+1 555-078-3881', verified_name: 'Acme Support', quality_rating: 'GREEN' }));
        }
        if (url.pathname.endsWith('/phone_numbers')) return new Response(JSON.stringify({ data: [{ id: PHONE_ID }] }));
        return new Response(JSON.stringify({ success: true }));
      })
    );
    const account = await whatsappAdapter.connect({ phoneNumberId: PHONE_ID, wabaId: '102290129340398' }, { accessToken: 'tok' });
    expect(account).toMatchObject({ externalAccountId: PHONE_ID, externalBusinessId: '102290129340398', displayName: '+1 555-078-3881 · Acme Support' });
    expect(calls.map((c) => c.replace(/\/v\d+\.\d+/, ''))).toEqual([
      `GET /${PHONE_ID}`,
      'GET /102290129340398/phone_numbers',
      'POST /102290129340398/subscribed_apps',
    ]);
  });

  it('refuses a number from another account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) =>
        new Response(JSON.stringify(url.pathname.endsWith('/phone_numbers') ? { data: [{ id: '999999999' }] } : { id: PHONE_ID }))
      )
    );
    await expect(whatsappAdapter.connect({ phoneNumberId: PHONE_ID, wabaId: '102290129340398' }, { accessToken: 'tok' })).rejects.toThrow(/does not belong/);
  });
});
