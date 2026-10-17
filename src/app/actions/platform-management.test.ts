import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

const fakeState = vi.hoisted(() => {
  const OWNER_ID = '11111111-1111-4111-8111-111111111111';
  const FINANCE_ID = '22222222-2222-4222-8222-222222222222';
  const SUPPORT_ID = '33333333-3333-4333-8333-333333333333';
  const REGULAR_USER_ID = '44444444-4444-4444-8444-444444444444';
  const WS_ID = 'ws-test-1111';

  return {
    OWNER_ID,
    FINANCE_ID,
    SUPPORT_ID,
    REGULAR_USER_ID,
    WS_ID,
    currentUser: { id: OWNER_ID, email: 'musmanrai372@gmail.com' } as any,
    currentAgent: {
      id: OWNER_ID,
      name: 'Owner Agent',
      email: 'musmanrai372@gmail.com',
      role: 'owner',
      workspace_id: null,
      is_active: true,
      is_super_admin: true,
      is_platform_owner: true,
      platform_staff_role: 'owner',
    } as any,
    workspaces: [
      {
        id: WS_ID,
        name: 'Acme Corp',
        is_suspended: false,
        is_abuse_flagged: false,
        is_outbound_blocked: false,
        scheduled_for_deletion_at: null,
        deletion_requested_at: null,
      },
    ] as any[],
    subscriptions: [
      {
        id: 'sub-1',
        workspace_id: WS_ID,
        status: 'active',
        billing_period: 'monthly',
        plan_id: 'plan-pro',
        failed_payment_count: 0,
        grace_period_ends_at: null,
        current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
      },
    ] as any[],
    invoices: [] as any[],
    supportSessions: [] as any[],
    featureFlags: [] as any[],
    announcements: [] as any[],
    blockedDomains: [] as any[],
    auditLogs: [] as any[],
    agents: [] as any[],
  };
});

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    set: vi.fn(),
    get: vi.fn((name: string) => {
      if (name === 'zentry_support_token' && fakeState.supportSessions.length > 0) {
        return { value: fakeState.supportSessions[0].session_token };
      }
      return undefined;
    }),
    delete: vi.fn(),
  })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => createMockSupabaseClient()),
}));

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: vi.fn(() => createMockSupabaseClient()),
  createServiceClient: vi.fn(() => createMockSupabaseClient()),
}));

function createMockSupabaseClient() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: fakeState.currentUser },
        error: fakeState.currentUser ? null : { message: 'Not authenticated' },
      })),
    },
    from: vi.fn((table: string) => {
      let isSingle = false;
      const filters: Array<{ op: string; args: any[] }> = [];
      let updatePayload: any = null;
      let insertPayload: any = null;
      let isDelete = false;

      const builder: any = {
        select: vi.fn(() => builder),
        delete: vi.fn(() => {
          isDelete = true;
          return builder;
        }),
        eq: vi.fn((col: string, val: any) => {
          filters.push({ op: 'eq', args: [col, val] });
          return builder;
        }),
        neq: vi.fn((col: string, val: any) => {
          filters.push({ op: 'neq', args: [col, val] });
          return builder;
        }),
        lte: vi.fn(() => builder),
        gte: vi.fn(() => builder),
        order: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        single: vi.fn(() => {
          isSingle = true;
          return builder;
        }),
        maybeSingle: vi.fn(() => {
          isSingle = true;
          return builder;
        }),
        update: vi.fn((data: any) => {
          updatePayload = data;
          return builder;
        }),
        insert: vi.fn((data: any) => {
          insertPayload = data;
          return builder;
        }),
        then: (resolve: any) => {
          let rows: any[] = [];
          if (table === 'agents') {
            rows = fakeState.agents;
            // If querying current agent
            const idFilter = filters.find((f) => f.args[0] === 'id');
            if (idFilter && idFilter.args[1] === fakeState.currentUser?.id) {
              return resolve({ data: isSingle ? fakeState.currentAgent : [fakeState.currentAgent], error: null });
            }
          } else if (table === 'workspaces') {
            rows = fakeState.workspaces;
          } else if (table === 'workspace_subscriptions') {
            rows = fakeState.subscriptions;
          } else if (table === 'workspace_invoices') {
            rows = fakeState.invoices;
          } else if (table === 'support_sessions') {
            rows = fakeState.supportSessions;
          } else if (table === 'platform_feature_flags') {
            rows = fakeState.featureFlags;
          } else if (table === 'platform_announcements') {
            rows = fakeState.announcements;
          } else if (table === 'platform_blocked_domains') {
            rows = fakeState.blockedDomains;
          } else if (table === 'super_admin_audit_logs') {
            rows = fakeState.auditLogs;
          } else if (table === 'platform_access') {
            const uid = filters.find((f) => f.args[0] === 'user_id')?.args[1];
            if (uid === fakeState.currentUser?.id && fakeState.currentAgent?.is_super_admin) {
              const accessRow = {
                id: `pa-${uid}`,
                user_id: uid,
                role: fakeState.currentAgent.is_platform_owner ? 'owner' : 'admin',
                granted_by: null,
                granted_at: new Date().toISOString(),
              };
              return resolve({ data: isSingle ? accessRow : [accessRow], error: null });
            }
            return resolve({ data: isSingle ? null : [], error: null });
          }

          if (insertPayload) {
            const inserted = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
            const stamped = inserted.map((item) => ({
              id: item.id || `gen-${Date.now()}-${Math.random().toString().slice(-4)}`,
              created_at: new Date().toISOString(),
              ...item,
            }));
            rows.push(...stamped);
            if (table === 'super_admin_audit_logs') {
              fakeState.auditLogs.push(...stamped);
            }
            return resolve({ data: isSingle ? stamped[0] : stamped, error: null });
          }

          if (updatePayload) {
            let matched = [...rows];
            for (const f of filters) {
              if (f.op === 'eq') matched = matched.filter((r) => r[f.args[0]] === f.args[1]);
            }
            matched.forEach((m) => Object.assign(m, updatePayload));
            return resolve({ data: isSingle ? matched[0] : matched, error: null });
          }

          if (isDelete) {
            const idFilter = filters.find((f) => f.args[0] === 'id');
            if (idFilter) {
              const idx = rows.findIndex((r) => r.id === idFilter.args[1]);
              if (idx !== -1) rows.splice(idx, 1);
            }
            return resolve({ data: null, error: null });
          }

          let matched = [...rows];
          for (const f of filters) {
            if (f.op === 'eq') matched = matched.filter((r) => r[f.args[0]] === f.args[1]);
          }
          return resolve({ data: isSingle ? (matched[0] || null) : matched, error: null });
        },
      };
      return builder;
    }),
  };
}

import {
  recordManualPaymentAction,
  getPlatformRevenueMetricsAction,
  startSupportSessionAction,
  endSupportSessionAction,
  savePlatformFeatureFlagAction,
  savePlatformAnnouncementAction,
  addBlockedDomainAction,
  scheduleWorkspaceDeletionAction,
  cancelWorkspaceDeletionAction,
  updatePlatformStaffRoleAction,
} from './platform-management';
import { LemonSqueezyBillingProvider } from '@/lib/billing/lemonsqueezy';

describe('Super Admin Platform Management & Billing System', () => {
  beforeEach(() => {
    fakeState.currentUser = { id: fakeState.OWNER_ID, email: 'musmanrai372@gmail.com' };
    fakeState.currentAgent = {
      id: fakeState.OWNER_ID,
      name: 'Owner Agent',
      email: 'musmanrai372@gmail.com',
      role: 'owner',
      workspace_id: null,
      is_active: true,
      is_super_admin: true,
      is_platform_owner: true,
      platform_staff_role: 'owner',
    };
    fakeState.invoices.length = 0;
    fakeState.supportSessions.length = 0;
    fakeState.blockedDomains.length = 0;
    fakeState.auditLogs.length = 0;
    fakeState.workspaces[0].is_suspended = false;
    fakeState.workspaces[0].scheduled_for_deletion_at = null;
    fakeState.subscriptions[0].status = 'active';
  });

  describe('1. Billing & Manual Payments', () => {
    it('allows recording a manual payment (bank wire) and extends subscription', async () => {
      const res = await recordManualPaymentAction({
        workspaceId: fakeState.WS_ID,
        amount: 250,
        currency: 'USD',
        paymentMethod: 'manual_bank_transfer',
        paymentReference: 'WIRE-OCT2026-9921',
        notes: 'Verified via Corporate Account',
        extendDays: 30,
      });

      expect(res.success).toBe(true);
      expect(fakeState.invoices.length).toBe(1);
      expect(fakeState.invoices[0].amount).toBe(250);
      expect(fakeState.invoices[0].payment_method).toBe('manual_bank_transfer');
      expect(fakeState.invoices[0].status).toBe('paid');
      expect(fakeState.subscriptions[0].status).toBe('active');
    });

    it('calculates platform revenue metrics (MRR, ARR)', async () => {
      const metrics = await getPlatformRevenueMetricsAction();
      expect(metrics).toHaveProperty('mrr');
      expect(metrics).toHaveProperty('arr');
      expect(metrics.arr).toBe(metrics.mrr * 12);
    });

    it('verifies Lemon Squeezy webhook signature correctly', () => {
      const secret = 'lemonsqueezy_test_webhook_secret_key_123';
      const rawBody = JSON.stringify({ meta: { event_name: 'subscription_payment_success' }, data: { id: 'sub_123' } });
      const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      const provider = new LemonSqueezyBillingProvider({ apiKey: 'test_api_key', webhookSecret: secret });
      const isValid = provider.verifyWebhookSignature(rawBody, signature);
      expect(isValid).toBe(true);

      const isInvalid = provider.verifyWebhookSignature(rawBody, 'tampered_signature_hex_value');
      expect(isInvalid).toBe(false);
    });
  });

  describe('2. Login as Workspace (Support Sessions)', () => {
    it('creates a support session with 1 hour expiration without exposing customer passwords', async () => {
      const res = await startSupportSessionAction({
        workspaceId: fakeState.WS_ID,
        reason: 'Customer requested configuration inspection',
      });

      expect(res.success).toBe(true);
      expect(res.session).toBeDefined();
      expect(res.session?.workspace_id).toBe(fakeState.WS_ID);
      expect(res.session?.admin_email).toBe('musmanrai372@gmail.com');
      expect(fakeState.supportSessions.length).toBe(1);

      // Verify expiration is ~1 hour from start
      const start = new Date(res.session!.started_at).getTime();
      const expiry = new Date(res.session!.expires_at).getTime();
      expect(expiry - start).toBe(60 * 60 * 1000);

      // Verify session termination
      const endRes = await endSupportSessionAction();
      expect(endRes.success).toBe(true);
      expect(fakeState.supportSessions[0].ended_at).toBeDefined();
    });
  });

  describe('3. Platform Staff RBAC Capabilities', () => {
    it('allows Finance staff to view revenue but blocks them from starting support sessions', async () => {
      // Switch user to Finance staff
      fakeState.currentUser = { id: fakeState.FINANCE_ID, email: 'finance@staff.test' };
      fakeState.currentAgent = {
        ...fakeState.currentAgent,
        id: fakeState.FINANCE_ID,
        email: 'finance@staff.test',
        is_platform_owner: false,
        platform_staff_role: 'finance',
      };

      // Allowed capability
      const metrics = await getPlatformRevenueMetricsAction();
      expect(metrics).toBeDefined();

      // Denied capability
      await expect(
        startSupportSessionAction({ workspaceId: fakeState.WS_ID, reason: 'Finance inspection' })
      ).rejects.toThrow(/Unauthorized|403/);
    });

    it('allows Support staff to start support sessions but blocks them from billing manual payments', async () => {
      // Switch user to Support staff
      fakeState.currentUser = { id: fakeState.SUPPORT_ID, email: 'support@staff.test' };
      fakeState.currentAgent = {
        ...fakeState.currentAgent,
        id: fakeState.SUPPORT_ID,
        email: 'support@staff.test',
        is_platform_owner: false,
        platform_staff_role: 'support',
      };

      // Allowed capability
      const session = await startSupportSessionAction({
        workspaceId: fakeState.WS_ID,
        reason: 'Customer support',
      });
      expect(session.success).toBe(true);

      // Denied capability
      await expect(
        recordManualPaymentAction({
          workspaceId: fakeState.WS_ID,
          amount: 100,
          paymentMethod: 'manual_crypto',
          paymentReference: '0xabc',
          extendDays: 30,
        })
      ).rejects.toThrow(/Unauthorized|403/);
    });

    it('rejects non-staff agents completely', async () => {
      fakeState.currentAgent = {
        id: fakeState.REGULAR_USER_ID,
        name: 'Regular Agent',
        email: 'user@tenant.com',
        role: 'agent',
        is_super_admin: false,
        is_platform_owner: false,
        platform_staff_role: null,
      };

      await expect(getPlatformRevenueMetricsAction()).rejects.toThrow(/Unauthorized|403/);
      await expect(
        startSupportSessionAction({ workspaceId: fakeState.WS_ID, reason: 'Hack attempt' })
      ).rejects.toThrow(/Unauthorized|403/);
    });
  });

  describe('4. Abuse, Safety & Blacklists', () => {
    it('adds and moderates blocked email domains', async () => {
      const res = await addBlockedDomainAction('scammer-domain.xyz', 'Phishing attempt');
      expect(res.success).toBe(true);
      expect(fakeState.blockedDomains.length).toBe(1);
      expect(fakeState.blockedDomains[0].domain).toBe('scammer-domain.xyz');
    });

    it('rejects invalid domain formats', async () => {
      const res = await addBlockedDomainAction('notadomain', 'Invalid');
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/valid domain/i);
    });
  });

  describe('5. Data Tools & 30-Day Delayed Deletion', () => {
    it('requires exact workspace name match to schedule deletion', async () => {
      const failRes = await scheduleWorkspaceDeletionAction({
        workspaceId: fakeState.WS_ID,
        confirmName: 'Wrong Name',
        reason: 'Closure',
      });
      expect(failRes.success).toBe(false);
      expect(failRes.error).toMatch(/does not match/i);
    });

    it('schedules workspace deletion with 30-day waiting period and immediate suspension', async () => {
      const res = await scheduleWorkspaceDeletionAction({
        workspaceId: fakeState.WS_ID,
        confirmName: 'Acme Corp',
        reason: 'Customer requested account closure',
      });

      expect(res.success).toBe(true);
      expect(res.scheduledDate).toBeDefined();
      expect(fakeState.workspaces[0].is_suspended).toBe(true);
      expect(fakeState.workspaces[0].scheduled_for_deletion_at).toBeDefined();

      // Can cancel during grace period
      const cancelRes = await cancelWorkspaceDeletionAction(fakeState.WS_ID);
      expect(cancelRes.success).toBe(true);
      expect(fakeState.workspaces[0].is_suspended).toBe(false);
      expect(fakeState.workspaces[0].scheduled_for_deletion_at).toBeNull();
    });
  });
});
