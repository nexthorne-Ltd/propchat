/**
 * The workspace's own agent (LangGraph or any HTTP endpoint), in front of the
 * built-in bot.
 *
 * When Settings → AI bot → LangGraph is on, every visitor message the
 * auto-respond route would answer (widget, chat API, channels) is offered to
 * the workspace's endpoint first, with the conversation and the help-center
 * passages retrieved for it. Its answer is delivered exactly like the
 * built-in bot's, through fn_deliver_ai_reply, so a person taking over, the
 * bot being switched off and duplicate replies are handled the same way. If
 * the endpoint fails, times out or answers with nothing, the built-in bot
 * answers instead: the visitor never waits on someone else's outage.
 *
 * The endpoint's URL is chosen by a workspace admin and called from our
 * servers, so it is held to https on a public host (checkAgentUrl) and
 * redirects are not followed; otherwise this would be a way to make the
 * platform call its own internal network.
 *
 * Contract (docs/LANGGRAPH.md):
 *   request  { event, version, conversation_id, workspace_id, channel, visitor,
 *              current_message, history[], context, sources[], system_prompt,
 *              language, human_context }
 *   response { response | content | message | output, action?: "reply" | "escalate",
 *              priority?, internal_note? }
 */
import { serviceClient } from '@/lib/supabase/service';
import { buildModelContext } from '@/lib/ai/help-answer';
import { buildHandoverSummary, classifyByRules, noAnswerHandoverReply, replyLanguageOf } from '@/lib/ai/intent';
import type { HelpDeskResponseResult, HumanContext } from '@/lib/ai/anthropic';

export interface ExternalAgentConfig {
  enabled: boolean;
  autoPilot: boolean;
  url: string | null;
  apiKey: string | null;
  systemPrompt: string | null;
}

/** Leaves room inside the route's 35 s budget for the built-in fallback. */
export const EXTERNAL_AGENT_TIMEOUT_MS = 15_000;
const MAX_REPLY_LENGTH = 4000;

/* ── URL safety ───────────────────────────────────────────────────────── */

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * Whether an admin-supplied URL may be called from our servers: https, a
 * public host name or address, no credentials in the URL. (A public name that
 * resolves to a private address is not caught here; redirects are refused at
 * call time, which closes the easier route.)
 */
export function checkAgentUrl(raw: string | null | undefined): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, reason: 'Enter a full URL, starting with https://.' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'The agent URL must use https://.' };
  if (url.username || url.password) return { ok: false, reason: 'Put credentials in the API key field, not in the URL.' };
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.startsWith('[') ||
    host.includes(':') ||
    isPrivateIPv4(host) ||
    !host.includes('.')
  ) {
    return { ok: false, reason: 'The agent must be reachable on the public internet (no localhost or private addresses).' };
  }
  return { ok: true, url };
}

/* ── Config ───────────────────────────────────────────────────────────── */

export async function loadExternalAgent(workspaceId: string): Promise<ExternalAgentConfig | null> {
  const { data, error } = await serviceClient()
    .from('workspace_integrations')
    .select('langgraph_enabled, langgraph_auto_pilot, langgraph_webhook_url, langgraph_api_key, langgraph_system_prompt')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) {
    console.warn('[External Agent] Could not load settings:', error.message);
    return null;
  }
  if (!data) return null;
  return {
    enabled: Boolean(data.langgraph_enabled),
    autoPilot: data.langgraph_auto_pilot !== false,
    url: data.langgraph_webhook_url?.trim() || null,
    apiKey: data.langgraph_api_key?.trim() || null,
    systemPrompt: data.langgraph_system_prompt?.trim() || null,
  };
}

/** On, answering on its own, and pointed somewhere. */
export function externalAgentActive(config: ExternalAgentConfig | null): config is ExternalAgentConfig & { url: string } {
  return Boolean(config?.enabled && config.autoPilot && config.url);
}

/* ── Calling the agent ────────────────────────────────────────────────── */

export interface AgentReply {
  text: string;
  action: 'reply' | 'escalate';
  priority: 'normal' | 'high' | 'urgent';
  internalNote: string | null;
}

/** Reads the agent's answer; null when there is nothing usable in it. */
export function parseAgentReply(body: unknown): AgentReply | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const raw = [b.response, b.content, b.message, b.output, b.text].find((v) => typeof v === 'string') as string | undefined;
  const text = (raw || '').trim().slice(0, MAX_REPLY_LENGTH);
  const action = b.action === 'escalate' || b.action === 'handover' ? 'escalate' : 'reply';
  if (!text && action === 'reply') return null;
  const priority = b.priority === 'urgent' || b.priority === 'normal' ? b.priority : 'high';
  const internalNote = typeof b.internal_note === 'string' && b.internal_note.trim() ? b.internal_note.trim().slice(0, 2000) : null;
  return { text, action, priority, internalNote };
}

export class AgentCallError extends Error {}

/** One POST to the agent; throws AgentCallError with a reason a person can act on. */
export async function callAgent(
  config: { url: string; apiKey: string | null },
  payload: Record<string, unknown>,
  timeoutMs = EXTERNAL_AGENT_TIMEOUT_MS
): Promise<{ reply: AgentReply | null; latencyMs: number }> {
  const checked = checkAgentUrl(config.url);
  if (!checked.ok) throw new AgentCallError(checked.reason);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(checked.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Zentry-Agent-Bridge/1',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as { name?: string; message?: string };
    throw new AgentCallError(e?.name === 'TimeoutError' ? `No answer within ${Math.round(timeoutMs / 1000)} s.` : `Could not reach the agent (${e?.message || 'network error'}).`);
  }
  const latencyMs = Date.now() - started;
  if (res.status >= 300 && res.status < 400) throw new AgentCallError(`The agent answered with a redirect (HTTP ${res.status}); use its final URL.`);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160);
    throw new AgentCallError(`The agent returned HTTP ${res.status}${detail ? `: ${detail}` : ''}.`);
  }
  const body = await res.json().catch(() => null);
  if (body === null) throw new AgentCallError('The agent did not answer with JSON.');
  return { reply: parseAgentReply(body), latencyMs };
}

/* ── In the bot pipeline ──────────────────────────────────────────────── */

export interface ExternalAgentInput {
  workspaceId: string;
  conversationId: string;
  incomingMessage: string;
  channel: string;
  visitorName?: string | null;
  turns: { role: 'user' | 'assistant'; content: string }[];
  humanContext?: HumanContext | null;
  /** The built-in bot's custom instructions, used when the agent has none of its own. */
  workspaceSystemPrompt?: string | null;
}

/**
 * The agent's answer in the shape the auto-respond route delivers, or null
 * when the built-in bot should answer (agent off, failing, or empty).
 */
export async function answerWithExternalAgent(
  input: ExternalAgentInput,
  config?: ExternalAgentConfig | null
): Promise<HelpDeskResponseResult | null> {
  const agent = config === undefined ? await loadExternalAgent(input.workspaceId) : config;
  if (!externalAgentActive(agent)) return null;

  const lang = replyLanguageOf(input.incomingMessage);
  try {
    const retrieved = await buildModelContext(input.workspaceId, input.incomingMessage, {
      turns: input.turns.slice(-6),
      limit: 5,
      articlesOnly: true,
    }).catch(() => null);

    const { reply, latencyMs } = await callAgent(agent, {
      event: 'message',
      version: 1,
      conversation_id: input.conversationId,
      workspace_id: input.workspaceId,
      channel: input.channel,
      visitor: { name: input.visitorName || null },
      current_message: input.incomingMessage,
      history: input.turns.slice(-20).map((t) => ({ role: t.role, content: t.content })),
      context: retrieved?.text || '',
      sources: (retrieved?.sources || []).map((s) => ({ id: s.id, title: s.title, url: s.url })),
      system_prompt: agent.systemPrompt || input.workspaceSystemPrompt || null,
      language: lang,
      human_context: input.humanContext ? { last_reply: input.humanContext.lastReply, at: input.humanContext.at } : null,
    });
    console.log('[External Agent] Answered in', latencyMs, 'ms');
    if (!reply) {
      console.warn('[External Agent] Empty answer; the built-in bot answers instead.');
      return null;
    }

    if (reply.action === 'escalate') {
      const intent = { ...classifyByRules(input.incomingMessage, input.turns), reason: 'Your agent escalated this conversation' };
      return {
        replyText: reply.text || noAnswerHandoverReply(lang),
        shouldHandover: true,
        handoverReason: 'External agent escalated to a human',
        canAnswerFromDocs: false,
        intent: intent.intent,
        intentSource: 'model',
        internalNote: [
          buildHandoverSummary({ intent, message: input.incomingMessage, recentMessages: input.turns, lang }),
          reply.internalNote ? `Agent note: ${reply.internalNote}` : null,
        ].filter(Boolean).join('\n'),
        disableAi: false,
        priority: reply.priority,
        engine: 'external_agent',
      };
    }

    return {
      replyText: reply.text,
      shouldHandover: false,
      canAnswerFromDocs: Boolean(retrieved?.sources?.length),
      intentSource: 'model',
      disableAi: false,
      engine: 'external_agent',
    };
  } catch (err) {
    console.warn('[External Agent] Unavailable, the built-in bot answers instead:', (err as Error)?.message);
    return null;
  }
}
