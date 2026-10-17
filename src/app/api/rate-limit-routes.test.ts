import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock rate limiting helper
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
}));

// Mock geo helpers
vi.mock('@/lib/geo', () => ({
  clientIpOf: vi.fn(() => '198.51.100.42'),
  geoFromRequest: vi.fn(async () => ({ city: 'New York', country: 'United States', countryCode: 'US' })),
}));

// Mock supabase service
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  })),
}));

// Mock route-guard
vi.mock('@/lib/team/route-guard', () => ({
  guardMember: vi.fn(async () => ({ ok: true, member: { role: 'agent' } })),
}));

import { checkRateLimit } from '@/lib/rate-limit';
import { POST as trackingPost } from '@/app/api/tracking/route';
import { POST as geoPost } from '@/app/api/visitor/geo/route';
import { GET as csatGet, POST as csatPost } from '@/app/api/csat/rate/route';
import { POST as uploadPost } from '@/app/api/upload/route';
import { POST as uploadSignPost } from '@/app/api/upload/sign/route';
import { POST as autoRespondPost } from '@/app/api/ai/auto-respond/route';

const makeRequest = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.42',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

describe('Rate limited API routes (HTTP 429)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('/api/tracking returns 429 with CORS headers when over limit', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);

    const req = makeRequest('http://localhost/api/tracking', { event: 'heartbeat', visitor_id: 'v1' });
    const res = await trackingPost(req);

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toEqual({ error: 'rate_limited' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(checkRateLimit).toHaveBeenCalledWith('tracking:198.51.100.42', 60, 60);
  });

  it('/api/visitor/geo returns 429 with CORS headers when over limit', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);

    const req = makeRequest('http://localhost/api/visitor/geo', { visitor_id: 'v1' });
    const res = await geoPost(req);

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toEqual({ error: 'rate_limited' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(checkRateLimit).toHaveBeenCalledWith('geo:198.51.100.42', 60, 60);
  });

  it('/api/csat/rate returns 429 on GET and POST when over limit', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);

    const getReq = makeRequest('http://localhost/api/csat/rate?ticket_id=t1');
    const getRes = await csatGet(getReq);

    expect(getRes.status).toBe(429);
    expect(await getRes.json()).toEqual({ error: 'rate_limited' });
    expect(getRes.headers.get('access-control-allow-origin')).toBe('*');
    expect(checkRateLimit).toHaveBeenCalledWith('csat:198.51.100.42', 60, 60);

    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);
    const postReq = makeRequest('http://localhost/api/csat/rate', { rating: 'good' });
    const postRes = await csatPost(postReq);

    expect(postRes.status).toBe(429);
    expect(await postRes.json()).toEqual({ error: 'rate_limited' });
    expect(postRes.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('/api/upload and /api/upload/sign return 429 when over limit', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);

    const uploadReq = makeRequest('http://localhost/api/upload', {});
    const uploadRes = await uploadPost(uploadReq);

    expect(uploadRes.status).toBe(429);
    expect(await uploadRes.json()).toEqual({ error: 'rate_limited' });
    expect(uploadRes.headers.get('access-control-allow-origin')).toBe('*');
    expect(checkRateLimit).toHaveBeenCalledWith('upload:198.51.100.42', 60, 60);

    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);

    const signReq = makeRequest('http://localhost/api/upload/sign', {});
    const signRes = await uploadSignPost(signReq);

    expect(signRes.status).toBe(429);
    expect(await signRes.json()).toEqual({ error: 'rate_limited' });
    expect(signRes.headers.get('access-control-allow-origin')).toBe('*');
    expect(checkRateLimit).toHaveBeenCalledWith('upload_sign:198.51.100.42', 60, 60);
  });

  it('/api/ai/auto-respond returns 429 per conversation when over limit', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);

    const convId = 'conv-rate-limit-123';
    const req = makeRequest('http://localhost/api/ai/auto-respond', {
      conversation_id: convId,
      workspace_id: 'ws-123',
    });
    const res = await autoRespondPost(req);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(checkRateLimit).toHaveBeenCalledWith(`auto_respond:${convId}`, 30, 60);
  });
});
