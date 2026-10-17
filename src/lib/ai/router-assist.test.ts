import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The second opinion for the router: only where the rules are unsure, Jev
 * first (live and confident), then the model, and the rules' pick when both
 * fail or answer outside the options.
 */

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}) }));
const events: { reason: string; detail: Record<string, unknown> }[] = [];
vi.mock('@/lib/ai/bot-control', () => ({
  logAiEvent: async (_s: unknown, e: { reason: string; detail: Record<string, unknown> }) => {
    events.push(e);
  },
}));
vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  return { ...actual, chat: vi.fn() };
});
vi.mock('@/lib/ai/jev', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/jev')>();
  return { ...actual, jevRoute: vi.fn() };
});

const { chat } = await import('@/lib/ai/provider');
const { jevRoute, DEFAULT_JEV_SETTINGS } = await import('@/lib/ai/jev');
const { assistRoute, assistOptions, readModelChoice } = await import('./router-assist');
const { routeSubAgent } = await import('./sub-agents');

const provider = { provider: 'anthropic' as const, apiKey: 'k' };
const live = { apiKey: 'ts', settings: { ...DEFAULT_JEV_SETTINGS, mode: 'live' as const } };
const shadow = { apiKey: 'ts', settings: { ...DEFAULT_JEV_SETTINGS, mode: 'shadow' as const } };
const base = { workspaceId: 'ws', conversationId: 'c', enabled: () => true };

beforeEach(() => {
  events.length = 0;
  vi.mocked(chat).mockReset();
  vi.mocked(jevRoute).mockReset();
});

describe('the router reports how sure it is', () => {
  it('one clear topic is sure, two equal topics are a tie, none is none', () => {
    expect(routeSubAgent({ message: 'payout kab milega?', intent: 'help_center_question' }).certainty).toBe('sure');
    const tie = routeSubAgent({ message: 'payout kab milega aur kyc ke documents kya hain', intent: 'help_center_question' });
    expect(tie).toMatchObject({ certainty: 'tie' });
    expect(tie.candidates).toEqual(expect.arrayContaining(['payouts', 'kyc']));
    expect(routeSubAgent({ message: 'bhai woh wala masla abhi tak solve nahi hua', intent: 'help_center_question' })).toMatchObject({
      agent: 'general',
      certainty: 'none',
    });
  });
});

describe('assistRoute', () => {
  const unsure = routeSubAgent({ message: 'bhai woh wala masla abhi tak solve nahi hua', intent: 'help_center_question' });

  it('a sure route is left alone: no Jev, no model', async () => {
    const sure = routeSubAgent({ message: 'payout kab milega?', intent: 'help_center_question' });
    const r = await assistRoute({ ...base, message: 'payout kab milega?', route: sure, jev: live, providerConfig: provider });
    expect(r).toMatchObject({ agent: 'payouts', decidedBy: 'rules' });
    expect(jevRoute).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('live and confident, Jev decides; the rules\' pick is offered first', async () => {
    vi.mocked(jevRoute).mockResolvedValue({ choice: 'account', confidence: 0.82, latencyMs: 90, usage: { inputTokens: 1, outputTokens: 1 } });
    const r = await assistRoute({ ...base, message: 'bhai woh wala masla abhi tak solve nahi hua', route: unsure, jev: live, providerConfig: provider });
    expect(r).toMatchObject({ agent: 'account', decidedBy: 'jev', certainty: 'sure' });
    expect(Object.keys(vi.mocked(jevRoute).mock.calls[0][1].options)[0]).toBe('general');
    expect(chat).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ reason: 'jev_decided', detail: { jev_pick: 'account', agreed: false } });
  });

  it('Jev unsure (or in shadow mode) leaves the choice to the model', async () => {
    vi.mocked(jevRoute).mockResolvedValue({ choice: 'account', confidence: 0.4, latencyMs: 90, usage: { inputTokens: 1, outputTokens: 1 } });
    vi.mocked(chat).mockResolvedValue({ text: 'account_status', provider: 'anthropic', model: 'm' });
    const r = await assistRoute({ ...base, message: 'mera wala check karo', route: unsure, jev: live, providerConfig: provider });
    expect(r).toMatchObject({ agent: 'account_status', decidedBy: 'model' });
    expect(vi.mocked(chat).mock.calls[0][1].maxTokens).toBeLessThanOrEqual(12);

    vi.mocked(chat).mockResolvedValue({ text: 'general', provider: 'anthropic', model: 'm' });
    const s = await assistRoute({ ...base, message: 'x y z', route: unsure, jev: shadow, providerConfig: provider });
    expect(s).toMatchObject({ agent: 'general' });
    expect(events.some((e) => e.reason === 'jev_shadow')).toBe(true);
  });

  it('a failing Jev and an answer outside the options keep the rules\' pick', async () => {
    vi.mocked(jevRoute).mockRejectedValue(new Error('timeout'));
    vi.mocked(chat).mockResolvedValue({ text: 'banana', provider: 'anthropic', model: 'm' });
    const r = await assistRoute({ ...base, message: 'hmm', route: unsure, jev: live, providerConfig: provider });
    expect(r).toMatchObject({ agent: 'general', decidedBy: 'rules' });
    expect(events.map((e) => e.reason)).toEqual(['jev_error', 'model_unclear']);
  });

  it('without Jev or a model the rules decide', async () => {
    const r = await assistRoute({ ...base, message: 'hmm', route: unsure, jev: null, providerConfig: null });
    expect(r).toMatchObject({ agent: 'general', decidedBy: 'rules' });
  });

  it('a tie offers only the tied specialists, and a switched-off one is not offered', () => {
    const tie = routeSubAgent({ message: 'payout kab milega aur kyc ke documents kya hain', intent: 'help_center_question' });
    expect(assistOptions(tie, () => true).sort()).toEqual([...(tie.candidates || [])].sort());
    const all = assistOptions(unsure, (id) => id !== 'refunds');
    expect(all[0]).toBe('general');
    expect(all).not.toContain('refunds');
    expect(all).not.toContain('greeting');
    expect(all).not.toContain('human_handover');
  });
});

describe('readModelChoice', () => {
  it('reads an id even with punctuation or a sentence around it', () => {
    const opts = ['general', 'account', 'account_status'] as const;
    expect(readModelChoice('account_status', [...opts])).toBe('account_status');
    expect(readModelChoice('"account".', [...opts])).toBe('account');
    expect(readModelChoice('The answer is account_status', [...opts])).toBe('account_status');
    expect(readModelChoice('no idea', [...opts])).toBeNull();
  });
});
