import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadChatImage } from './image-upload';

describe('image-upload client helper', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options?: RequestInit }[] = [];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = vi.fn(async (url: any, options: any) => {
      fetchCalls.push({ url: String(url), options });
      if (String(url).endsWith('/api/upload/sign')) {
        return new Response(
          JSON.stringify({
            cloudName: 'test-cloud',
            apiKey: 'key-123',
            timestamp: 1234567890,
            signature: 'sig-abc',
            folder: 'chat_attachments',
            allowedFormats: 'jpg,png',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (String(url).includes('cloudinary.com')) {
        return new Response(
          JSON.stringify({
            secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/chat_attachments/photo.jpg',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (String(url).endsWith('/api/upload')) {
        return new Response(
          JSON.stringify({
            url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/chat_attachments/photo.jpg',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends visitor headers when visitorId and visitorToken are provided (signature: file, apiBase, auth)', async () => {
    const file = new File(['fake image data'], 'sample.png', { type: 'image/png' });
    const url = await uploadChatImage(file, 'https://myapi.test', {
      visitorId: 'vis-123',
      visitorToken: 'tok-abc',
    });

    expect(url).toContain('cloudinary.com');
    const signCall = fetchCalls.find((c) => c.url.includes('/api/upload/sign'));
    expect(signCall).toBeDefined();
    const headers = signCall!.options?.headers as Record<string, string>;
    expect(headers['x-zentry-visitor']).toBe('vis-123');
    expect(headers['x-zentry-visitor-token']).toBe('tok-abc');
  });

  it('sends visitor headers when visitorId and visitorToken are provided (signature: file, auth)', async () => {
    const file = new File(['fake image data'], 'sample.png', { type: 'image/png' });
    const url = await uploadChatImage(file, {
      visitorId: 'vis-456',
      visitorToken: 'tok-def',
    });

    expect(url).toContain('cloudinary.com');
    const signCall = fetchCalls.find((c) => c.url.includes('/api/upload/sign'));
    expect(signCall).toBeDefined();
    const headers = signCall!.options?.headers as Record<string, string>;
    expect(headers['x-zentry-visitor']).toBe('vis-456');
    expect(headers['x-zentry-visitor-token']).toBe('tok-def');
  });

  it('does not send visitor headers when auth is omitted (e.g. dashboard user)', async () => {
    const file = new File(['fake image data'], 'sample.png', { type: 'image/png' });
    const url = await uploadChatImage(file);

    expect(url).toContain('cloudinary.com');
    const signCall = fetchCalls.find((c) => c.url.includes('/api/upload/sign'));
    expect(signCall).toBeDefined();
    const headers = signCall!.options?.headers as Record<string, string>;
    expect(headers['x-zentry-visitor']).toBeUndefined();
    expect(headers['x-zentry-visitor-token']).toBeUndefined();
  });
});
