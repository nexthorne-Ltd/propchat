/**
 * The workspace's own agent in front of the built-in bot: which URLs may be
 * called, how its answer is read, and that every failure hands the message
 * back to the built-in bot instead of leaving the customer unanswered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}), hasServiceRole: () => true }));
vi.mock('@/lib/ai/help-answer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/help-answer')>()),
  buildModelContext: async () => ({
    text: '[CHUNK 1]\nArticle: Daily drawdown\n\nStep 1 and Step 2 may lose 4% a day.',
    used: [],
    confidence: 'high',
    sources: [{ id: 'art-1', title: 'Daily drawdown', slug: 'daily-drawdown', url: 'https://help.example/daily-drawdown' }],
  }),
}));

import { answerWithExternalAgent, checkAgentUrl, parseAgentReply, type ExternalAgentConfig } from '@/lib/agent/external-agent';

const config: ExternalAgentConfig = { enabled: true, autoPilot: true, url: 'https://agent.example.com/zentry', apiKey: 'secret-1', systemPrompt: null };
const input = {
  workspaceId: 'ws-1',
  conversationId: 'conv-1',
  incomingMessage: 'what is the daily loss limit?',
  channel: 'web',
  visitorName: 'Sara',
  turns: [{ role: 'user' as const, content: 'what is the daily loss limit?' }],
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('checkAgentUrl', () => {
  it.each(['https://agent.example.com/zentry', 'https://my-graph.langchain.app/runs?x=1'])('allows %s', (url) => {
    expect(checkAgentUrl(url).ok).toBe(true);
  });

  it.each([
    ['plain http', 'http://agent.example.com'],
    ['localhost', 'https://localhost:8000/agent'],
    ['a loopback address', 'https://127.0.0.1/agent'],
    ['a private network', 'https://10.0.0.5/agent'],
    ['a private network (192.168)', 'https://192.168.1.10/agent'],
    ['the cloud metadata address', 'https://169.254.169.254/latest'],
    ['an IPv6 literal', 'https://[::1]/agent'],
    ['an internal name', 'https://service.internal/agent'],
    ['a bare host name', 'https://agent/run'],
    ['credentials in the URL', 'https://user:pass@agent.example.com'],
    ['nonsense', 'not a url'],
  ])('refuses %s', (_label, url) => {
    expect(checkAgentUrl(url).ok).toBe(false);
  });
});

describe('parseAgentReply', () => {
  it.each([
    [{ response: 'Hi' }, 'Hi'],
    [{ content: 'Hi' }, 'Hi'],
    [{ message: 'Hi' }, 'Hi'],
    [{ output: 'Hi' }, 'Hi'],
  ])('reads %j', (body, text) => {
    expect(parseAgentReply(body)?.text).toBe(text);
  });

  it('reads an escalation, with or without text', () => {
    expect(parseAgentReply({ action: 'escalate', priority: 'urgent' })).toMatchObject({ action: 'escalate', priority: 'urgent', text: '' });
    expect(parseAgentReply({ action: 'handover', response: 'Passing you on' })?.action).toBe('escalate');
  });

  it('finds nothing in an empty or odd answer', () => {
    expect(parseAgentReply({})).toBeNull();
    expect(parseAgentReply({ response: '   ' })).toBeNull();
    expect(parseAgentReply('hello')).toBeNull();
  });

  it('caps a very long answer', () => {
    expect(parseAgentReply({ response: 'x'.repeat(10_000) })?.text).toHaveLength(4000);
  });
});

describe('answerWithExternalAgent', () => {
  it('stays out of the way when the agent is off, not answering, or has no URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const c of [{ ...config, enabled: false }, { ...config, autoPilot: false }, { ...config, url: null }, null]) {
      expect(await answerWithExternalAgent(input, c)).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the agent's answer, and sends it the key, the conversation and the retrieved passages", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ response: 'It is 4% a day on Step 1 and Step 2.' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await answerWithExternalAgent(input, config);
    expect(r).toMatchObject({ replyText: 'It is 4% a day on Step 1 and Step 2.', shouldHandover: false, engine: 'external_agent' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://agent.example.com/zentry');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-1');
    expect(init.redirect).toBe('manual');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ event: 'message', conversation_id: 'conv-1', current_message: 'what is the daily loss limit?', language: 'en' });
    expect(body.context).toContain('4% a day');
    expect(body.sources[0]).toMatchObject({ title: 'Daily drawdown' });
  });

  it('turns an escalation into a handover with the agent note for the team, keeping the bot on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ action: 'escalate', response: 'Let me get a colleague.', internal_note: 'VIP customer' })));
    const r = await answerWithExternalAgent(input, config);
    expect(r).toMatchObject({ replyText: 'Let me get a colleague.', shouldHandover: true, disableAi: false, engine: 'external_agent' });
    expect(r?.internalNote).toContain('Agent note: VIP customer');
  });

  it.each([
    ['an HTTP error', () => jsonResponse({ error: 'boom' }, 500)],
    ['a redirect', () => new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/' } })],
    ['an answer that is not JSON', () => new Response('ok', { status: 200 })],
    ['an empty answer', () => jsonResponse({ response: '' })],
  ])('hands the message back to the built-in bot on %s', async (_label, make) => {
    vi.stubGlobal('fetch', vi.fn(async () => make()));
    expect(await answerWithExternalAgent(input, config)).toBeNull();
  });

  it('hands the message back when the agent cannot be reached or times out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }));
    expect(await answerWithExternalAgent(input, config)).toBeNull();
  });

  it('never calls a URL that fails the safety check, even if it was saved', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await answerWithExternalAgent(input, { ...config, url: 'https://127.0.0.1/agent' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
