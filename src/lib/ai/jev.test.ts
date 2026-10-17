/**
 * Jev beside DeepSeek (src/lib/ai/jev.ts): the System One request we send,
 * how answers are checked, and how the intent classifier uses Jev in each
 * mode. TypeSafe and the generative model are both faked; nothing leaves the
 * machine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}) }));

const chat = vi.hoisted(() => vi.fn());
vi.mock('./provider', async (orig) => ({ ...(await orig<typeof import('./provider')>()), chat }));

import { askJev, JEV_ENDPOINT, jevGrounding, jevIntent, normalizeJevSettings, type JevRuntime } from './jev';
import { classifyVisitorIntent } from './intent';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are read as untyped JSON
type Json = Record<string, any>;
type Call = { url: string; init: RequestInit; body: Json };

function fakeFetch(reply: (body: Json) => { status?: number; json: unknown } | Error, calls: Call[] = []) {
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, init, body });
    const r = reply(body);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const intentAnswers = (
  intent: string,
  confidence: number,
  extra: { wantsHuman?: number; angry?: number; urgent?: number; spam?: number } = {}
) => ({
  model: 'jev-1.13.0',
  answers: {
    intent: { type: 'choice', choice: intent, confidence, probabilities: { [intent]: confidence } },
    wants_human: { type: 'noul', noul: extra.wantsHuman ?? 0.05 },
    frustration: { type: 'score', score: 0.2, confidence: 0.8, probabilities: { '0': 0.9, '1': 0.1 - (extra.angry ?? 0), '2': extra.angry ?? 0 } },
    urgent: { type: 'noul', noul: extra.urgent ?? 0.1 },
    spam: { type: 'noul', noul: extra.spam ?? 0.01 },
  },
  usage: { input_tokens: 300, output_tokens: 20 },
});

const runtime = (mode: 'shadow' | 'live', over: Partial<JevRuntime['settings']> = {}): JevRuntime => ({
  apiKey: 'ts_test_key',
  settings: { ...normalizeJevSettings({ mode }), ...over },
});

describe('the System One request', () => {
  it('posts typed questions with the key as a bearer token', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: intentAnswers('account_specific', 0.93) }));
    const v = await jevIntent(runtime('shadow'), { message: 'mera order kahan hai?', workspaceName: 'Acme', topics: ['Shipping'] }, { fetchImpl: impl });
    expect(calls[0].url).toBe(JEV_ENDPOINT);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer ts_test_key');
    expect(calls[0].body.model).toBe('jev-latest');
    expect(calls[0].body.state.latest_customer_message).toBe('mera order kahan hai?');
    expect(Object.keys(calls[0].body.questions.intent.criteria)[0]).toBe('help_center_question');
    expect(calls[0].body.questions.frustration.criteria).toHaveLength(3);
    expect(v).toMatchObject({ intent: 'account_specific', confidence: 0.93, wantsHuman: 0.05, veryUpset: 0, urgent: 0.1, spam: 0.01 });
    // Every triage question in one request, and the token counts read back.
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].body.questions)).toEqual(['intent', 'wants_human', 'frustration', 'urgent', 'spam']);
    expect(v.usage).toEqual({ inputTokens: 300, outputTokens: 20 });
  });

  it('retries a transient failure once, and never a timeout or a refused key', async () => {
    let n = 0;
    const flaky = fakeFetch(() => (++n === 1 ? { status: 529, json: {} } : { json: { answers: { q: { type: 'noul', noul: 0.7 } } } }));
    const ok = await askJev('k', 's', { q: { type: 'noul', instructions: 'x' } }, { fetchImpl: flaky.impl });
    expect(ok.attempts).toBe(2);
    expect(ok.usage).toEqual({ inputTokens: null, outputTokens: null });

    const down = fakeFetch(() => ({ status: 503, json: {} }));
    await expect(askJev('k', 's', { q: { type: 'noul', instructions: 'x' } }, { fetchImpl: down.impl })).rejects.toThrow(/503/);
    expect(down.calls).toHaveLength(2);

    const slow = fakeFetch(() => Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(askJev('k', 's', { q: { type: 'noul', instructions: 'x' } }, { fetchImpl: slow.impl })).rejects.toThrow(/in time/);
    expect(slow.calls).toHaveLength(1);

    const denied = fakeFetch(() => ({ status: 401, json: {} }));
    await expect(askJev('k', 's', { q: { type: 'noul', instructions: 'x' } }, { fetchImpl: denied.impl })).rejects.toThrow(/refused/);
    expect(denied.calls).toHaveLength(1);
  });

  it('refuses an answer whose type is not the question type', async () => {
    const odd = fakeFetch(() => ({ json: { answers: { q: { type: 'score', noul: 0.4 } } } }));
    await expect(askJev('k', 's', { q: { type: 'noul', instructions: 'x' } }, { fetchImpl: odd.impl })).rejects.toThrow(/did not match/);
  });

  it('refuses an answer outside the options, and explains HTTP errors', async () => {
    const odd = fakeFetch(() => ({ json: { answers: { pick: { type: 'choice', choice: 'banana', confidence: 1 } } } }));
    await expect(
      askJev('k', 's', { pick: { type: 'choice', instructions: 'x', criteria: { a: null, b: null } } }, { fetchImpl: odd.impl })
    ).rejects.toThrow(/did not match/);

    const denied = fakeFetch(() => ({ status: 401, json: { detail: 'bad key' } }));
    await expect(askJev('k', 's', { q: { type: 'noul', instructions: 'x' } }, { fetchImpl: denied.impl })).rejects.toThrow(/key was refused/);

    const down = fakeFetch(() => Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(askJev('k', 's', { q: { type: 'noul', instructions: 'x' } }, { fetchImpl: down.impl })).rejects.toThrow(/in time/);
  });

  it('checks an answer against its passages', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { answers: { supported: { type: 'noul', noul: 0.12 } } } }));
    const v = await jevGrounding(runtime('live'), { question: 'refund?', answer: 'Refunds take 90 days.', passages: 'Refunds take 7 days.' }, { fetchImpl: impl });
    expect(v.supported).toBe(0.12);
    expect(calls[0].body.state).toMatchObject({ drafted_answer: 'Refunds take 90 days.', help_center_passages: 'Refunds take 7 days.' });
  });

  it('settings are clamped and default to off', () => {
    expect(normalizeJevSettings(undefined)).toMatchObject({ mode: 'off', intent: true, grounding: true });
    expect(normalizeJevSettings({ mode: 'live', minConfidence: 5, minGrounding: -1 })).toMatchObject({ minConfidence: 0.99, minGrounding: 0.05 });
    expect(normalizeJevSettings({ mode: 'turbo' }).mode).toBe('off');
  });
});

describe('the intent classifier with Jev', () => {
  const deepseek = { provider: 'deepseek' as const, apiKey: 'x', model: 'deepseek-chat', baseUrl: null };
  // A message the rules are not sure about, so a model is asked.
  const message = 'bhai ye account wala masla kab theek hoga, kuch batao';

  beforeEach(() => {
    chat.mockReset();
    chat.mockResolvedValue({ text: '{"intent":"help_center_question","confidence":0.7,"summary":"asks when"}' });
  });

  it('live and sure: Jev decides and DeepSeek is not asked', async () => {
    vi.stubGlobal('fetch', fakeFetch(() => ({ json: intentAnswers('account_specific', 0.92) })).impl);
    const r = await classifyVisitorIntent({ message, providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('live') });
    expect(r).toMatchObject({ intent: 'account_specific', source: 'jev' });
    expect(r.jev?.used).toBe(true);
    expect(chat).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('live but unsure: DeepSeek decides and Jev is only recorded', async () => {
    vi.stubGlobal('fetch', fakeFetch(() => ({ json: intentAnswers('account_specific', 0.55) })).impl);
    const r = await classifyVisitorIntent({ message, providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('live') });
    expect(r).toMatchObject({ intent: 'help_center_question', source: 'model' });
    expect(r.jev).toMatchObject({ used: false, verdict: { intent: 'account_specific' } });
    vi.unstubAllGlobals();
  });

  it('shadow: DeepSeek decides, Jev rides along', async () => {
    vi.stubGlobal('fetch', fakeFetch(() => ({ json: intentAnswers('help_center_question', 0.97) })).impl);
    const r = await classifyVisitorIntent({ message, providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('shadow') });
    expect(r.source).toBe('model');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(r.jev).toMatchObject({ used: false, verdict: { intent: 'help_center_question' } });
    vi.unstubAllGlobals();
  });

  it('Jev down: the bot carries on with DeepSeek', async () => {
    vi.stubGlobal('fetch', fakeFetch(() => ({ status: 529, json: {} })).impl);
    const r = await classifyVisitorIntent({ message, providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('live') });
    expect(r.source).toBe('model');
    expect(r.jev?.error).toMatch(/overloaded/);
    vi.unstubAllGlobals();
  });

  it('a very upset customer reads as a complaint (immediate handover)', async () => {
    vi.stubGlobal('fetch', fakeFetch(() => ({ json: intentAnswers('account_specific', 0.9, { angry: 0.85 }) })).impl);
    const r = await classifyVisitorIntent({ message, providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('live') });
    expect(r.isComplaint).toBe(true);
    vi.unstubAllGlobals();
  });

  it('live: spam, a request for a person and urgency are decided on their own bars', async () => {
    vi.stubGlobal('fetch', fakeFetch(() => ({ json: intentAnswers('help_center_question', 0.6, { spam: 0.95 }) })).impl);
    expect(await classifyVisitorIntent({ message, providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('live') })).toMatchObject({
      isSpam: true,
      source: 'jev',
    });
    vi.stubGlobal('fetch', fakeFetch(() => ({ json: intentAnswers('account_specific', 0.6, { wantsHuman: 0.9 }) })).impl);
    expect(await classifyVisitorIntent({ message, providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('live') })).toMatchObject({
      intent: 'wants_human',
      source: 'jev',
    });
    vi.stubGlobal('fetch', fakeFetch(() => ({ json: intentAnswers('account_specific', 0.92, { urgent: 0.9 }) })).impl);
    expect(await classifyVisitorIntent({ message, providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('live') })).toMatchObject({
      intent: 'account_specific',
      isUrgent: true,
    });
    expect(chat).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shadow: the yes/no answers are only recorded', async () => {
    vi.stubGlobal('fetch', fakeFetch(() => ({ json: intentAnswers('help_center_question', 0.6, { spam: 0.99, wantsHuman: 0.99 }) })).impl);
    const r = await classifyVisitorIntent({ message, providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('shadow') });
    expect(r.isSpam).toBeUndefined();
    expect(r.intent).toBe('help_center_question');
    vi.unstubAllGlobals();
  });

  it('obvious spam is caught by the rules: no model, no Jev', async () => {
    const f = fakeFetch(() => ({ json: intentAnswers('small_talk', 0.99) }));
    vi.stubGlobal('fetch', f.impl);
    const r = await classifyVisitorIntent({ message: 'Earn $5000 daily click here', providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('live') });
    expect(r).toMatchObject({ isSpam: true, source: 'rules' });
    expect(f.calls).toHaveLength(0);
    expect(chat).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rules that are certain still need no model and no Jev', async () => {
    const f = fakeFetch(() => ({ json: intentAnswers('small_talk', 0.99) }));
    vi.stubGlobal('fetch', f.impl);
    const r = await classifyVisitorIntent({ message: 'hi', providerConfig: deepseek, workspaceName: 'Acme', jev: runtime('live') });
    expect(r.source).toBe('rules');
    expect(f.calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
