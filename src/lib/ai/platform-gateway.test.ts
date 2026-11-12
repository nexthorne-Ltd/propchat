// These suites test plan enforcement itself, which is off by default.
process.env.ENFORCE_PLAN_LIMITS = 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executePlatformAiReply, getPlatformAiConfigServerOnly, FRIENDLY_HANDOVER_MESSAGE } from './platform-gateway';
import { getPlatformAiSettingsAction, savePlatformAiSettingsAction } from '@/app/actions/platform-ai';

// Mock chat provider
vi.mock('./provider', () => ({
  chat: vi.fn(async (_config, _req) => ({
    text: 'Hello, this is an AI response generated via platform credentials.',
  })),
  isConfigured: (config: any) => Boolean(config && config.apiKey),
}));

// Mock auto-assign
vi.mock('@/lib/team/auto-assign', () => ({
  autoAssignConversation: vi.fn(async () => true),
}));

// In-memory test DB state
const fakeDb = vi.hoisted(() => ({
  currentUser: null as any,
  isSuperAdmin: false,
  plans: [] as any[],
  subscriptions: [] as any[],
  platformAiSettings: {
    id: true,
    provider: 'anthropic',
    base_url: null,
    model: 'claude-3-5-sonnet-20241022',
    api_key: 'sk-ant-test-super-secret-key-12345',
    is_enabled: true,
    updated_at: new Date().toISOString(),
    updated_by: '00000000-0000-0000-0000-000000000000',
  } as any,
  workspaceUsage: [] as any[],
  conversations: [] as any[],
}));

// Mock next/cache & server-only
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mock platform super admin assertion from @/app/actions/platform
vi.mock('@/app/actions/platform', () => ({
  assertSuperAdmin: vi.fn(async () => {
    if (!fakeDb.isSuperAdmin) {
      throw new Error('403 Forbidden: Platform super admin privileges required.');
    }
    return { user: fakeDb.currentUser };
  }),
}));

// Mock serviceClient & createClient
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => createMockClient(true),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => createMockClient(false),
}));

function createMockClient(isServiceRole = false) {
  return {
    auth: {
      getUser: async () => ({
        data: { user: fakeDb.currentUser },
        error: fakeDb.currentUser ? null : { message: 'Not authenticated' },
      }),
    },
    rpc: vi.fn(async (fnName: string, args: any) => {
      if (fnName === 'fn_increment_workspace_ai_usage') {
        const found = fakeDb.workspaceUsage.find(
          (u) => u.workspace_id === args.p_workspace_id && u.period_start === args.p_period_start
        );
        if (found) {
          found.replies_used += (args.p_replies || 1);
          return { data: { replies_used: found.replies_used }, error: null };
        } else {
          const newRow = {
            workspace_id: args.p_workspace_id,
            period_start: args.p_period_start,
            replies_used: args.p_replies || 1,
            tokens_in: 0,
            tokens_out: 0,
          };
          fakeDb.workspaceUsage.push(newRow);
          return { data: { replies_used: newRow.replies_used }, error: null };
        }
      }
      return { data: null, error: null };
    }),
    from: (table: string) => {
      let filters: Array<{ col: string; val: any }> = [];
      let isSingle = false;
      let isMaybeSingle = false;
      let updatePayload: any = null;
      let insertPayload: any = null;
      let upsertPayload: any = null;

      const builder: any = {
        select: vi.fn(() => builder),
        eq: vi.fn((col: string, val: any) => {
          filters.push({ col, val });
          return builder;
        }),
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
        upsert: vi.fn((payload: any) => {
          upsertPayload = payload;
          return builder;
        }),
        then: (resolve: (v: any) => any) => {
          let dataset: any[] = [];
          if (table === 'platform_plans') dataset = fakeDb.plans;
          if (table === 'workspace_subscriptions') dataset = fakeDb.subscriptions;
          if (table === 'platform_ai_settings') {
            // RLS SIMULATION: If client caller is not super admin, deny!
            if (!isServiceRole && (!fakeDb.currentUser || !fakeDb.isSuperAdmin)) {
              return resolve({ data: null, error: { message: 'permission denied for table platform_ai_settings' } });
            }
            dataset = [fakeDb.platformAiSettings];
          }
          if (table === 'workspace_ai_usage') dataset = fakeDb.workspaceUsage;
          if (table === 'conversations') dataset = fakeDb.conversations;

          if (updatePayload) {
            const matches = dataset.filter((row) => filters.every((f) => row[f.col] === f.val));
            matches.forEach((m) => Object.assign(m, updatePayload));
            return resolve({ data: matches, error: null });
          }

          if (upsertPayload) {
            const match = dataset.find(
              (row) => row.workspace_id === upsertPayload.workspace_id && row.period_start === upsertPayload.period_start
            );
            if (match) {
              Object.assign(match, upsertPayload);
            } else {
              dataset.push(upsertPayload);
            }
            return resolve({ data: upsertPayload, error: null });
          }

          const matched = dataset.filter((row) => filters.every((f) => row[f.col] === f.val));

          if (isSingle) {
            return resolve({ data: matched[0] || null, error: matched[0] ? null : { message: 'Not found' } });
          }
          if (isMaybeSingle) {
            return resolve({ data: matched[0] || null, error: null });
          }

          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
  };
}

describe('Platform AI Architecture & Gateway', () => {
  const WS_ID = 'ws-test-1111-2222-3333';
  const CONV_ID = 'conv-test-9999-8888-7777';

  beforeEach(() => {
    fakeDb.currentUser = { id: 'user-normal-1', email: 'agent@client.com' };
    fakeDb.isSuperAdmin = false;
    fakeDb.conversations = [
      { id: CONV_ID, workspace_id: WS_ID, status: 'open', ai_mode: 'autopilot' },
    ];
    fakeDb.workspaceUsage = [];
    fakeDb.plans = [
      {
        id: 'plan-pro',
        slug: 'pro',
        name: 'Pro',
        ai_enabled: true,
        ai_monthly_reply_limit: 1000,
        features: { ai_bot: true },
      },
      {
        id: 'plan-starter-no-ai',
        slug: 'starter-no-ai',
        name: 'Starter (No AI)',
        ai_enabled: false,
        ai_monthly_reply_limit: 0,
        features: { ai_bot: false },
      },
    ];
    fakeDb.subscriptions = [
      {
        id: 'sub-1',
        workspace_id: WS_ID,
        plan_id: 'plan-pro',
        status: 'active',
        custom_limits: {},
        custom_features: {},
      },
    ];
    fakeDb.platformAiSettings = {
      id: true,
      provider: 'anthropic',
      base_url: null,
      model: 'claude-3-5-sonnet-20241022',
      api_key: 'sk-ant-test-super-secret-key-12345',
      is_enabled: true,
      updated_at: new Date().toISOString(),
      updated_by: 'super-admin-1',
    };
  });

  it('Case 1: plan with AI on -> reply works and monthly usage increments by 1 atomically', async () => {
    const res = await executePlatformAiReply({
      workspaceId: WS_ID,
      conversationId: CONV_ID,
      request: {
        system: 'You are an AI assistant.',
        messages: [{ role: 'user', content: 'How do I reset my password?' }],
      },
    });

    expect(res.ok).toBe(true);
    expect(res.text).toBe('Hello, this is an AI response generated via platform credentials.');
    expect(res.handoverTriggered).toBe(false);
    expect(res.repliesUsed).toBe(1);

    // Verify usage recorded in workspace_ai_usage
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .split('T')[0];
    const usageRow = fakeDb.workspaceUsage.find(
      (u) => u.workspace_id === WS_ID && u.period_start === periodStart
    );
    expect(usageRow).toBeDefined();
    expect(usageRow?.replies_used).toBe(1);

    // Call again -> increments to 2
    const res2 = await executePlatformAiReply({
      workspaceId: WS_ID,
      conversationId: CONV_ID,
      request: {
        system: 'You are an AI assistant.',
        messages: [{ role: 'user', content: 'Where are the settings?' }],
      },
    });
    expect(res2.ok).toBe(true);
    expect(res2.repliesUsed).toBe(2);
    expect(usageRow?.replies_used).toBe(2);
  });

  it('Case 2: plan with AI off -> no model call, triggers human handoff', async () => {
    // Switch workspace subscription to plan where ai_enabled is false
    fakeDb.subscriptions[0].plan_id = 'plan-starter-no-ai';

    const res = await executePlatformAiReply({
      workspaceId: WS_ID,
      conversationId: CONV_ID,
      request: {
        system: 'You are an AI assistant.',
        messages: [{ role: 'user', content: 'Need help' }],
      },
    });

    expect(res.ok).toBe(false);
    expect(res.text).toBeNull();
    expect(res.handoverTriggered).toBe(true);
    expect(res.unavailableReason).toBe('ai_disabled_in_plan');
    expect(res.handoverMessage).toBe(FRIENDLY_HANDOVER_MESSAGE);

    // Verify conversation was handed over to human
    const conv = fakeDb.conversations.find((c) => c.id === CONV_ID);
    expect(conv?.ai_mode).toBe('disabled');
    expect(conv?.status).toBe('open');

    // Usage must NOT be incremented
    expect(fakeDb.workspaceUsage.length).toBe(0);
  });

  it('Case 3: limit reached -> no model call, returns limit_reached handoff', async () => {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .split('T')[0];

    // Seed usage at the exact limit of 1000
    fakeDb.workspaceUsage.push({
      workspace_id: WS_ID,
      period_start: periodStart,
      replies_used: 1000,
    });

    const res = await executePlatformAiReply({
      workspaceId: WS_ID,
      conversationId: CONV_ID,
      request: {
        system: 'You are an AI assistant.',
        messages: [{ role: 'user', content: 'Do you offer refunds?' }],
      },
    });

    expect(res.ok).toBe(false);
    expect(res.text).toBeNull();
    expect(res.handoverTriggered).toBe(true);
    expect(res.unavailableReason).toBe('limit_reached');
    expect(res.repliesUsed).toBe(1000);
    expect(res.limit).toBe(1000);

    // Verify conversation was handed over to human
    const conv = fakeDb.conversations.find((c) => c.id === CONV_ID);
    expect(conv?.ai_mode).toBe('disabled');

    // Usage was not incremented past the limit
    expect(fakeDb.workspaceUsage[0].replies_used).toBe(1000);
  });

  it('Case 4: normal workspace user trying to read or write platform_ai_settings is denied', async () => {
    fakeDb.currentUser = { id: 'user-normal-1', email: 'agent@workspace.com' };
    fakeDb.isSuperAdmin = false;

    // Direct read via server action must fail with Forbidden error
    await expect(getPlatformAiSettingsAction()).rejects.toThrow(/Forbidden/i);

    // Direct save via server action must fail with Forbidden error
    await expect(
      savePlatformAiSettingsAction({
        provider: 'openai',
        model: 'gpt-4o',
        api_key: 'sk-hacker-key',
        is_enabled: true,
      })
    ).rejects.toThrow(/Forbidden/i);
  });

  it('Case 5: super admin can read platform settings with write-only key (last 4 chars only)', async () => {
    fakeDb.currentUser = { id: 'super-admin-owner', email: 'owner@zentry.com' };
    fakeDb.isSuperAdmin = true;

    const res = await getPlatformAiSettingsAction();
    expect(res.success).toBe(true);
    const settings = res.settings;
    expect(settings.provider).toBe('anthropic');
    expect(settings.model).toBe('claude-3-5-sonnet-20241022');
    expect(settings.has_key).toBe(true);
    expect(settings.key_last4).toBe('2345');
    // Crucial security requirement: full key is NEVER sent to browser clients
    expect((settings as any).apiKey).toBeUndefined();
    expect((settings as any).api_key).toBeUndefined();
  });
});
