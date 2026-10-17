import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/app/actions/invite', () => ({
  acceptInvitationAction: vi.fn(async (input: { token: string; name: string; password?: string }) => {
    if (input.token === 'valid-token') {
      return { success: true, email: 'agent@example.com', needsSignIn: true };
    }
    return { success: false, error: 'This invitation is not valid.' };
  }),
}));

import { POST } from './route';
import { acceptInvitationAction } from '@/app/actions/invite';

describe('POST /api/invite/accept', () => {
  it('returns 400 when token is missing', async () => {
    const req = new NextRequest('http://localhost:3000/api/invite/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hassan', password: 'password123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe('Invitation token is missing.');
  });

  it('delegates to acceptInvitationAction and returns JSON', async () => {
    const req = new NextRequest('http://localhost:3000/api/invite/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'valid-token', name: 'Hassan', password: 'password123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.email).toBe('agent@example.com');
    expect(data.needsSignIn).toBe(true);
    expect(acceptInvitationAction).toHaveBeenCalledWith({
      token: 'valid-token',
      name: 'Hassan',
      password: 'password123',
    });
  });

  it('returns structured failure when invitation is invalid', async () => {
    const req = new NextRequest('http://localhost:3000/api/invite/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'bad-token', name: 'Hassan', password: 'password123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe('This invitation is not valid.');
  });
});
