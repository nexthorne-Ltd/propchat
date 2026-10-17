/**
 * One chat call, whichever model provider the workspace has configured.
 *
 * The AI code used to import the Anthropic SDK directly and hardcode Claude
 * model ids, so "add an API key" meant "add an Anthropic key" and nothing else.
 * Everything now goes through `chat()` below, and the workspace decides who
 * answers it.
 *
 * Adding a provider means adding one case here — nothing above this file knows
 * which one is in use.
 */

import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODELS as BASE_DEFAULT_MODELS } from './models';

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'compatible';

export interface ProviderConfig {
  provider: ProviderId;
  /** Model identifier as that provider spells it. */
  model?: string | null;
  apiKey?: string | null;
  /**
   * Only for `compatible`: the base URL of any OpenAI-shaped `/chat/completions`
   * endpoint — OpenRouter, Groq, Together, DeepSeek, a local Ollama, vLLM.
   * Covers the long tail without a case per vendor.
   */
  baseUrl?: string | null;
}

export interface ChatRequest {
  system: string;
  /** Oldest first. */
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  /** 0 keeps support answers close to the source text. */
  temperature?: number;
  /** Abandon a slow provider rather than hold a conversation open. */
  timeoutMs?: number;
  /**
   * 'fast' asks models that think before answering to (nearly) skip it. A
   * support reply grounded in retrieved articles gains little from thinking,
   * and on Gemini the thoughts cost seconds and count against maxTokens — a
   * 1024-token cap cut replies off mid-sentence. Ignored where unsupported.
   */
  reasoning?: 'fast' | 'default';
}

export interface ChatResult {
  text: string;
  provider: ProviderId;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}

/** Thrown for provider failures so callers can fall back deliberately. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly status?: number,
    /** False for a bad key or a bad request — retrying will not help. */
    readonly retryable = false
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Sensible current default per provider, used when the workspace has not named
 * a model. Overridable in Settings, because model names change faster than
 * this file does.
 */
export const DEFAULT_MODELS: Record<ProviderId, string> = BASE_DEFAULT_MODELS;

/** Fixed endpoints for the providers that speak OpenAI's shape. */
const OPENAI_SHAPED_BASE_URLS: Partial<Record<ProviderId, string>> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
  deepseek: 'DeepSeek',
  compatible: 'Other (OpenAI-compatible URL)',
};

/** Environment fallbacks, so a self-hosted deployment can set one key globally. */
function envKeyFor(provider: ProviderId): string | undefined {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'google':
      return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    case 'deepseek':
      return process.env.DEEPSEEK_API_KEY;
    case 'compatible':
      return process.env.AI_API_KEY;
  }
}

/** True when this config could actually reach a model. */
export function isConfigured(config: ProviderConfig | null | undefined): boolean {
  if (!config) return false;
  const key = config.apiKey || envKeyFor(config.provider);
  if (!key) return false;
  if (config.provider === 'compatible') {
    return Boolean(config.baseUrl && config.model);
  }
  return true;
}

/**
 * Chat threads rarely alternate cleanly: a thread usually opens with the
 * assistant's welcome line, and visitors send several messages in a row.
 * Anthropic and Gemini reject a conversation that starts with the assistant,
 * and Gemini rejects repeated roles, so turns are merged by role and the
 * conversation always starts with the user.
 */
function normalizeTurns(messages: ChatRequest['messages']): ChatRequest['messages'] {
  const out: ChatRequest['messages'] = [];
  for (const m of messages) {
    const content = (m.content || '').trim();
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n${content}`;
    } else {
      out.push({ role: m.role, content });
    }
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  if (!out.length) out.push({ role: 'user', content: '(no message)' });
  return out;
}

export async function chat(
  config: ProviderConfig,
  req: ChatRequest
): Promise<ChatResult> {
  const apiKey = config.apiKey || envKeyFor(config.provider);
  if (!apiKey) {
    throw new ProviderError('No API key configured', config.provider, undefined, false);
  }

  const model = config.model || DEFAULT_MODELS[config.provider];
  if (!model) {
    throw new ProviderError('No model configured', config.provider, undefined, false);
  }

  const timeoutMs = req.timeoutMs ?? 25_000;
  req = { ...req, messages: normalizeTurns(req.messages) };

  switch (config.provider) {
    case 'anthropic':
      return anthropicChat(apiKey, model, req, timeoutMs);
    case 'google':
      return googleChat(apiKey, model, req, timeoutMs);
    case 'openai':
    case 'deepseek':
      return openAiChat(
        apiKey,
        model,
        // The provider's own endpoint; a workspace may still override it, which
        // is how a proxy or a regional endpoint gets used.
        (config.baseUrl || OPENAI_SHAPED_BASE_URLS[config.provider])!.replace(/\/+$/, ''),
        req,
        timeoutMs,
        config.provider
      );
    case 'compatible': {
      if (!config.baseUrl) {
        throw new ProviderError('No base URL configured', 'compatible', undefined, false);
      }
      return openAiChat(
        apiKey,
        model,
        config.baseUrl.replace(/\/+$/, ''),
        req,
        timeoutMs,
        'compatible'
      );
    }
  }
}

/* ── Anthropic ────────────────────────────────────────────────────────── */

async function anthropicChat(
  apiKey: string,
  model: string,
  req: ChatRequest,
  timeoutMs: number
): Promise<ChatResult> {
  const client = new Anthropic({ apiKey, timeout: timeoutMs });

  try {
    const res = await client.messages.create({
      model,
      // Generous, because it is a ceiling rather than a target — and on models
      // that think before answering, a tight ceiling truncates the answer
      // itself. Reply length is controlled by the prompt.
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages: req.messages,
      // A support reply drawn from documentation is not a reasoning problem;
      // low effort keeps it fast and cheap.
      output_config: { effort: 'low' },
    } as Parameters<typeof client.messages.create>[0]);

    const message = res as Anthropic.Message;

    // A safety decline arrives as a normal 200 — check before reading content.
    if (message.stop_reason === 'refusal') {
      throw new ProviderError('The model declined this request', 'anthropic', 200, false);
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const tokensIn = message.usage?.input_tokens ?? 0;
    const tokensOut = message.usage?.output_tokens ?? 0;

    return { text, provider: 'anthropic', model, tokensIn, tokensOut };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Anthropic.APIError) {
      throw new ProviderError(
        err.message,
        'anthropic',
        err.status,
        err.status === 429 || (err.status ?? 0) >= 500
      );
    }
    throw new ProviderError(
      err instanceof Error ? err.message : 'Request failed',
      'anthropic',
      undefined,
      true
    );
  }
}

/* ── OpenAI and anything that speaks its shape ────────────────────────── */

/** Hybrid models that answer directly when told `thinking: false` (checked against DeepInfra). */
const THINKING_SWITCH_MODELS = /deepseek|qwen/i;

/** Room for a reasoning model's thinking, on top of the answer's own cap. */
const REASONING_HEADROOM_TOKENS = 2048;

/** Drops `<think>…</think>` (and an unclosed one) from a reply. */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/^[\s\S]*?<\/think(?:ing)?>/i, '')
    .replace(/<think(?:ing)?>[\s\S]*$/i, '');
}

async function openAiChat(
  apiKey: string,
  model: string,
  baseUrl: string,
  req: ChatRequest,
  timeoutMs: number,
  provider: ProviderId
): Promise<ChatResult> {
  // Hybrid models served behind OpenAI-shaped APIs (DeepSeek V4, Qwen 3 on
  // DeepInfra, vLLM, ...) think before every answer unless the chat template
  // is told not to, and never return the thinking. On the platform model that
  // tripled a 20-token intent call (~6 s against ~2 s) and timed most of them
  // out. Only compatible servers get the switch; a server that rejects it
  // gets the call again without it.
  //
  // Only models known to obey the switch get it: GLM 5 treats it as "think
  // in the answer" and wrote its reasoning into the reply the visitor sees.
  // Any other model on a compatible server may think, so its token cap gets
  // room for that on top of the answer; with only the answer's budget, GLM
  // spent all of it thinking and returned an empty reply. (A cap is not a
  // charge: a model that does not think uses no more than before.)
  const noThinking = req.reasoning === 'fast' && provider === 'compatible' && THINKING_SWITCH_MODELS.test(model);
  const maxTokens =
    (req.maxTokens ?? 4096) + (provider === 'compatible' && !noThinking ? REASONING_HEADROOM_TOKENS : 0);
  const send = (withSwitch: boolean) =>
    fetchJson(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          // OpenAI's newer models require max_completion_tokens and reject
          // max_tokens; DeepSeek and most compatible servers only know
          // max_tokens. Sending the wrong one is a 400, so pick by provider.
          ...(provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
          messages: [
            { role: 'system', content: req.system },
            ...req.messages,
          ],
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(withSwitch ? { chat_template_kwargs: { thinking: false, enable_thinking: false } } : {}),
        }),
      },
      timeoutMs,
      provider
    );

  let res;
  try {
    res = await send(noThinking);
  } catch (err) {
    if (!noThinking || (err as ProviderError)?.status !== 400) throw err;
    res = await send(false);
  }

  // Some servers return the reasoning inline; the visitor must never see it.
  const text: string = stripReasoning(res?.choices?.[0]?.message?.content ?? '');
  const tokensIn = res?.usage?.prompt_tokens ?? 0;
  const tokensOut = res?.usage?.completion_tokens ?? 0;
  return { text: text.trim(), provider, model, tokensIn, tokensOut };
}

/* ── Google Gemini ────────────────────────────────────────────────────── */

/**
 * The thinking control differs by generation: Gemini 3 takes a level, 2.5 a
 * token budget (Pro cannot go below 128). Older models have no thinking, and
 * sending either field to them is rejected, so they get nothing.
 */
function googleFastThinking(model: string): Record<string, unknown> {
  const m = model.toLowerCase();
  if (/^gemini-[3-9]/.test(m)) {
    return { thinkingConfig: { thinkingBudget: 0 } };
  }
  if (m.startsWith('gemini-2.5')) {
    return { thinkingConfig: { thinkingBudget: m.includes('pro') ? 128 : 0 } };
  }
  return {};
}

async function googleChat(
  apiKey: string,
  model: string,
  req: ChatRequest,
  timeoutMs: number
): Promise<ChatResult> {
  try {
    // Gemini keeps the system prompt in its own field and calls the assistant
    // role "model".
    const res = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: req.messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            maxOutputTokens: req.maxTokens ?? 4096,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.reasoning === 'fast' ? googleFastThinking(model) : {}),
          },
        }),
      },
      timeoutMs,
      'google'
    );

    const text: string =
      res?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || '')
        .join('') ?? '';
    const tokensIn = res?.usageMetadata?.promptTokenCount ?? 0;
    const tokensOut = res?.usageMetadata?.candidatesTokenCount ?? 0;
    return { text: text.trim(), provider: 'google', model, tokensIn, tokensOut };
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 429 || err.status === 404 || err.status === 503 || err.status === 500)) {
      if (model !== 'gemini-3.8-flash' && model !== 'gemini-3.1-flash-lite') {
        console.warn(`[ai] google ${model} failed with ${err.status}, retrying with gemini-3.8-flash`);
        return googleChat(apiKey, 'gemini-3.8-flash', req, timeoutMs);
      }
      if (model === 'gemini-3.8-flash') {
        console.warn(`[ai] google gemini-3.8-flash failed with ${err.status}, retrying with gemini-3.1-flash-lite`);
        return googleChat(apiKey, 'gemini-3.1-flash-lite', req, timeoutMs);
      }
    }
    throw err;
  }
}

/* ── Images (vision) ──────────────────────────────────────────────────── */

/**
 * Providers whose chat models read images. DeepSeek's chat model does not;
 * an OpenAI-compatible server may, so it is tried in OpenAI's shape.
 */
export const VISION_PROVIDERS: ProviderId[] = ['google', 'openai', 'anthropic', 'compatible'];

export interface VisionRequest {
  system: string;
  prompt: string;
  image: { mimeType: string; base64: string };
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * One call with one image, kept apart from chat() so the text path (turn
 * merging, thinking switches) is untouched. Throws ProviderError like chat().
 */
export async function visionChat(config: ProviderConfig, req: VisionRequest): Promise<ChatResult> {
  const apiKey = config.apiKey || envKeyFor(config.provider);
  if (!apiKey) throw new ProviderError('No API key configured', config.provider, undefined, false);
  if (!VISION_PROVIDERS.includes(config.provider)) {
    throw new ProviderError(`${PROVIDER_LABELS[config.provider]} cannot read images`, config.provider, undefined, false);
  }
  const model = config.model || DEFAULT_MODELS[config.provider];
  if (!model) throw new ProviderError('No model configured', config.provider, undefined, false);
  const timeoutMs = req.timeoutMs ?? 10_000;
  const maxTokens = req.maxTokens ?? 400;

  if (config.provider === 'anthropic') {
    const client = new Anthropic({ apiKey, timeout: timeoutMs });
    try {
      const res = (await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: req.system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: req.image.mimeType, data: req.image.base64 } },
              { type: 'text', text: req.prompt },
            ],
          },
        ],
      } as Parameters<typeof client.messages.create>[0])) as Anthropic.Message;
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { text, provider: 'anthropic', model, tokensIn: res.usage?.input_tokens ?? 0, tokensOut: res.usage?.output_tokens ?? 0 };
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new ProviderError(err.message, 'anthropic', err.status, err.status === 429 || (err.status ?? 0) >= 500);
      }
      throw new ProviderError(err instanceof Error ? err.message : 'Request failed', 'anthropic', undefined, true);
    }
  }

  if (config.provider === 'google') {
    const res = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ inline_data: { mime_type: req.image.mimeType, data: req.image.base64 } }, { text: req.prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0, ...googleFastThinking(model) },
        }),
      },
      timeoutMs,
      'google'
    );
    const text: string = res?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') ?? '';
    return { text: text.trim(), provider: 'google', model, tokensIn: res?.usageMetadata?.promptTokenCount ?? 0, tokensOut: res?.usageMetadata?.candidatesTokenCount ?? 0 };
  }

  const baseUrl = (config.baseUrl || OPENAI_SHAPED_BASE_URLS[config.provider] || '').replace(/\/+$/, '');
  if (!baseUrl) throw new ProviderError('No base URL configured', config.provider, undefined, false);
  const res = await fetchJson(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        ...(config.provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
        messages: [
          { role: 'system', content: req.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: req.prompt },
              { type: 'image_url', image_url: { url: `data:${req.image.mimeType};base64,${req.image.base64}` } },
            ],
          },
        ],
      }),
    },
    timeoutMs,
    config.provider
  );
  const text: string = stripReasoning(res?.choices?.[0]?.message?.content ?? '');
  return { text: text.trim(), provider: config.provider, model, tokensIn: res?.usage?.prompt_tokens ?? 0, tokensOut: res?.usage?.completion_tokens ?? 0 };
}

/* ── Shared HTTP ──────────────────────────────────────────────────────── */

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: ProviderId
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as { name?: string; message?: string };
    throw new ProviderError(
      e?.name === 'TimeoutError' ? 'Provider timed out' : e?.message || 'Network error',
      provider,
      undefined,
      true
    );
  }

    if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message || parsed?.message || detail;
    } catch {
      /* not JSON; the raw body is the best detail available */
    }

    if (provider === 'deepseek') {
      if (res.status === 401 || detail.includes('Authentication Fails')) {
        detail = 'Invalid DeepSeek API key. Please check your key at platform.deepseek.com.';
      } else if (res.status === 402 || detail.toLowerCase().includes('balance')) {
        detail = 'Insufficient DeepSeek account balance. Please recharge credits in your DeepSeek account (platform.deepseek.com).';
      }
    } else if (provider === 'openai') {
      if (res.status === 401) {
        detail = 'Invalid OpenAI API key. Please check your API key at platform.openai.com.';
      }
    }

    throw new ProviderError(
      detail || `HTTP ${res.status}`,
      provider,
      res.status,
      res.status === 429 || res.status >= 500
    );
  }

  return res.json();
}

/**
 * A one-shot call used by Settings to tell the owner whether their key works,
 * before a customer finds out for them.
 */
export async function testProvider(
  config: ProviderConfig
): Promise<{ ok: boolean; model?: string; error?: string }> {
  try {
    const res = await chat(config, {
      system: 'Reply with the single word: ready',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
      timeoutMs: 20_000,
    });
    return { ok: true, model: res.model };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
