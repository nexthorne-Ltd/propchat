/* eslint-disable @typescript-eslint/no-explicit-any -- an untyped in-memory stand-in for the Supabase client */
/**
 * Why the bot does or does not answer: the real auto-respond route, run
 * against an in-memory database. The answer pipeline, the plan checks and the
 * translator are faked; every gate in the route (ids, workspace, plan,
 * settings, who owns the conversation, delivery, retries, timeouts) is the
 * real code. Each "no" must leave its reason in ai_reply_events.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** Overrides fn_deliver_ai_reply's verdict; null = the default rules below. */
  deliverVerdict: null as null | { delivered: false; reason: string },
  deliverMissing: false,
  clock: Date.parse('2026-10-11T10:00:00Z'),
}));

/* ── A small Supabase stand-in ────────────────────────────────────────── */

function field(row: Row, col: string): unknown {
  const [base, key] = col.split('->>');
  const value = row[base.trim()];
  return key ? (value as Row | null)?.[key.trim()] : value;
}

function nextTimestamp(): string {
  db.clock += 1000;
  return new Date(db.clock).toISOString();
}

function insertRow(table: string, row: Row): { data: Row | null; error: { code: string; message: string } | null } {
  const rows = (db.tables[table] ||= []);
  if (
    table === 'messages' &&
    row.sender_type === 'ai' &&
    row.reply_to_message_id &&
    rows.some(
      (m) =>
        m.sender_type === 'ai' &&
        Boolean(m.is_internal) === Boolean(row.is_internal) &&
        m.reply_to_message_id === row.reply_to_message_id
    )
  ) {
    return { data: null, error: { code: '23505', message: 'duplicate key' } };
  }
  const stored = { id: crypto.randomUUID(), created_at: nextTimestamp(), ...row };
  rows.push(stored);
  return { data: stored, error: null };
}

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: 'select' | 'update' | 'insert' = 'select';
  let payload: Row | null = null;
  let order: [string, boolean] | null = null;
  let limit: number | null = null;

  const run = (): { data: any; error: any } => {
    if (op === 'insert') {
      const result = insertRow(table, payload!);
      return { data: result.data ? [result.data] : null, error: result.error };
    }
    let rows = (db.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    if (op === 'update') {
      for (const r of rows) Object.assign(r, payload);
      return { data: rows, error: null };
    }
    if (order) {
      const [col, asc] = order;
      rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : 1) * (asc ? 1 : -1));
    }
    if (limit != null) rows = rows.slice(0, limit);
    return { data: rows.map((r) => ({ ...r })), error: null };
  };

  const builder: any = {
    select: () => builder,
    eq: (col: string, v: unknown) => (filters.push((r) => field(r, col) === v), builder),
    gt: (col: string, v: string) => (filters.push((r) => String(field(r, col)) > v), builder),
    not: (col: string, operator: string, v: unknown) => {
      if (operator === 'is' && v === null) filters.push((r) => field(r, col) != null);
      return builder;
    },
    or: (expr: string) => {
      const parts = expr.split(',').map((p) => p.split('.eq.'));
      filters.push((r) => parts.some(([col, val]) => String(field(r, col) ?? '') === val));
      return builder;
    },
    order: (col: string, opts: { ascending: boolean }) => ((order = [col, opts.ascending]), builder),
    limit: (n: number) => ((limit = n), builder),
    update: (patch: Row) => ((op = 'update'), (payload = patch), builder),
    insert: (row: Row) => ((op = 'insert'), (payload = row), builder),
    single: async () => {
      const { data, error } = run();
      if (error) return { data: null, error };
      return data?.length ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    },
    maybeSingle: async () => {
      const { data, error } = run();
      return { data: data?.[0] ?? null, error };
    },
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}

/** fn_deliver_ai_reply's rules, reduced to what the route reacts to. */
function deliver(args: Row) {
  if (db.deliverMissing) return { data: null, error: { code: 'PGRST202', message: 'function not found' } };
  if (db.deliverVerdict) return { data: db.deliverVerdict, error: null };
  const conv = db.tables.conversations.find((c) => c.id === args.p_conversation_id)!;
  if (conv.ai_mode === 'disabled') return { data: { delivered: false, reason: `ai_${conv.ai_paused_reason}` }, error: null };
  if (args.p_expected_version != null && conv.ai_control_version !== args.p_expected_version) {
    return { data: { delivered: false, reason: 'control_changed' }, error: null };
  }
  const result = insertRow('messages', {
    conversation_id: args.p_conversation_id,
    sender_type: 'ai',
    sender_id: null,
    content: args.p_content,
    is_internal: false,
    reply_to_message_id: args.p_visitor_message_id,
    metadata: args.p_metadata,
  });
  if (result.error) return { data: { delivered: false, reason: 'already_answered' }, error: null };
  return { data: { delivered: true, message: result.data }, error: null };
}

const fakeSupabase = {
  from: (table: string) => query(table),
  rpc: async (fn: string, args: Row) => (fn === 'fn_deliver_ai_reply' ? deliver(args) : { data: null, error: null }),
};

/* ── Everything outside the route is faked ────────────────────────────── */

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => fakeSupabase, hasServiceRole: () => true }));

const plan = vi.hoisted(() => ({ feature: true, limit: true }));
vi.mock('@/lib/plans/enforce', () => ({
  checkWorkspaceFeature: async () => ({ allowed: plan.feature, upgradeMessage: plan.feature ? undefined : 'AI bot not in plan' }),
  checkWorkspaceLimit: async () => ({ allowed: plan.limit, upgradeMessage: plan.limit ? undefined : 'Limit reached' }),
  incrementWorkspaceUsage: async () => {},
}));
vi.mock('@/lib/ai/platform-gateway', () => ({
  getPlatformAiConfigServerOnly: async () => ({ isEnabled: false, config: null, model: null }),
}));
vi.mock('@/lib/ai/help-answer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/help-answer')>()),
  providerConfigFrom: () => null,
  warmHelpIndex: () => {},
}));
vi.mock('@/lib/ai/inbound-translation', () => ({ translateVisitorMessage: async () => {} }));
vi.mock('@/lib/channels/dispatcher', () => ({ dispatchOutboundMessage: async () => {} }));
vi.mock('@/lib/domain', () => ({ getWorkspaceHelpCenterUrl: () => null }));
vi.mock('@/lib/ai/translator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/translator')>();
  return {
    ...actual,
    translateWithGoogleGtx: async () => null,
    translateAgentReply: async ({ text }: { text: string }) => ({ translatedText: text }),
    translateToEnglish: async ({ text }: { text: string }) => ({ englishText: text }),
  };
});
vi.mock('@/lib/agent/external-agent', () => ({ answerWithExternalAgent: vi.fn(async () => null) }));
vi.mock('@/lib/ai/anthropic', () => ({
  generateHelpDeskResponseWithHandover: vi.fn(),
  executeHandoverToHuman: vi.fn(async () => {}),
  buildRunningSummary: () => 'summary',
}));

import { POST } from '@/app/api/ai/auto-respond/route';
import { executeHandoverToHuman, generateHelpDeskResponseWithHandover } from '@/lib/ai/anthropic';
import { answerWithExternalAgent } from '@/lib/agent/external-agent';

const externalAgent = vi.mocked(answerWithExternalAgent);

const generate = vi.mocked(generateHelpDeskResponseWithHandover);
const handover = vi.mocked(executeHandoverToHuman);

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const WS = 'ws-1';
const CONV = 'conv-1';

function reset() {
  db.clock = Date.parse('2026-10-11T10:00:00Z');
  db.deliverVerdict = null;
  db.deliverMissing = false;
  plan.feature = true;
  plan.limit = true;
  db.tables = {
    workspaces: [{ id: WS, name: 'Acme Store', ai_settings: {}, business_hours: null }],
    conversations: [
      {
        id: CONV,
        workspace_id: WS,
        status: 'open',
        channel: 'web',
        ai_mode: 'autopilot',
        ai_paused_reason: null,
        ai_control_version: 3,
        channel_metadata: {},
        visitor: { name: 'Sara' },
      },
    ],
    messages: [],
    ai_reply_events: [],
  };
  generate.mockReset();
  generate.mockResolvedValue({ replyText: 'You can reset it from the login page.', shouldHandover: false, canAnswerFromDocs: true });
  handover.mockClear();
  externalAgent.mockClear();
  externalAgent.mockResolvedValue(null);
}

const conv = () => db.tables.conversations[0];
const ws = () => db.tables.workspaces[0];

function visitorSays(content: string): string {
  return insertRow('messages', { conversation_id: CONV, sender_type: 'visitor', sender_id: null, content, is_internal: false }).data!.id;
}
function agentSays(content: string, opts: Row = {}): string {
  return insertRow('messages', { conversation_id: CONV, sender_type: 'agent', sender_id: 'agent-1', content, is_internal: false, ...opts }).data!.id;
}

async function call(body: Row) {
  const res = await POST(new Request('https://app.test/api/ai/auto-respond', { method: 'POST', body: JSON.stringify(body) }) as any);
  return { status: res.status, body: (await res.json()) as Row };
}
const respond = (messageId: string, workspaceId = WS) => call({ conversation_id: CONV, workspace_id: workspaceId, message_id: messageId });

const publicBotReplies = () => db.tables.messages.filter((m) => m.sender_type === 'ai' && !m.is_internal);
const suppressedReasons = () => db.tables.ai_reply_events.filter((e) => e.event === 'reply_suppressed').map((e) => e.reason);

beforeEach(reset);

/* ── Tests ────────────────────────────────────────────────────────────── */

describe('the bot answers', () => {
  it('a new visitor message, with the reply stored against it', async () => {
    const msg = visitorSays('How do I reset my password?');
    const { body } = await respond(msg);
    expect(body.replied).toBe(true);
    expect(publicBotReplies()).toHaveLength(1);
    expect(publicBotReplies()[0]).toMatchObject({ reply_to_message_id: msg, content: 'You can reset it from the login page.' });
    expect(suppressedReasons()).toEqual([]);
  });

  it('with the migration not applied yet, through the old insert', async () => {
    db.deliverMissing = true;
    const msg = visitorSays('How do I reset my password?');
    expect((await respond(msg)).body.replied).toBe(true);
    expect(publicBotReplies()).toHaveLength(1);
  });

  it('after an agent turned the bot back on, carrying on from what the agent said', async () => {
    visitorSays('My dashboard shows an error');
    agentSays("I've forwarded this to the technical team. I'll update you once I hear back.");
    Object.assign(conv(), { ai_mode: 'autopilot', ai_resumed_at: new Date(db.clock + 500).toISOString() });
    db.clock += 1000;
    const msg = visitorSays('Any update?');
    expect((await respond(msg)).body.replied).toBe(true);

    const args = generate.mock.calls[0][0];
    expect(args.resuming).toBe(true);
    expect(args.humanContext?.lastReply).toContain("I'll update you");
    expect(args.turns?.some((t) => t.content.startsWith('[Team member] '))).toBe(true);
  });

  it('after the conversation was resolved, even though a person had taken it', async () => {
    visitorSays('Hi');
    agentSays('Sorted, closing now.');
    Object.assign(conv(), {
      ai_mode: 'disabled',
      ai_paused_reason: 'human_reply',
      ai_control_changed_at: new Date(db.clock).toISOString(),
      last_resolved_at: new Date(db.clock + 500).toISOString(),
    });
    db.clock += 1000;
    const msg = visitorSays('One more question');
    expect((await respond(msg)).body.replied).toBe(true);
    expect(conv().ai_mode).toBe('autopilot');
  });

  it('and hands over when the pipeline says so, saying why the bot stepped aside', async () => {
    generate.mockResolvedValueOnce({
      replyText: "I've passed this to our support team.",
      shouldHandover: true,
      canAnswerFromDocs: false,
      intent: 'wants_human',
      disableAi: true,
      priority: 'high',
    });
    const msg = visitorSays('I want to talk to a person');
    await respond(msg);
    expect(handover).toHaveBeenCalledWith(
      expect.objectContaining({ disableAi: true, pausedReason: 'human_requested', visitorMessageId: msg, announce: false })
    );
  });
});

describe("the workspace's own agent (LangGraph)", () => {
  it('answers instead of the built-in bot, through the same delivery', async () => {
    externalAgent.mockResolvedValueOnce({ replyText: 'From your agent.', shouldHandover: false, canAnswerFromDocs: true, engine: 'external_agent' });
    const msg = visitorSays('What is the daily loss limit?');
    expect((await respond(msg)).body.replied).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(publicBotReplies()[0]).toMatchObject({ content: 'From your agent.', reply_to_message_id: msg });
    expect(publicBotReplies()[0].metadata.bot_engine).toBe('external_agent');
  });

  it('falls back to the built-in bot when the agent has no answer', async () => {
    externalAgent.mockResolvedValueOnce(null);
    await respond(visitorSays('What is the daily loss limit?'));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(publicBotReplies()[0].metadata.bot_engine).toBe('built_in');
  });

  it('is not asked when the visitor wants a person: the built-in handover always runs', async () => {
    await respond(visitorSays('I want to talk to a real person'));
    expect(externalAgent).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not deliver the agent's answer once a person has taken over", async () => {
    db.deliverVerdict = { delivered: false, reason: 'ai_human_reply' };
    externalAgent.mockResolvedValueOnce({ replyText: 'Late agent answer', shouldHandover: false, canAnswerFromDocs: true, engine: 'external_agent' });
    await respond(visitorSays('hello?'));
    expect(publicBotReplies()).toHaveLength(0);
  });
});

describe('the bot stays quiet, and says why', () => {
  it.each([
    ['the AI is off in workspace settings', { enabled: false }, 'workspace_ai_off'],
    ['auto-replies are off in workspace settings', { auto_response_enabled: false }, 'workspace_auto_reply_off'],
  ])('when %s', async (_label, settings, code) => {
    db.tables.workspaces[0].ai_settings = settings;
    const msg = visitorSays('Hello?');
    const { body } = await respond(msg);
    expect(body).toMatchObject({ replied: false, code });
    expect(generate).not.toHaveBeenCalled();
    expect(suppressedReasons()).toEqual([code]);
  });

  it('when the plan does not include the AI bot', async () => {
    plan.feature = false;
    const { body } = await respond(visitorSays('Hello?'));
    expect(body.code).toBe('plan_no_ai_bot');
    expect(suppressedReasons()).toEqual(['plan_no_ai_bot']);
    expect(generate).not.toHaveBeenCalled();
  });

  it("when this month's AI reply limit is used up", async () => {
    plan.limit = false;
    const { body } = await respond(visitorSays('Hello?'));
    expect(body.code).toBe('plan_reply_limit_reached');
    expect(suppressedReasons()).toEqual(['plan_reply_limit_reached']);
  });

  it('when a person has the conversation', async () => {
    visitorSays('Hi');
    agentSays('Hi Sara, looking into it.');
    Object.assign(conv(), { ai_mode: 'disabled', ai_paused_reason: 'human_reply' });
    const { body } = await respond(visitorSays('ok thanks'));
    expect(body.replied).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(publicBotReplies()).toHaveLength(0);
    expect(suppressedReasons()).toEqual(['human_handling']);
  });

  it('when an agent paused it', async () => {
    Object.assign(conv(), { ai_mode: 'disabled', ai_paused_reason: 'agent_paused' });
    await respond(visitorSays('Hello?'));
    expect(suppressedReasons()).toEqual(['ai_paused']);
  });

  it('when a person replied on an older row that still says autopilot', async () => {
    visitorSays('Hi');
    agentSays('Taking this one.');
    await respond(visitorSays('thanks'));
    expect(generate).not.toHaveBeenCalled();
    expect(suppressedReasons()).toEqual(['human_handling']);
  });

  it('but tells the team, not the visitor, when they ask for a person again', async () => {
    Object.assign(conv(), { ai_mode: 'disabled', ai_paused_reason: 'human_reply' });
    const msg = visitorSays('I want to talk to a real person');
    await respond(msg);
    expect(publicBotReplies()).toHaveLength(0);
    const note = db.tables.messages.find((m) => m.is_internal && m.reply_to_message_id === msg);
    expect(note?.content).toContain('asked for a person again');
    expect(conv().priority).toBe('high');
  });

  it('when a person took over while the reply was being written', async () => {
    db.deliverVerdict = { delivered: false, reason: 'ai_human_reply' };
    generate.mockResolvedValueOnce({ replyText: 'Passing you on.', shouldHandover: true, canAnswerFromDocs: false });
    const { body } = await respond(visitorSays('Hello?'));
    expect(body).toMatchObject({ replied: false });
    expect(body.reason).toContain('ai_human_reply');
    expect(publicBotReplies()).toHaveLength(0);
    // No handover either: the person already has it.
    expect(handover).not.toHaveBeenCalled();
  });

  it('when the switch changed during generation (version moved)', async () => {
    generate.mockImplementationOnce(async () => {
      conv().ai_control_version = 4;
      return { replyText: 'Late answer', shouldHandover: false, canAnswerFromDocs: true };
    });
    const { body } = await respond(visitorSays('Hello?'));
    expect(body.reason).toContain('control_changed');
    expect(publicBotReplies()).toHaveLength(0);
  });

  it('on a retry of a message it already answered: one reply, no second model call', async () => {
    const msg = visitorSays('How do I reset my password?');
    await respond(msg);
    const again = await respond(msg);
    expect(again.body.replied).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(publicBotReplies()).toHaveLength(1);
    expect(suppressedReasons()).toEqual(['already_answered']);
  });

  it('two deliveries of the same message at once produce one reply', async () => {
    const msg = visitorSays('How do I reset my password?');
    await Promise.all([respond(msg), respond(msg)]);
    expect(publicBotReplies()).toHaveLength(1);
  });
});

describe('requests that are not answered at all', () => {
  it('rejects a call without ids', async () => {
    expect((await call({})).status).toBe(400);
  });

  it('ignores a conversation from another workspace and records nothing against it', async () => {
    const msg = visitorSays('Hello?');
    const { body } = await respond(msg, 'ws-attacker');
    expect(body.code).toBe('not_found');
    expect(generate).not.toHaveBeenCalled();
    expect(db.tables.ai_reply_events).toHaveLength(0);
  });

  it('skips a suspended workspace and records workspace_suspended in ai_reply_events', async () => {
    ws().is_suspended = true;
    const msg = visitorSays('Hello?');
    const { body } = await respond(msg);
    expect(body.replied).toBe(false);
    expect(body.code).toBe('workspace_suspended');
    expect(generate).not.toHaveBeenCalled();
    expect(db.tables.ai_reply_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'reply_suppressed',
          reason: 'workspace_suspended',
        }),
      ])
    );
  });

  it('skips a deleted workspace and records workspace_deleted in ai_reply_events', async () => {
    ws().deleted_at = new Date().toISOString();
    const msg = visitorSays('Hello?');
    const { body } = await respond(msg);
    expect(body.replied).toBe(false);
    expect(body.code).toBe('workspace_deleted');
    expect(generate).not.toHaveBeenCalled();
    expect(db.tables.ai_reply_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'reply_suppressed',
          reason: 'workspace_deleted',
        }),
      ])
    );
  });
});

describe('when the model is slow or fails', () => {
  it('hands over without turning the bot off, and records the error', async () => {
    generate.mockRejectedValueOnce(new Error('AI response timed out after 35 seconds'));
    const msg = visitorSays('Hello?');
    const { body } = await respond(msg);
    expect(body.handed_over).toBe(true);
    expect(handover).toHaveBeenCalledWith(expect.objectContaining({ disableAi: false, controlVersion: 3, visitorMessageId: msg }));
    expect(db.tables.ai_reply_events.map((e) => e.event)).toContain('provider_error');
  });
});
