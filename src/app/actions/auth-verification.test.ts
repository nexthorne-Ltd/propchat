/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sendSignupVerificationCodeAction,
  verifySignupCodeAction,
} from './auth-verification';
import {
  generate6DigitCode,
  timingSafeCodeCheck,
} from '@/lib/auth/verification-code';

vi.mock('server-only', () => ({}));

// Mock dependencies
const mockServiceClient = vi.fn();
const mockSendSmtpEmail = vi.fn();

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => mockServiceClient(),
}));

vi.mock('@/lib/email/smtp', () => ({
  isValidEmail: (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
  sendSmtpEmail: (...args: any[]) => mockSendSmtpEmail(...args),
  verificationCodeEmail: vi.fn(() => ({
    subject: 'Verification Code',
    html: '<p>Code</p>',
    text: 'Code',
  })),
}));

describe('auth-verification action suite', () => {
  let fakeUsers: any[] = [];
  let fakeVerifications: any[] = [];
  let updateUserByIdSpy: any;
  let createUserSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeUsers = [];
    fakeVerifications = [];

    updateUserByIdSpy = vi.fn(async (id: string, attrs: any) => {
      const u = fakeUsers.find((x) => x.id === id);
      if (u) Object.assign(u, attrs);
      return { data: { user: u }, error: null };
    });

    createUserSpy = vi.fn(async (attrs: any) => {
      const exists = fakeUsers.find((x) => x.email.toLowerCase() === attrs.email.toLowerCase());
      if (exists) {
        return { data: null, error: { message: 'User already registered' } };
      }
      const newUser = { id: 'user-' + Math.random(), ...attrs };
      fakeUsers.push(newUser);
      return { data: { user: newUser }, error: null };
    });

    // Mock Supabase admin client
    mockServiceClient.mockReturnValue({
      auth: {
        admin: {
          listUsers: vi.fn(async ({ page = 1, perPage = 1000 } = {}) => {
            const start = (page - 1) * perPage;
            const users = fakeUsers.slice(start, start + perPage);
            return { data: { users }, error: null };
          }),
          updateUserById: updateUserByIdSpy,
          createUser: createUserSpy,
        },
      },
      from: vi.fn((table: string) => {
        if (table === 'email_verifications') {
          return {
            select: vi.fn(() => {
              let rows = [...fakeVerifications];
              const queryObj: any = {
                eq: vi.fn((col: string, val: any) => {
                  rows = rows.filter((r) => r[col] === val);
                  return queryObj;
                }),
                gte: vi.fn((col: string, val: any) => {
                  rows = rows.filter((r) => new Date(r[col]).getTime() >= new Date(val).getTime());
                  return queryObj;
                }),
                gt: vi.fn((col: string, val: any) => {
                  rows = rows.filter((r) => new Date(r[col]).getTime() > new Date(val).getTime());
                  return queryObj;
                }),
                order: vi.fn((col: string, { ascending }: { ascending: boolean }) => {
                  rows.sort((a, b) => {
                    const diff = new Date(a[col]).getTime() - new Date(b[col]).getTime();
                    return ascending ? diff : -diff;
                  });
                  return queryObj;
                }),
                limit: vi.fn((n: number) => {
                  rows = rows.slice(0, n);
                  return queryObj;
                }),
                maybeSingle: vi.fn(async () => ({
                  data: rows[0] || null,
                  error: null,
                })),
                then: (resolve: any) => resolve({ data: rows, error: null }),
              };
              return queryObj;
            }),
            insert: vi.fn(async (row: any) => {
              const newRecord = {
                id: 'ev-' + Math.random(),
                created_at: new Date().toISOString(),
                attempts: 0,
                locked_until: null,
                ...row,
              };
              fakeVerifications.push(newRecord);
              return { data: newRecord, error: null };
            }),
            update: vi.fn((updates: any) => ({
              eq: vi.fn(async (col: string, val: any) => {
                const targets = fakeVerifications.filter((r) => r[col] === val);
                targets.forEach((r) => Object.assign(r, updates));
                return { data: targets, error: null };
              }),
            })),
            delete: vi.fn(() => {
              const delObj: any = {
                eq: vi.fn((col: string, val: any) => {
                  fakeVerifications = fakeVerifications.filter((r) => r[col] !== val);
                  return delObj;
                }),
                lt: vi.fn((col: string, val: any) => {
                  fakeVerifications = fakeVerifications.filter(
                    (r) => new Date(r[col]).getTime() >= new Date(val).getTime()
                  );
                  return delObj;
                }),
                then: (resolve: any) => resolve({ error: null }),
              };
              return delObj;
            }),
          };
        }

        if (table === 'platform_settings') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: {
                    smtp_settings: {
                      host: 'smtp.test.com',
                      port: 587,
                      user: 'support@test.com',
                      pass: 'secret',
                      enabled: true,
                    },
                  },
                  error: null,
                })),
              })),
            })),
          };
        }

        return {} as any;
      }),
      rpc: vi.fn(async () => ({ data: true, error: null })),
    });

    mockSendSmtpEmail.mockResolvedValue({ success: true });
  });

  // 1. Code is 6 digits
  it('generates a 6-digit code with crypto.randomInt', () => {
    for (let i = 0; i < 50; i++) {
      const code = generate6DigitCode();
      expect(code).toMatch(/^\d{6}$/);
      const num = parseInt(code, 10);
      expect(num).toBeGreaterThanOrEqual(100000);
      expect(num).toBeLessThan(1000000);
    }
  });

  // 2. Existing account handling:
  // Unconfirmed account sends code and never calls updateUserById with password or createUser.
  it('resend / send for an unconfirmed account sends a code and never calls updateUserById with a password', async () => {
    fakeUsers.push({
      id: 'existing-unconfirmed-id',
      email: 'agent@victim.test',
      email_confirmed_at: null,
      user_metadata: { name: 'Victim' },
    });

    const res = await sendSignupVerificationCodeAction({
      email: 'agent@victim.test',
      name: 'Victim',
      password: 'new-password-attempt-123',
    });

    expect(res.success).toBe(true);
    expect(res.email).toBe('agent@victim.test');
    // Ensure createUser was not called
    expect(createUserSpy).not.toHaveBeenCalled();
    // Ensure updateUserById was never called with a password
    expect(updateUserByIdSpy).not.toHaveBeenCalled();
    // Ensure verification code was stored in email_verifications and email sent
    expect(fakeVerifications.length).toBe(1);
    expect(mockSendSmtpEmail).toHaveBeenCalled();
  });

  // Confirmed account is refused without any updateUserById or createUser call
  it('refuses confirmed existing account without calling updateUserById or createUser', async () => {
    fakeUsers.push({
      id: 'existing-confirmed-id',
      email: 'owner@victim.test',
      email_confirmed_at: new Date().toISOString(),
      user_metadata: { name: 'Victim Owner' },
    });

    const res = await sendSignupVerificationCodeAction({
      email: 'owner@victim.test',
      name: 'Attacker',
      password: 'new-password-123',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('An account with this email already exists');
    expect(updateUserByIdSpy).not.toHaveBeenCalled();
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  // 3. Brute force: after 5 wrong attempts, locked for 15 minutes; the 6th wrong attempt is locked
  it('locks for 15 minutes after 5 wrong tries; the 6th wrong attempt is locked', async () => {
    fakeVerifications.push({
      id: 'ev-test',
      email: 'user@test.com',
      code: '654321',
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      attempts: 0,
      locked_until: null,
      created_at: new Date().toISOString(),
    });

    // 1st wrong attempt
    let res = await verifySignupCodeAction({ email: 'user@test.com', code: '000001' });
    expect(res.success).toBe(false);
    expect(fakeVerifications[0].attempts).toBe(1);
    expect(res.error).toContain('Invalid or expired verification code');

    // 2nd wrong attempt
    res = await verifySignupCodeAction({ email: 'user@test.com', code: '000002' });
    expect(res.success).toBe(false);
    expect(fakeVerifications[0].attempts).toBe(2);

    // 3rd wrong attempt
    res = await verifySignupCodeAction({ email: 'user@test.com', code: '000003' });
    expect(res.success).toBe(false);
    expect(fakeVerifications[0].attempts).toBe(3);

    // 4th wrong attempt
    res = await verifySignupCodeAction({ email: 'user@test.com', code: '000004' });
    expect(res.success).toBe(false);
    expect(fakeVerifications[0].attempts).toBe(4);

    // 5th wrong attempt -> triggers 15 minute lock
    res = await verifySignupCodeAction({ email: 'user@test.com', code: '000005' });
    expect(res.success).toBe(false);
    expect(fakeVerifications[0].attempts).toBe(5);
    expect(fakeVerifications[0].locked_until).not.toBeNull();
    expect(res.error).toContain('locked for 15 minutes');

    // 6th attempt -> immediately locked, even with correct code!
    res = await verifySignupCodeAction({ email: 'user@test.com', code: '654321' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('locked for 15 minutes');
  });

  // 4. Resend throttle works (1 per 60s, 5 per hour)
  it('throttles resending within 60 seconds', async () => {
    // 1st send succeeds
    const res1 = await sendSignupVerificationCodeAction({
      email: 'newuser@test.com',
      name: 'New User',
    });
    expect(res1.success).toBe(true);

    // Immediate second send fails (within 60s)
    const res2 = await sendSignupVerificationCodeAction({
      email: 'newuser@test.com',
      name: 'New User',
    });
    expect(res2.success).toBe(false);
    expect(res2.error).toMatch(/wait \d+ seconds/i);
  });

  it('limits sending to at most 5 codes per hour', async () => {
    const baseTime = Date.now() - 50 * 60 * 1000; // 50 mins ago
    // Seed 5 codes in the past hour
    for (let i = 0; i < 5; i++) {
      fakeVerifications.push({
        id: `ev-old-${i}`,
        email: 'limituser@test.com',
        code: `10000${i}`,
        created_at: new Date(baseTime + i * 2 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        attempts: 0,
        locked_until: null,
      });
    }

    // 6th request within the hour should be blocked
    const res = await sendSignupVerificationCodeAction({
      email: 'limituser@test.com',
      name: 'Limit User',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Too many verification codes requested');
  });

  // 5. Timing-safe comparison check
  it('timingSafeCodeCheck securely verifies matching codes', () => {
    expect(timingSafeCodeCheck('123456', '123456')).toBe(true);
    expect(timingSafeCodeCheck('123456', '123457')).toBe(false);
    expect(timingSafeCodeCheck('12345', '123456')).toBe(false);
    expect(timingSafeCodeCheck('', '123456')).toBe(false);
  });

  // 6. Fail closed: if email cannot be sent, return an error
  it('fails closed when SMTP delivery fails', async () => {
    mockSendSmtpEmail.mockResolvedValueOnce({
      success: false,
      error: 'SMTP connection refused',
    });

    const res = await sendSignupVerificationCodeAction({
      email: 'test@failclosed.com',
      name: 'Fail User',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('SMTP connection refused');
  });

  // 7. Successful verification activates user and resets count
  it('activates user on correct code and removes verification row', async () => {
    fakeUsers.push({
      id: 'target-user-id',
      email: 'success@test.com',
      email_confirm: false,
    });

    fakeVerifications.push({
      id: 'ev-success',
      email: 'success@test.com',
      code: '789123',
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      attempts: 2,
      locked_until: null,
      created_at: new Date().toISOString(),
    });

    const res = await verifySignupCodeAction({
      email: 'success@test.com',
      code: '789123',
    });

    expect(res.success).toBe(true);
    expect(updateUserByIdSpy).toHaveBeenCalledWith('target-user-id', { email_confirm: true });
    expect(fakeVerifications.length).toBe(0);
  });

  // 8. IP rate limiting (10 an hour per IP)
  it('enforces IP rate limiting (10 per hour)', async () => {
    mockServiceClient.mockReturnValue({
      auth: {
        admin: {
          listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
          updateUserById: updateUserByIdSpy,
          createUser: createUserSpy,
        },
      },
      from: vi.fn(() => ({}) as any),
      rpc: vi.fn(async () => ({ data: false, error: null })),
    });

    const res = await sendSignupVerificationCodeAction({
      email: 'rate-limit@ip.com',
      name: 'Rate Limited IP User',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('Too many verification codes requested from this IP');
  });
});
