/**
 * The thinking switch on OpenAI-shaped providers: sent to compatible servers
 * for fast calls, never to OpenAI itself, and dropped when a server rejects it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, type ProviderConfig } from '@/lib/ai/provider';

const compatible: ProviderConfig = { provider: 'compatible', apiKey: 'k', model: 'deepseek-v4', baseUrl: 'https://llm.example/v1' };
const openai: ProviderConfig = { provider: 'openai', apiKey: 'k', model: 'gpt-x', baseUrl: null };

const ok = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
    status: 200,
  });
const sentBodies = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

afterEach(() => vi.unstubAllGlobals());

describe('thinking switch', () => {
  it('turns thinking off on a compatible server for fast calls', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await chat(compatible, { system: 's', messages: [{ role: 'user', content: 'x' }], reasoning: 'fast' });
    expect(sentBodies(fetchMock)[0].chat_template_kwargs).toEqual({ thinking: false, enable_thinking: false });
  });

  it('leaves default calls and OpenAI alone', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await chat(compatible, { system: 's', messages: [{ role: 'user', content: 'x' }] });
    await chat(openai, { system: 's', messages: [{ role: 'user', content: 'x' }], reasoning: 'fast' });
    for (const body of sentBodies(fetchMock)) expect(body.chat_template_kwargs).toBeUndefined();
  });

  it('never sends the switch to a model that writes its thinking into the answer (GLM)', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const glm: ProviderConfig = { ...compatible, model: 'zai-org/GLM-5.3' };
    await chat(glm, { system: 's', messages: [{ role: 'user', content: 'x' }], reasoning: 'fast', maxTokens: 160 });
    const [body] = sentBodies(fetchMock);
    expect(body.chat_template_kwargs).toBeUndefined();
    // Room to think on top of the answer, or the whole cap goes on thinking.
    expect(body.max_tokens).toBeGreaterThan(1000);
  });

  it('keeps the exact cap when thinking is switched off, and on OpenAI', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await chat(compatible, { system: 's', messages: [{ role: 'user', content: 'x' }], reasoning: 'fast', maxTokens: 160 });
    await chat(openai, { system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 160 });
    const [a, b] = sentBodies(fetchMock);
    expect(a.max_tokens).toBe(160);
    expect(b.max_completion_tokens).toBe(160);
  });

  it('removes inline reasoning before anyone sees it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '<think>The user wants the limit.</think>The limit is 3%.' } }] }), {
          status: 200,
        })
      )
    );
    const res = await chat(compatible, { system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(res.text).toBe('The limit is 3%.');
  });

  it('retries without the switch when the server rejects it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'unknown field chat_template_kwargs' } }), { status: 400 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const res = await chat(compatible, { system: 's', messages: [{ role: 'user', content: 'x' }], reasoning: 'fast' });
    expect(res.text).toBe('hi');
    const [first, second] = sentBodies(fetchMock);
    expect(first.chat_template_kwargs).toBeDefined();
    expect(second.chat_template_kwargs).toBeUndefined();
  });
});
