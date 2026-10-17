/**
 * A second opinion for the sub-agent router, only where its rules are unsure.
 *
 * routeSubAgent (sub-agents.ts) is rules only: fast, free and right for most
 * messages. It is unsure in two cases: several topics score the same and
 * TIE_ORDER picks one ("payout kab milega, KYC pending hai"), or no topic
 * matches at all and the message goes to General ("bhai woh wala masla abhi
 * tak solve nahi hua"). There, and only there:
 *
 *   1. Jev (TypeSafe) picks from the candidates in ~100 ms, when the platform
 *      has Jev on with routing enabled. Live mode and confident enough: Jev
 *      decides. Shadow mode: only logged.
 *   2. Otherwise the workspace's model picks, in one tiny call (a few tokens,
 *      4 s at most).
 *   3. Any failure or an answer that is not a candidate: the rules' pick stands.
 *
 * The rules' own pick is always listed first (Jev leans to the first option),
 * so a second opinion moves a message only when it clearly belongs elsewhere.
 * Switched-off specialists are not offered. Every decision is logged as
 * `route_assist` in ai_reply_events (no message text).
 */
import { serviceClient } from '@/lib/supabase/service';
import { logAiEvent } from './bot-control';
import { jevRoute, type JevRuntime } from './jev';
import { chat, isConfigured, type ProviderConfig } from './provider';
import { SUB_AGENT_BY_ID, SUB_AGENTS, type RouteResult, type SubAgentId } from './sub-agents';
import { understandMessage } from './understanding';

export const ROUTE_ASSIST_TIMEOUT_MS = 4_000;

/** Specialists a second opinion may choose from: the model-answered ones. */
const ROUTABLE: SubAgentId[] = SUB_AGENTS.filter((a) => a.engine === 'model').map((a) => a.id);

export interface AssistInput {
  workspaceId: string;
  conversationId: string;
  message: string;
  recent?: { role: string; content: string }[];
  route: RouteResult;
  jev?: JevRuntime | null;
  providerConfig?: ProviderConfig | null;
  enabled: (id: SubAgentId) => boolean;
}

/** The options to offer, the rules' pick first. */
export function assistOptions(route: RouteResult, enabled: (id: SubAgentId) => boolean): SubAgentId[] {
  const pool = route.certainty === 'tie' && route.candidates?.length ? route.candidates : ROUTABLE;
  const ordered = [route.agent, ...pool.filter((id) => id !== route.agent)];
  return ordered.filter((id) => ROUTABLE.includes(id) && (id === route.agent || enabled(id)));
}

/** Reads the model's one-word answer: an option id, or null. */
export function readModelChoice(text: string, options: SubAgentId[]): SubAgentId | null {
  const t = (text || '').toLowerCase().replace(/[`"'.\s]+/g, ' ').trim();
  const exact = options.find((id) => t === id);
  if (exact) return exact;
  // "account_status." or "The answer is kyc_status": the first option named.
  const named = options
    .map((id) => ({ id, at: t.indexOf(id) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at || b.id.length - a.id.length);
  return named[0]?.id ?? null;
}

export async function assistRoute(input: AssistInput): Promise<RouteResult> {
  const { route } = input;
  if (route.certainty !== 'tie' && route.certainty !== 'none') return { ...route, decidedBy: 'rules' };
  const options = assistOptions(route, input.enabled);
  if (options.length < 2) return { ...route, decidedBy: 'rules' };

  const reading = understandMessage(input.message).core;
  const log = (reason: string, detail: Record<string, unknown>) =>
    void logAiEvent(serviceClient(), {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      event: 'route_assist',
      reason,
      detail: { certainty: route.certainty, rules_pick: route.agent, options: options.length, ...detail },
    });

  // 1. Jev.
  const jev = input.jev && input.jev.settings.router ? input.jev : null;
  if (jev) {
    try {
      const v = await jevRoute(jev, {
        message: input.message,
        reading: reading !== input.message.toLowerCase() ? reading : null,
        recent: input.recent,
        options: Object.fromEntries(options.map((id) => [id, SUB_AGENT_BY_ID[id].summary])),
      });
      const choice = options.find((id) => id === v.choice) ?? null;
      const decides = jev.settings.mode === 'live' && choice !== null && v.confidence >= jev.settings.minRouteConfidence;
      log(decides ? 'jev_decided' : jev.settings.mode === 'live' ? 'jev_unsure' : 'jev_shadow', {
        jev_pick: v.choice,
        jev_confidence: Math.round(v.confidence * 1000) / 1000,
        agreed: v.choice === route.agent,
        latency_ms: v.latencyMs,
      });
      if (decides && choice) {
        return choice === route.agent
          ? { ...route, decidedBy: 'jev', certainty: 'sure' }
          : { agent: choice, reason: `Jev: about ${SUB_AGENT_BY_ID[choice].name.toLowerCase()}`, certainty: 'sure', decidedBy: 'jev' };
      }
    } catch (err) {
      log('jev_error', { error: String((err as Error)?.message || err).slice(0, 200) });
    }
  }

  // 2. The model.
  if (!isConfigured(input.providerConfig)) return { ...route, decidedBy: 'rules' };
  const started = Date.now();
  try {
    const list = options.map((id) => `${id}: ${SUB_AGENT_BY_ID[id].summary}`).join('\n');
    const earlier = (input.recent || [])
      .slice(-3)
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Support'}: ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`)
      .join('\n');
    const res = await chat(input.providerConfig!, {
      system: [
        'You route a prop-trading firm\'s support chat to one specialist.',
        'Customers write fast, in English, Roman Urdu or a mix, with typos and shorthand. Judge what they need, not the words.',
        `Reply with exactly one id from this list and nothing else:\n${list}`,
        `If none clearly fits, reply ${route.agent}.`,
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [earlier ? `Earlier:\n${earlier}\n` : '', `Latest message: ${input.message.slice(0, 800)}`, reading ? `Cleaned up: ${reading.slice(0, 300)}` : '']
            .filter(Boolean)
            .join('\n'),
        },
      ],
      maxTokens: 12,
      temperature: 0,
      reasoning: 'fast',
      timeoutMs: ROUTE_ASSIST_TIMEOUT_MS,
    });
    const choice = readModelChoice(res.text || '', options);
    log(choice ? 'model_decided' : 'model_unclear', { model_pick: choice, agreed: choice === route.agent, latency_ms: Date.now() - started });
    if (choice && choice !== route.agent) {
      return { agent: choice, reason: `Model: about ${SUB_AGENT_BY_ID[choice].name.toLowerCase()}`, certainty: 'sure', decidedBy: 'model' };
    }
    return { ...route, decidedBy: choice ? 'model' : 'rules' };
  } catch (err) {
    log('model_error', { error: String((err as Error)?.message || err).slice(0, 200), latency_ms: Date.now() - started });
    return { ...route, decidedBy: 'rules' };
  }
}
