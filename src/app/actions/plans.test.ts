import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkWorkspaceLimit,
  assertWorkspaceLimit,
  checkWorkspaceFeature,
  assertWorkspaceFeature,
  getWorkspaceEffectivePlan,
  getWorkspaceCurrentUsage,
  incrementWorkspaceUsage,
} from '@/lib/plans/enforce';
import {
  getPlatformPlansAction,
  savePlanAction,
  duplicatePlanAction,
  archivePlanAction,
  validateCouponAction,
  applyCouponToWorkspaceAction,
  getPlatformCouponsAction,
  saveCouponAction,
  deleteCouponAction,
  updateWorkspaceSubscriptionAction,
  getWorkspaceBillingAndUsageAction,
} from './plans';

const SUPER_ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const NORMAL_USER_ID = '22222222-2222-4222-8222-222222222222';
const WS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// In-memory test state
const fakeDb = vi.hoisted(() => ({
  currentUser: null as any,
  currentAgent: null as any,
  workspaces: [] as any[],
  plans: [] as any[],
  planVersions: [] as any[],
  subscriptions: [] as any[],
  coupons: [] as any[],
  usage: [] as any[],
  agents: [] as any[],
  channels: [] as any[],
  articles: [] as any[],
  automations: [] as any[],
  tickets: [] as any[],
}));

// Mock server-only, next/headers and next/cache
vi.mock('server-only', () => ({}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({
    getAll: () => [],
    set: () => {},
  })),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// Mock @/lib/supabase/server, client, and service
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => createMockSupabase(),
  createServiceClient: () => createMockSupabase(),
}));

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => createMockSupabase(),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => createMockSupabase(),
}));

function createMockSupabase() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: fakeDb.currentUser },
        error: fakeDb.currentUser ? null : { message: 'Not authenticated' },
      }),
    },
    from: (table: string) => {
      let filters: Array<{ op: string; col: string; val: any }> = [];
      let isSingle = false;
      let isMaybeSingle = false;
      let isCount = false;
      let orderCol: string | null = null;
      let updatePayload: any = null;
      let insertPayload: any = null;

      const builder: any = {
        select: vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.count) isCount = true;
          return builder;
        }),
        eq: vi.fn((col: string, val: any) => {
          filters.push({ op: 'eq', col, val });
          return builder;
        }),
        neq: vi.fn((col: string, val: any) => {
          filters.push({ op: 'neq', col, val });
          return builder;
        }),
        gte: vi.fn((col: string, val: any) => {
          filters.push({ op: 'gte', col, val });
          return builder;
        }),
        lte: vi.fn((col: string, val: any) => {
          filters.push({ op: 'lte', col, val });
          return builder;
        }),
        is: vi.fn((col: string, val: any) => {
          filters.push({ op: 'is', col, val });
          return builder;
        }),
        order: vi.fn((col: string) => {
          orderCol = col;
          return builder;
        }),
        limit: vi.fn(() => builder),
        single: vi.fn(() => {
          isSingle = true;
          return builder;
        }),
        maybeSingle: vi.fn(() => {
          isMaybeSingle = true;
          return builder;
        }),
        update: vi.fn((payload: any) => {
          updatePayload = payload;
          return builder;
        }),
        insert: vi.fn((payload: any) => {
          insertPayload = payload;
          return builder;
        }),
        delete: vi.fn(() => {
          const matchIdx = getDataset(table).findIndex((item: any) =>
            filters.every((f) => item[f.col] === f.val)
          );
          if (matchIdx !== -1) {
            getDataset(table).splice(matchIdx, 1);
          }
          return builder;
        }),
        then: (resolve: (v: any) => any) => {
          const dataset = getDataset(table);

          if (insertPayload) {
            const records = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
            const created = records.map((r) => ({
              ...r,
              id: r.id || `mock-${Date.now()}-${Math.random()}`,
              created_at: r.created_at || new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }));
            dataset.push(...created);
            return resolve({
              data: isSingle ? created[0] : created,
              error: null,
            });
          }

          if (updatePayload) {
            const matches = dataset.filter((item: any) =>
              filters.every((f) => item[f.col] === f.val)
            );
            matches.forEach((item: any) => Object.assign(item, updatePayload));
            return resolve({
              data: isSingle ? matches[0] || null : matches,
              error: null,
            });
          }

          // Query handling
          let results = dataset.filter((item: any) => {
            return filters.every((f) => {
              if (f.op === 'eq') return item[f.col] === f.val;
              if (f.op === 'neq') return item[f.col] !== f.val;
              if (f.op === 'is') return item[f.col] === f.val;
              if (f.op === 'gte') {
                const itemTime = new Date(item[f.col]).getTime();
                const targetTime = new Date(f.val).getTime();
                return itemTime >= targetTime;
              }
              if (f.op === 'lte') {
                const itemTime = new Date(item[f.col]).getTime();
                const targetTime = new Date(f.val).getTime();
                return itemTime <= targetTime;
              }
              return true;
            });
          });

          if (orderCol) {
            results = [...results].sort((a, b) =>
              (a[orderCol!] > b[orderCol!] ? 1 : -1)
            );
          }

          if (isSingle) {
            return resolve({
              data: results[0] || null,
              count: results.length,
              error: results[0] ? null : { message: 'Not found' },
            });
          }
          if (isMaybeSingle) {
            return resolve({
              data: results[0] || null,
              count: results.length,
              error: null,
            });
          }

          return resolve({
            data: results,
            count: results.length,
            error: null,
          });
        },
      };

      return builder;
    },
  };
}

function getDataset(table: string): any[] {
  switch (table) {
    case 'workspaces':
      return fakeDb.workspaces;
    case 'platform_plans':
      return fakeDb.plans;
    case 'platform_plan_versions':
      return fakeDb.planVersions;
    case 'workspace_subscriptions':
      return fakeDb.subscriptions;
    case 'platform_coupons':
      return fakeDb.coupons;
    case 'workspace_usage':
      return fakeDb.usage;
    case 'agents':
      return fakeDb.agents;
    case 'channel_connections':
      return fakeDb.channels;
    case 'helpdesk_articles':
      return fakeDb.articles;
    case 'automation_rules':
      return fakeDb.automations;
    case 'tickets':
      return fakeDb.tickets;
    case 'platform_access':
      if (fakeDb.currentAgent && fakeDb.currentAgent.is_super_admin) {
        return [{
          id: `pa-${fakeDb.currentAgent.id}`,
          user_id: fakeDb.currentAgent.id,
          role: fakeDb.currentAgent.is_platform_owner ? 'owner' : 'admin',
          granted_by: null,
          granted_at: new Date().toISOString(),
        }];
      }
      return [];
    default:
      return [];
  }
}

describe('Plans & Platform Pricing System', () => {
  const superAdminUser = { id: SUPER_ADMIN_ID, email: 'musmanrai372@gmail.com' };
  const superAdminAgent = {
    id: SUPER_ADMIN_ID,
    email: 'musmanrai372@gmail.com',
    name: 'Platform Owner',
    role: 'owner',
    workspace_id: WS_ID,
    is_active: true,
    is_super_admin: true,
    is_platform_owner: true,
  };

  const normalUser = { id: NORMAL_USER_ID, email: 'client@company.com' };
  const normalAgent = {
    id: NORMAL_USER_ID,
    email: 'client@company.com',
    name: 'Normal User',
    role: 'agent',
    workspace_id: WS_ID,
    is_active: true,
    is_super_admin: false,
    is_platform_owner: false,
  };

  const testPlan = {
    id: 'plan-starter',
    name: 'Starter Tier',
    slug: 'starter',
    description: 'Perfect for small teams',
    monthly_price: 29,
    yearly_price: 290,
    currency: 'USD',
    trial_days: 14,
    visibility: 'public',
    is_popular: false,
    is_default: true,
    is_archived: false,
    sort_order: 1,
    version: 1,
    max_agents: 3,
    max_tickets_per_month: 100,
    max_ai_bot_replies_per_month: 200,
    max_channels_connected: 2,
    max_articles: 10,
    max_automations: 5,
    max_storage_mb: 1000,
    max_api_requests_per_month: 5000,
    features: {
      channel_email: true,
      channel_whatsapp: false,
      channel_instagram: false,
      channel_x: false,
      channel_linkedin: false,
      channel_tiktok: false,
      channel_threads: false,
      ai_bot: true,
      sla: false,
      macros: true,
      automations: false,
      csat_reports: false,
      custom_help_center_domain: false,
      visitor_tracking: false,
      roles_groups: false,
      remove_branding: false,
      api_webhooks: false,
    },
  };

  const testPlanVersion = {
    id: 'version-starter-v1',
    plan_id: 'plan-starter',
    version: 1,
    monthly_price: 29,
    yearly_price: 290,
    currency: 'USD',
    max_agents: 3,
    max_tickets_per_month: 100,
    max_ai_bot_replies_per_month: 200,
    max_channels_connected: 2,
    max_articles: 10,
    max_automations: 5,
    max_storage_mb: 1000,
    max_api_requests_per_month: 5000,
    features: testPlan.features,
  };

  beforeEach(() => {
    fakeDb.currentUser = { ...superAdminUser };
    fakeDb.currentAgent = { ...superAdminAgent };
    fakeDb.workspaces = [
      {
        id: WS_ID,
        owner_id: SUPER_ADMIN_ID,
        name: 'Acme Test WS',
        plan: 'starter',
      },
    ];
    fakeDb.plans = [{ ...testPlan }];
    fakeDb.planVersions = [{ ...testPlanVersion }];
    fakeDb.subscriptions = [
      {
        id: 'sub-1',
        workspace_id: WS_ID,
        plan_id: 'plan-starter',
        plan_version: 1,
        status: 'active',
        billing_period: 'monthly',
        current_period_start: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        current_period_end: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
        trial_ends_at: null,
        custom_limits: {},
        custom_features: {},
        admin_note: null,
        discount_percent: null,
        applied_coupon_code: null,
      },
    ];
    fakeDb.coupons = [];
    fakeDb.usage = [];
    fakeDb.agents = [
      { ...superAdminAgent },
      { id: 'ag-extra-1', workspace_id: WS_ID, is_active: true },
    ];
    fakeDb.channels = [{ id: 'ch-1', workspace_id: WS_ID, status: 'connected' }];
    fakeDb.articles = [{ id: 'art-1', workspace_id: WS_ID, status: 'published' }];
    fakeDb.automations = [];
    fakeDb.tickets = [];
  });

  describe('1. Server Authorization & Access Control', () => {
    it('denies unauthenticated requests to platform plan management', async () => {
      fakeDb.currentUser = null;
      fakeDb.currentAgent = null;

      await expect(getPlatformPlansAction()).rejects.toThrow(/Authentication required|Not authenticated/i);
    });

    it('denies regular workspace agents from managing platform plans (403 Forbidden)', async () => {
      fakeDb.currentUser = { ...normalUser };
      fakeDb.currentAgent = { ...normalAgent };
      fakeDb.agents = [{ ...normalAgent }];

      await expect(
        savePlanAction({
          name: 'Hacked Plan',
          slug: 'hacked',
          description: 'bad',
          monthly_price: 0,
          yearly_price: 0,
          currency: 'USD',
          trial_days: 0,
          visibility: 'public',
          is_popular: false,
          is_default: false,
          max_agents: null,
          max_tickets_per_month: null,
          max_ai_bot_replies_per_month: null,
          max_channels_connected: null,
          max_articles: null,
          max_automations: null,
          max_storage_mb: null,
          max_api_requests_per_month: null,
          features: {} as any,
        })
      ).rejects.toThrow(/Platform super admin privileges required|Only platform owners/i);
    });

    it('denies regular workspace agents from creating coupons', async () => {
      fakeDb.currentUser = { ...normalUser };
      fakeDb.currentAgent = { ...normalAgent };
      fakeDb.agents = [{ ...normalAgent }];

      await expect(
        saveCouponAction({
          code: 'FREE100',
          discount_type: 'percentage',
          discount_value: 100,
          is_active: true,
        })
      ).rejects.toThrow(/Platform super admin privileges required|Only platform owners/i);
    });

    it('allows verified platform owner to view and manage plans', async () => {
      fakeDb.currentUser = { ...superAdminUser };
      fakeDb.currentAgent = { ...superAdminAgent };

      const { plans } = await getPlatformPlansAction();
      expect(plans.length).toBeGreaterThan(0);
      expect(plans[0].name).toBe('Starter Tier');
    });
  });

  describe('2. Resource Limit Enforcement & 80% Usage Warnings', () => {
    it('allows resource usage when well under the limit (<80%)', async () => {
      // 2 agents out of 3 (66.6% -> under 80%)
      const check = await checkWorkspaceLimit(WS_ID, 'max_agents');
      expect(check.allowed).toBe(true);
      expect(check.currentUsage).toBe(2);
      expect(check.limit).toBe(3);
      expect(check.isNearLimit).toBe(false);
    });

    it('triggers a warning advisory when usage reaches or exceeds 80%', async () => {
      // Add tickets to reach 85 out of 100 (85%)
      for (let i = 0; i < 85; i++) {
        fakeDb.tickets.push({
          id: `tk-${i}`,
          workspace_id: WS_ID,
          created_at: new Date().toISOString(),
        });
      }

      const check = await checkWorkspaceLimit(WS_ID, 'max_tickets_per_month');
      expect(check.allowed).toBe(true);
      expect(check.isNearLimit).toBe(true);
      expect(check.percentage).toBe(85);
      expect(check.warningMessage).toContain('Approaching plan limit');
    });

    it('blocks action and throws clear upgrade message when limit is reached', async () => {
      // 2 agents in DB. With increment 2, projectedUsage = 4 > limit 3
      const check = await checkWorkspaceLimit(WS_ID, 'max_agents', 2);
      expect(check.allowed).toBe(false);
      expect(check.upgradeMessage).toContain('Upgrade your plan to increase capacity');

      // assertWorkspaceLimit must throw a friendly upgrade message
      await expect(assertWorkspaceLimit(WS_ID, 'max_agents', 2)).rejects.toThrow(
        /Plan limit reached: Your current Starter Tier plan allows up to 3 seats/i
      );
    });

    it('respects custom workspace limit overrides granted by super admin', async () => {
      // Workspace has custom limit of 10 agents instead of plan's 3
      fakeDb.subscriptions[0].custom_limits = { max_agents: 10 };

      // Current count is 4 (would exceed plan limit 3, but within custom 10)
      fakeDb.agents.push({ id: 'ag-3', workspace_id: WS_ID, is_active: true });
      fakeDb.agents.push({ id: 'ag-4', workspace_id: WS_ID, is_active: true });

      const check = await checkWorkspaceLimit(WS_ID, 'max_agents');
      expect(check.allowed).toBe(true);
      expect(check.limit).toBe(10);
      expect(check.isNearLimit).toBe(false);
    });

    it('allows unlimited usage when limit is null', async () => {
      // Set plan limit to null (unlimited)
      fakeDb.plans[0].max_articles = null;

      const check = await checkWorkspaceLimit(WS_ID, 'max_articles');
      expect(check.allowed).toBe(true);
      expect(check.limit).toBe(null);
      expect(check.isUnlimited).toBe(true);
      expect(check.isNearLimit).toBe(false);
    });
  });

  describe('3. Feature Switch Enforcement', () => {
    it('allows feature when enabled in plan', async () => {
      const check = await checkWorkspaceFeature(WS_ID, 'ai_bot');
      expect(check.allowed).toBe(true);
    });

    it('blocks feature and throws upgrade message when disabled in plan', async () => {
      const check = await checkWorkspaceFeature(WS_ID, 'channel_whatsapp');
      expect(check.allowed).toBe(false);
      expect(check.upgradeMessage).toContain('WhatsApp Channel');
      expect(check.upgradeMessage).toContain('Upgrade to a higher plan');

      await expect(
        assertWorkspaceFeature(WS_ID, 'channel_whatsapp')
      ).rejects.toThrow(/Upgrade required: WhatsApp Channel is not included/i);
    });

    it('honors custom feature entitlement override granted to workspace', async () => {
      // Plan has sla: false, but workspace has custom override
      fakeDb.subscriptions[0].custom_features = { sla: true };

      const check = await checkWorkspaceFeature(WS_ID, 'sla');
      expect(check.allowed).toBe(true);
      await expect(assertWorkspaceFeature(WS_ID, 'sla')).resolves.not.toThrow();
    });
  });

  describe('4. Coupons & Discounts', () => {
    beforeEach(() => {
      fakeDb.coupons = [
        {
          id: 'cp-active-pct',
          code: 'SAVE20',
          discount_type: 'percentage',
          discount_value: 20,
          max_redemptions: 5,
          redemptions_count: 1,
          is_active: true,
          valid_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          allowed_plan_ids: null,
        },
        {
          id: 'cp-expired',
          code: 'OLD50',
          discount_type: 'percentage',
          discount_value: 50,
          max_redemptions: 10,
          redemptions_count: 0,
          is_active: true,
          valid_until: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          allowed_plan_ids: null,
        },
        {
          id: 'cp-maxed',
          code: 'FULL10',
          discount_type: 'percentage',
          discount_value: 10,
          max_redemptions: 2,
          redemptions_count: 2,
          is_active: true,
          valid_until: null,
          allowed_plan_ids: null,
        },
        {
          id: 'cp-restricted',
          code: 'PROONLY',
          discount_type: 'fixed',
          discount_value: 15,
          max_redemptions: null,
          redemptions_count: 0,
          is_active: true,
          valid_until: null,
          allowed_plan_ids: ['plan-pro-exclusive'],
        },
      ];
    });

    it('validates a correct, active discount coupon', async () => {
      const res = await validateCouponAction('SAVE20', 'plan-starter');
      expect(res.valid).toBe(true);
      expect(res.coupon?.discount_value).toBe(20);
    });

    it('rejects an expired coupon', async () => {
      const res = await validateCouponAction('OLD50', 'plan-starter');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('expired');
    });

    it('rejects coupon when maximum redemptions reached', async () => {
      const res = await validateCouponAction('FULL10', 'plan-starter');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('maximum redemptions');
    });

    it('rejects coupon if restricted to other plans', async () => {
      const res = await validateCouponAction('PROONLY', 'plan-starter');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('not valid for the selected plan');
    });

    it('applies a coupon to workspace subscription and records discount', async () => {
      const res = await applyCouponToWorkspaceAction(WS_ID, 'save20');
      expect(res.success).toBe(true);
      expect(fakeDb.subscriptions[0].admin_note).toContain('SAVE20');
    });
  });

  describe('5. Trial Expiry & Subscriptions Lifecycle', () => {
    it('calculates remaining trial days for trialing workspace', async () => {
      fakeDb.subscriptions[0].status = 'trialing';
      fakeDb.subscriptions[0].trial_ends_at = new Date(
        Date.now() + 6 * 24 * 60 * 60 * 1000
      ).toISOString();

      const billing = await getWorkspaceBillingAndUsageAction(WS_ID);
      expect(billing.subscription.status).toBe('trialing');
      expect(billing.trialDaysRemaining).toBe(6);
    });

    it('detects trial expiration and transitions status', async () => {
      fakeDb.subscriptions[0].status = 'trialing';
      fakeDb.subscriptions[0].trial_ends_at = new Date(
        Date.now() - 1 * 24 * 60 * 60 * 1000
      ).toISOString();

      const billing = await getWorkspaceBillingAndUsageAction(WS_ID);
      expect(billing.subscription.status).toBe('past_due');
      expect(billing.trialDaysRemaining).toBe(0);
    });

    it('super admin can extend trial, grant custom limits, and add notes', async () => {
      fakeDb.currentUser = { ...superAdminUser };
      fakeDb.currentAgent = { ...superAdminAgent };

      const res = await updateWorkspaceSubscriptionAction({
        workspaceId: WS_ID,
        planId: 'plan-starter',
        status: 'trialing',
        extendTrialDays: 30,
        customLimits: { max_agents: 50 },
        customFeatures: { remove_branding: true },
        adminNote: 'Enterprise pilot extension approved',
      });

      expect(res.success).toBe(true);
      expect(fakeDb.subscriptions[0].custom_limits.max_agents).toBe(50);
      expect(fakeDb.subscriptions[0].custom_features.remove_branding).toBe(true);
      expect(fakeDb.subscriptions[0].admin_note).toBe('Enterprise pilot extension approved');
    });
  });

  describe('6. Plan Versioning Safety', () => {
    it('editing a plan price creates a new version without modifying previous version id', async () => {
      fakeDb.currentUser = { ...superAdminUser };
      fakeDb.currentAgent = { ...superAdminAgent };

      const originalVersion = fakeDb.subscriptions[0].plan_version;

      // Update price to $39/mo
      const res = await savePlanAction({
        id: 'plan-starter',
        name: 'Starter Tier Updated',
        slug: 'starter',
        description: 'New pricing structure',
        monthly_price: 39,
        yearly_price: 390,
        currency: 'USD',
        trial_days: 14,
        visibility: 'public',
        is_popular: false,
        is_default: true,
        max_agents: 3,
        max_tickets_per_month: 100,
        max_ai_bot_replies_per_month: 200,
        max_channels_connected: 2,
        max_articles: 10,
        max_automations: 5,
        max_storage_mb: 1000,
        max_api_requests_per_month: 5000,
        features: testPlan.features,
      });

      expect(res.success).toBe(true);

      // Existing subscriber still retains original plan_version (their grandfathered rate)
      expect(fakeDb.subscriptions[0].plan_version).toBe(originalVersion);

      // A new plan version with updated price was saved in platform_plans
      expect(fakeDb.plans[0].version).toBe(2);
      expect(fakeDb.plans[0].monthly_price).toBe(39);
    });
  });
});
