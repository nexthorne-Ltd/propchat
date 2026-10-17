import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * Reading screenshots: only public https images within the size cap are
 * fetched, documents and secrets are never transcribed, and the reading joins
 * the visitor's words as a marked note. The model and the network are faked.
 */

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}) }));
vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  return { ...actual, visionChat: vi.fn() };
});

const { visionChat, isConfigured } = await import('@/lib/ai/provider');
const {
  fetchImage,
  looksLikeImageUrl,
  messageWithImage,
  parseImageReading,
  readScreenshot,
  scrubReading,
  visionConfigFrom,
  withoutImageNote,
  IMAGE_MAX_BYTES,
} = await import('./vision');

const png = (bytes = 10) => new Response(Buffer.alloc(bytes, 1), { status: 200, headers: { 'content-type': 'image/png' } });
const fakeFetch = (responses: Record<string, () => Response>) =>
  (async (url: string | URL) => {
    const u = String(url);
    const make = responses[u];
    if (!make) throw new Error(`unexpected fetch ${u}`);
    return make();
  }) as unknown as typeof fetch;

afterEach(() => {
  vi.mocked(visionChat).mockReset();
  vi.unstubAllEnvs();
});

describe('fetchImage', () => {
  it('reads a public https image', async () => {
    const img = await fetchImage('https://res.cloudinary.com/x/image/upload/a.png', fakeFetch({ 'https://res.cloudinary.com/x/image/upload/a.png': () => png() }));
    expect(img).toMatchObject({ mimeType: 'image/png' });
  });

  it('refuses private hosts, http, non-images and files over the cap', async () => {
    expect(await fetchImage('https://127.0.0.1/a.png', fakeFetch({}))).toBeNull();
    expect(await fetchImage('http://example.com/a.png', fakeFetch({}))).toBeNull();
    const html = () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect(await fetchImage('https://example.com/a.png', fakeFetch({ 'https://example.com/a.png': html }))).toBeNull();
    const big = () => new Response('x', { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(IMAGE_MAX_BYTES + 1) } });
    expect(await fetchImage('https://example.com/b.png', fakeFetch({ 'https://example.com/b.png': big }))).toBeNull();
  });

  it('a redirect is followed only to another public https host', async () => {
    const to = (location: string) => () => new Response(null, { status: 302, headers: { location } });
    expect(
      await fetchImage('https://example.com/r.png', fakeFetch({ 'https://example.com/r.png': to('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png': () => png() }))
    ).not.toBeNull();
    expect(await fetchImage('https://example.com/s.png', fakeFetch({ 'https://example.com/s.png': to('http://169.254.169.254/latest') }))).toBeNull();
  });
});

describe('parseImageReading and scrubReading', () => {
  it('reads the JSON and keeps the error text', () => {
    const r = parseImageReading('{"kind":"platform_error","summary":"MT5 login window showing an error.","text":"Invalid account"}');
    expect(r).toEqual({ kind: 'platform_error', summary: 'MT5 login window showing an error.', text: 'Invalid account' });
  });

  it('an identity document is described, never transcribed; card numbers and passwords are removed', () => {
    expect(parseImageReading('{"kind":"identity_document","summary":"A CNIC photo.","text":"35202-1234567-1 Ali Khan"}')?.text).toBe('');
    expect(scrubReading('Card 4111 1111 1111 1111 declined')).toBe('Card [number removed] declined');
    expect(scrubReading('password: hunter2 shown')).toBe('password [removed] shown');
    expect(scrubReading('CNIC 35202-1234567-1')).toBe('CNIC [number removed]');
  });

  it('anything else is no reading', () => {
    expect(parseImageReading('I cannot see the image')).toBeNull();
    expect(parseImageReading('{"kind":"other"}')).toBeNull();
  });
});

describe('messageWithImage', () => {
  const reading = { kind: 'platform_error' as const, summary: 'MT5 login error.', text: 'Invalid account' };
  it('replaces the "Sent a picture" placeholder, or follows the visitor\'s words', () => {
    expect(messageWithImage('Sent a picture', reading)).toBe('[Screenshot from the customer: MT5 login error. Text in it: "Invalid account"]');
    expect(messageWithImage('ye error aa raha hai', reading)).toBe('ye error aa raha hai\n[Screenshot from the customer: MT5 login error. Text in it: "Invalid account"]');
    expect(messageWithImage('hello', null)).toBe('hello');
  });

  it('the visitor\'s own words come back for language detection', () => {
    expect(withoutImageNote(messageWithImage('ye error aa raha hai', reading))).toBe('ye error aa raha hai');
  });
});

describe('visionConfigFrom: images go to Gemini only', () => {
  const clear = () => {
    for (const k of ['VISION_API_KEY', 'VISION_PROVIDER', 'VISION_MODEL', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) vi.stubEnv(k, '');
  };

  it('VISION_API_KEY is always a Gemini key; VISION_PROVIDER cannot change that', () => {
    clear();
    vi.stubEnv('VISION_API_KEY', 'vk');
    expect(visionConfigFrom()).toEqual({ provider: 'google', apiKey: 'vk', model: null });
    vi.stubEnv('VISION_PROVIDER', 'openai');
    vi.stubEnv('VISION_MODEL', 'gemini-x');
    expect(visionConfigFrom()).toEqual({ provider: 'google', apiKey: 'vk', model: 'gemini-x' });
  });

  it('no VISION_API_KEY: no image is read, even with other keys set', () => {
    clear();
    vi.stubEnv('GEMINI_API_KEY', 'g');
    vi.stubEnv('GOOGLE_API_KEY', 'g');
    vi.stubEnv('OPENAI_API_KEY', 'o');
    expect(visionConfigFrom()).toBeNull();
  });

  it('the vision key is used for nothing else: the text model does not pick it up', () => {
    clear();
    vi.stubEnv('VISION_API_KEY', 'vk');
    expect(isConfigured({ provider: 'google' })).toBe(false);
    expect(isConfigured({ provider: 'openai' })).toBe(false);
  });
});

describe('readScreenshot', () => {
  it('reads an image once with the caption as a hint', async () => {
    vi.stubEnv('VISION_API_KEY', 'env');
    vi.mocked(visionChat).mockResolvedValue({
      text: '{"kind":"dashboard","summary":"Account dashboard showing status Failed.","text":"Daily drawdown breached"}',
      provider: 'google',
      model: 'gemini',
    });
    const r = await readScreenshot({
      url: 'https://res.cloudinary.com/x/image/upload/d.png',
      caption: 'mera account kyun fail hua',
      fetchImpl: fakeFetch({ 'https://res.cloudinary.com/x/image/upload/d.png': () => png() }),
    });
    expect(r.reason).toBe('read');
    expect(r.reading).toMatchObject({ kind: 'dashboard', text: 'Daily drawdown breached', provider: 'google' });
    expect(vi.mocked(visionChat).mock.calls[0][1].prompt).toContain('mera account kyun fail hua');
  });

  it('no vision model, or an unreadable image: no reading, and no model call', async () => {
    vi.stubEnv('VISION_API_KEY', '');
    expect((await readScreenshot({ url: 'https://example.com/a.png' })).reason).toBe('no_vision_model');
    vi.stubEnv('VISION_API_KEY', 'env');
    const r = await readScreenshot({ url: 'https://127.0.0.1/a.png', fetchImpl: fakeFetch({}) });
    expect(r.reason).toBe('not_readable');
    expect(visionChat).not.toHaveBeenCalled();
  });
});

describe('looksLikeImageUrl', () => {
  it('knows image links', () => {
    expect(looksLikeImageUrl('https://res.cloudinary.com/x/image/upload/v1/a')).toBe(true);
    expect(looksLikeImageUrl('https://x.com/a.JPG?w=1')).toBe(true);
    expect(looksLikeImageUrl('https://x.com/invoice.pdf')).toBe(false);
    expect(looksLikeImageUrl(null)).toBe(false);
  });
});
