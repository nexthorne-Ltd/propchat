import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  guardMemberResult: { ok: false } as any,
  verifyVisitorResult: null as { visitorId: string; workspaceId: string | null } | null,
}));

vi.mock('@/lib/team/route-guard', () => ({
  guardMember: vi.fn(async () => mocks.guardMemberResult),
}));

vi.mock('@/lib/widget/visitor-token', () => ({
  verifyVisitorToken: vi.fn(async (_id: unknown, _token: unknown) => mocks.verifyVisitorResult),
}));

vi.mock('@/lib/cloudinary', () => ({
  isCloudinaryConfigured: () => true,
  uploadToCloudinary: async () => ({
    secure_url: 'https://res.cloudinary.com/test/image/upload/v1234/chat_attachments/test.jpg',
    public_id: 'chat_attachments/test',
    bytes: 1024,
    width: 200,
    height: 200,
  }),
}));

import { OPTIONS as signOptions, POST as signPost } from './sign/route';
import { OPTIONS as uploadOptions, POST as uploadPost } from './route';

describe('M-15b Upload Routes Authorization and CORS', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
    process.env.CLOUDINARY_API_KEY = 'demo-key';
    process.env.CLOUDINARY_API_SECRET = 'demo-secret';
    mocks.guardMemberResult = { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    mocks.verifyVisitorResult = null;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  describe('CORS and OPTIONS preflight', () => {
    it('/api/upload/sign OPTIONS returns 204 with visitor headers allowed', async () => {
      const res = await signOptions();
      expect(res.status).toBe(204);
      const allowHeaders = res.headers.get('Access-Control-Allow-Headers') || '';
      expect(allowHeaders).toContain('x-zentry-visitor');
      expect(allowHeaders).toContain('x-zentry-visitor-token');
    });

    it('/api/upload OPTIONS returns 204 with visitor headers allowed', async () => {
      const res = await uploadOptions();
      expect(res.status).toBe(204);
      const allowHeaders = res.headers.get('Access-Control-Allow-Headers') || '';
      expect(allowHeaders).toContain('x-zentry-visitor');
      expect(allowHeaders).toContain('x-zentry-visitor-token');
    });
  });

  describe('/api/upload/sign authorization matrix', () => {
    it('no auth → 401', async () => {
      mocks.guardMemberResult = { ok: false };
      mocks.verifyVisitorResult = null;

      const req = new Request('http://localhost/api/upload/sign', { method: 'POST' });
      const res = await signPost(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('wrong visitor token → 401', async () => {
      mocks.guardMemberResult = { ok: false };
      mocks.verifyVisitorResult = null; // Token verification failed

      const req = new Request('http://localhost/api/upload/sign', {
        method: 'POST',
        headers: {
          'x-zentry-visitor': 'visitor-uuid-1234',
          'x-zentry-visitor-token': 'wrong-token-value',
        },
      });
      const res = await signPost(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('valid visitor → allowed', async () => {
      mocks.guardMemberResult = { ok: false };
      mocks.verifyVisitorResult = { visitorId: 'visitor-uuid-1234', workspaceId: 'ws-1' };

      const req = new Request('http://localhost/api/upload/sign', {
        method: 'POST',
        headers: {
          'x-zentry-visitor': 'visitor-uuid-1234',
          'x-zentry-visitor-token': 'valid-session-token-64chars',
        },
      });
      const res = await signPost(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.signature).toBeDefined();
      expect(body.apiKey).toBe('demo-key');
      expect(body.cloudName).toBe('demo-cloud');
    });

    it('member → allowed', async () => {
      mocks.guardMemberResult = { ok: true, access: { user: { id: 'agent-1' } } };
      mocks.verifyVisitorResult = null;

      const req = new Request('http://localhost/api/upload/sign', { method: 'POST' });
      const res = await signPost(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.signature).toBeDefined();
    });
  });

  describe('/api/upload authorization matrix', () => {
    function makeUploadRequest(headers: Record<string, string> = {}) {
      const formData = new FormData();
      const file = new File(['dummy image content'], 'photo.jpg', { type: 'image/jpeg' });
      formData.append('file', file);
      return new NextRequest('http://localhost/api/upload', {
        method: 'POST',
        headers,
        body: formData,
      });
    }

    it('no auth → 401', async () => {
      mocks.guardMemberResult = { ok: false };
      mocks.verifyVisitorResult = null;

      const req = makeUploadRequest();
      const res = await uploadPost(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('wrong visitor token → 401', async () => {
      mocks.guardMemberResult = { ok: false };
      mocks.verifyVisitorResult = null;

      const req = makeUploadRequest({
        'x-zentry-visitor': 'visitor-uuid-1234',
        'x-zentry-visitor-token': 'wrong-token',
      });
      const res = await uploadPost(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('valid visitor → allowed', async () => {
      mocks.guardMemberResult = { ok: false };
      mocks.verifyVisitorResult = { visitorId: 'visitor-uuid-1234', workspaceId: 'ws-1' };

      const req = makeUploadRequest({
        'x-zentry-visitor': 'visitor-uuid-1234',
        'x-zentry-visitor-token': 'valid-session-token-64chars',
      });
      const res = await uploadPost(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toContain('https://res.cloudinary.com');
    });

    it('member → allowed', async () => {
      mocks.guardMemberResult = { ok: true, access: { user: { id: 'agent-1' } } };
      mocks.verifyVisitorResult = null;

      const req = makeUploadRequest();
      const res = await uploadPost(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toContain('https://res.cloudinary.com');
    });
  });
});
