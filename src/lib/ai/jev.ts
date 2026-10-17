/*
 * Jev, TypeSafe's "System One" model, beside the bot's generative model.
 *
 * DeepSeek (or whichever provider the workspace chose) writes replies. Jev
 * never writes text: it answers typed questions about a piece of state in
 * ~100 ms, in a fixed shape with calibrated probabilities. The bot uses it for
 * two decisions:
 *
 *   1. intent: what the visitor wants (the same five intents as intent.ts),
 *      plus "asks for a person", "how upset", "urgent" and "spam" in the
 *      same call (one request per message);
 *   2. grounding: is a drafted answer supported by the passages it came from.
 *
 * Modes (platform_ai_settings.jev_settings, set by the super admin next to
 * the DeepSeek key): 'off'; 'shadow' runs Jev next to the
 * existing path and only records what it would have decided; 'live' lets a
 * confident Jev decide. Every failure (no key, timeout, 4xx/5xx, odd reply)
 * falls back to the existing path; Jev can never stop the bot from answering.
 *
 * API: POST https://api.typesafe.ai/v1/systemone (docs.typesafe.ai/api).
 * Known limits (docs, "Jev 1.13 jaggedness"): it leans to the first option,
 * loses accuracy on long, cluttered state, and reads instructions literally,
 * so state is kept short and the most common intent comes first.
 */
import { serviceClient } from '@/lib/supabase/service';
import type { VisitorIntent } from './intent';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

/*
 * Timing. Jev answers in ~100 ms, so 2 s per attempt is generous; a slower
 * answer is not worth waiting for, the existing path decides instead. One
 * retry, only for failures a second try can fix (rate limit, overload, 5xx,
 * a dropped connection). A timeout is not retried: it already cost the
 * visitor 2 s.
 */
export const JEV_TIMEOUT_MS = 2000;
export const JEV_MAX_RETRIES = 1;
export const JEV_RETRY_DELAY_MS = 200;

/*
 * Probability bars for the yes/no (noul) questions in the triage call. They
 * act only in live mode and sit high on purpose: a noul near 0.5 means Jev is
 * unsure, and a wrong "spam" or "very upset" costs more than a missed one
 * (the rules and the model still look at the message).
 */
export const JEV_THRESHOLDS = {
  /** Asks for a person: hand over without asking the model. */
  wantsHuman: 0.85,
  /** Top frustration level: reads as a complaint, which hands over at once. */
  veryUpset: 0.8,
  /** Time-critical: a handover reaches the team as urgent. */
  urgent: 0.8,
  /** Spam or a scam: no model is asked and nothing is handed over. */
  spam: 0.9,
} as const;

export type JevMode = 'off' | 'shadow' | 'live';

export interface JevSettings {
  mode: JevMode;
  /** Jev decides the intent (live) or is compared on it (shadow). */
  intent: boolean;
  /** Jev checks drafted help-center answers against their passages. */
  grounding: boolean;
  /** Live intent: below this confidence the existing path decides. */
  minConfidence: number;
  /** Live grounding: an answer scoring below this goes to the team instead. */
  minGrounding: number;
  /** Jev picks the specialist when the router's rules are unsure (a tie, or no topic). */
  router: boolean;
  /** Live routing: below this confidence the model (or the rules) decide. */
  minRouteConfidence: number;
}

export const DEFAULT_JEV_SETTINGS: JevSettings = {
  mode: 'off',
  intent: true,
  grounding: true,
  minConfidence: 0.75,
  minGrounding: 0.35,
  router: true,
  minRouteConfidence: 0.6,
};

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(hi, Math.max(lo, v));
};

export function normalizeJevSettings(raw: unknown): JevSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = r.mode === 'shadow' || r.mode === 'live' ? r.mode : 'off';
  return {
    mode,
    intent: r.intent !== false,
    grounding: r.grounding !== false,
    minConfidence: clamp(r.minConfidence, 0.5, 0.99, DEFAULT_JEV_SETTINGS.minConfidence),
    minGrounding: clamp(r.minGrounding, 0.05, 0.9, DEFAULT_JEV_SETTINGS.minGrounding),
    router: r.router !== false,
    minRouteConfidence: clamp(r.minRouteConfidence, 0.3, 0.99, DEFAULT_JEV_SETTINGS.minRouteConfidence),
  };
}

/** What a pipeline run needs: settings plus a key. Null means Jev is not in play. */
export interface JevRuntime {
  settings: JevSettings;
  apiKey: string;
}

/**
 * The platform's Jev setup (Super admin → Platform AI, the same row as the
 * DeepSeek key), or null when it is off or has no key. TYPESAFE_API_KEY on
 * the server stands in when no key is saved. One setup for every workspace,
 * like the generative model. Never throws.
 */
export async function loadJevRuntime(): Promise<JevRuntime | null> {
  try {
    const { data, error } = await serviceClient()
      .from('platform_ai_settings')
      .select('jev_settings, jev_api_key')
      .eq('id', true)
      .maybeSingle();
    // Before the migration has run the columns do not exist: Jev is simply off.
    if (error || !data) return null;
    const row = data as { jev_settings?: unknown; jev_api_key?: string | null };
    const settings = normalizeJevSettings(row.jev_settings);
    if (settings.mode === 'off') return null;
    const apiKey = (row.jev_api_key || process.env.TYPESAFE_API_KEY || '').trim();
    if (!apiKey) return null;
    return { settings, apiKey };
  } catch (err) {
    console.warn('[Jev] Could not load settings:', (err as Error)?.message);
    return null;
  }
}

/* ── API ──────────────────────────────────────────────────────────────── */

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface JevScoreAnswer {
  type: 'score';
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

/** Token counts from the response's `usage`; null when the API did not report them. */
export interface JevUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Checks one answer against the question asked; anything off is null. */
function readAnswer(q: JevQuestion, a: unknown): JevAnswer | null {
  const r = (a && typeof a === 'object' ? a : null) as Record<string, unknown> | null;
  if (!r) return null;
  // Every answer carries the type of its question (docs.typesafe.ai/api).
  if (r.type !== undefined && r.type !== q.type) return null;
  if (q.type === 'noul') {
    const v = num(r.noul);
    return v === null ? null : { type: 'noul', noul: Math.min(1, Math.max(0, v)) };
  }
  const probabilities =
    r.probabilities && typeof r.probabilities === 'object' ? (r.probabilities as Record<string, number>) : {};
  const confidence = num(r.confidence) ?? 0;
  if (q.type === 'choice') {
    const choice = typeof r.choice === 'string' ? r.choice : null;
    if (!choice || !(choice in q.criteria)) return null;
    return { type: 'choice', choice, probabilities, confidence };
  }
  const score = num(r.score);
  return score === null ? null : { type: 'score', score, probabilities, confidence };
}

// What a second try can fix: rate limit, overload, server errors. 4xx are ours.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

/** One HTTP attempt. `retryable` says whether trying again could help. */
async function postOnce(
  apiKey: string,
  payload: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<{ status: number; body: Record<string, unknown> | null } | { error: JevError; retryable: boolean }> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(opts.timeoutMs ?? JEV_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
    return timedOut
      ? { error: new JevError('Jev did not answer in time.', null), retryable: false }
      : { error: new JevError(`Could not reach Jev: ${(err as Error)?.message}`, null), retryable: true };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) return { status: res.status, body };
  const detail = typeof body?.detail === 'string' ? body.detail : typeof body?.error === 'string' ? body.error : '';
  const meaning =
    res.status === 401
      ? 'The TypeSafe API key was refused.'
      : res.status === 429
      ? 'TypeSafe rate limit reached.'
      : res.status === 529
      ? 'TypeSafe is overloaded right now.'
      : res.status === 422
      ? 'TypeSafe rejected the request.'
      : `TypeSafe returned ${res.status}.`;
  return {
    error: new JevError(detail ? `${meaning} ${detail}`.slice(0, 300) : meaning, res.status),
    retryable: RETRYABLE_STATUS.has(res.status),
  };
}

/**
 * One System One call, retried at most JEV_MAX_RETRIES times for a transient
 * failure. Throws JevError on any failure, including an answer that does not
 * match its question (never half-trusted). Latency covers every attempt.
 */
export async function askJev<Q extends Record<string, JevQuestion>>(
  apiKey: string,
  state: string | Record<string, unknown>,
  questions: Q,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; retries?: number } = {}
): Promise<{ answers: { [K in keyof Q]: JevAnswer }; model: string; latencyMs: number; usage: JevUsage; attempts: number }> {
  const started = Date.now();
  const retries = Math.max(0, Math.min(JEV_MAX_RETRIES, opts.retries ?? JEV_MAX_RETRIES));
  const payload = JSON.stringify({ model: JEV_MODEL, state, questions });
  let attempts = 0;
  let got: Awaited<ReturnType<typeof postOnce>>;
  for (;;) {
    attempts += 1;
    got = await postOnce(apiKey, payload, opts);
    if (!('error' in got)) break;
    if (!got.retryable || attempts > retries) throw got.error;
    await new Promise((resolve) => setTimeout(resolve, JEV_RETRY_DELAY_MS));
  }
  const { status, body } = got;
  const raw = (body?.answers && typeof body.answers === 'object' ? body.answers : {}) as Record<string, unknown>;
  const answers = {} as { [K in keyof Q]: JevAnswer };
  for (const key of Object.keys(questions) as (keyof Q)[]) {
    const answer = readAnswer(questions[key], raw[key as string]);
    if (!answer) throw new JevError(`Jev's answer to "${String(key)}" did not match the question.`, status);
    answers[key] = answer;
  }
  const usage = (body?.usage && typeof body.usage === 'object' ? body.usage : {}) as Record<string, unknown>;
  return {
    answers,
    model: typeof body?.model === 'string' ? body.model : JEV_MODEL,
    latencyMs: Date.now() - started,
    usage: { inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) },
    attempts,
  };
}

/* ── Decision 1: intent ──────────────────────────────────────────────── */

// Order matters (Jev leans to the first option): the most common intent first.
const INTENT_CRITERIA: Record<VisitorIntent, string> = {
  help_center_question:
    'A general question that a help article of this business could answer: products, pricing, plans, policies, rules, shipping, refunds in general, how-to, features, hours.',
  account_specific:
    "About the customer's OWN order, account, payment, booking, delivery or subscription: its status, a problem with it, or a request to change or cancel it. Needs someone who can look up their records.",
  small_talk: 'Only a greeting, thanks, acknowledgement, goodbye, "how are you", or a question about the bot itself.',
  out_of_scope:
    'A general question not about this business: general knowledge, definitions, maths, advice, recipes, weather, homework, trivia, other companies.',
  wants_human:
    'Asks for a person, agent or representative, accepts an offer to be connected, or is complaining angrily with no question to answer.',
};

export interface JevIntentVerdict {
  intent: VisitorIntent;
  confidence: number;
  /** Probability the visitor is asking for a person. */
  wantsHuman: number;
  /** Probability the visitor is very upset (top frustration level). */
  veryUpset: number;
  /** Probability the message is time-critical. */
  urgent: number;
  /** Probability the message is spam, a scam or advertising. */
  spam: number;
  latencyMs: number;
  usage: JevUsage;
  model: string;
}

export async function jevIntent(
  runtime: JevRuntime,
  input: {
    message: string;
    recent?: { role: string; content: string }[];
    workspaceName: string;
    topics?: string[];
  },
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<JevIntentVerdict> {
  // Short and relevant: Jev loses accuracy when state is cluttered.
  const earlier = (input.recent || [])
    .slice(-5, -1)
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Support'}: ${m.content.replace(/\s+/g, ' ').slice(0, 240)}`);
  const state = {
    business: input.workspaceName,
    help_center_topics: (input.topics || []).slice(0, 20),
    earlier_in_conversation: earlier,
    latest_customer_message: input.message.trim().slice(0, 1000),
    note: 'Messages may be in English, Roman Urdu (Urdu in Latin letters) or a mix. Judge the meaning, not the language. A greeting followed by a question is the question.',
  };
  // Every triage question rides in this one call: one request per message.
  const { answers, latencyMs, model, usage } = await askJev(
    runtime.apiKey,
    state,
    {
      intent: {
        type: 'choice',
        instructions: 'What does the latest customer message want?',
        criteria: INTENT_CRITERIA,
      },
      wants_human: {
        type: 'noul',
        instructions: 'The latest customer message asks to talk to a person, agent or human, or accepts being connected to one.',
      },
      frustration: {
        type: 'score',
        instructions: 'How upset the customer is in the latest message.',
        criteria: ['Calm or neutral', 'Annoyed but polite', 'Very angry, insulting or threatening'],
      },
      urgent: {
        type: 'noul',
        instructions:
          'The latest customer message says the problem is time-critical: it must be handled today or right now, or money or access is being lost.',
      },
      spam: {
        type: 'noul',
        instructions:
          'The latest customer message is spam, a scam, advertising or a get-rich-quick offer, not a real customer writing to this business.',
      },
    },
    { timeoutMs: JEV_TIMEOUT_MS, fetchImpl: opts.fetchImpl }
  );
  const intent = answers.intent as JevChoiceAnswer;
  const wantsHuman = answers.wants_human as JevNoulAnswer;
  const frustration = answers.frustration as JevScoreAnswer;
  return {
    intent: intent.choice as VisitorIntent,
    confidence: intent.confidence,
    wantsHuman: wantsHuman.noul,
    veryUpset: Number(frustration.probabilities?.['2'] ?? 0) || 0,
    urgent: (answers.urgent as JevNoulAnswer).noul,
    spam: (answers.spam as JevNoulAnswer).noul,
    latencyMs,
    usage,
    model,
  };
}

/* ── Decision 2: is the drafted answer supported? ─────────────────────── */

export interface JevGroundingVerdict {
  /** 0–1: probability the answer is fully supported by the passages. */
  supported: number;
  latencyMs: number;
  usage: JevUsage;
}

export async function jevGrounding(
  runtime: JevRuntime,
  input: { question: string; answer: string; passages: string },
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<JevGroundingVerdict> {
  const { answers, latencyMs, usage } = await askJev(
    runtime.apiKey,
    {
      customer_question: input.question.trim().slice(0, 800),
      drafted_answer: input.answer.trim().slice(0, 1500),
      // The passages the answer was written from; trimmed, Jev prefers short state.
      help_center_passages: input.passages.slice(0, 6000),
    },
    {
      supported: {
        type: 'noul',
        instructions:
          'Every fact, number, rule and promise in the drafted answer is stated in the help center passages. Greetings and polite phrases do not count.',
        criteria: {
          true: 'All facts in the drafted answer come from the passages.',
          false: 'The drafted answer states something the passages do not say, or contradicts them.',
        },
      },
    },
    { timeoutMs: JEV_TIMEOUT_MS, fetchImpl: opts.fetchImpl }
  );
  return { supported: (answers.supported as JevNoulAnswer).noul, latencyMs, usage };
}

/* ── Decision 3: which specialist, when the router's rules are unsure ── */

export interface JevRouteVerdict {
  /** One of the option ids given. */
  choice: string;
  confidence: number;
  latencyMs: number;
  usage: JevUsage;
}

/**
 * Picks one specialist from `options` (id → what it handles). The caller puts
 * the rules' own pick first: Jev leans to the first option, so it moves away
 * from the rules only when the message clearly says otherwise.
 */
export async function jevRoute(
  runtime: JevRuntime,
  input: {
    message: string;
    reading?: string | null;
    recent?: { role: string; content: string }[];
    options: Record<string, string>;
  },
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<JevRouteVerdict> {
  const earlier = (input.recent || [])
    .slice(-4, -1)
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Support'}: ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`);
  const state: Record<string, unknown> = {
    business_type: 'Proprietary trading (prop) firm: traders buy challenges, pass phases, get funded and request payouts.',
    earlier_in_conversation: earlier,
    latest_customer_message: input.message.trim().slice(0, 800),
    note: 'Messages may be in English, Roman Urdu or a mix, with typos and shorthand (dd = drawdown, acc = account). Judge the meaning.',
  };
  if (input.reading) state.cleaned_up_reading = input.reading.slice(0, 300);
  const { answers, latencyMs, usage } = await askJev(
    runtime.apiKey,
    state,
    {
      specialist: {
        type: 'choice',
        instructions: 'Which support specialist should answer the latest customer message?',
        criteria: input.options,
      },
    },
    { timeoutMs: JEV_TIMEOUT_MS, fetchImpl: opts.fetchImpl }
  );
  const a = answers.specialist as JevChoiceAnswer;
  return { choice: a.choice, confidence: a.confidence, latencyMs, usage };
}
