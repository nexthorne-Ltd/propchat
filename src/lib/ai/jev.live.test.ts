/**
 * Jev against the real TypeSafe API: the triage messages from the Jev audit,
 * run through the real classifier, printed with Jev's answer, confidence and
 * latency, plus accuracy for English and Roman Urdu separately.
 *
 * Skipped unless both are set on your own machine (never commit the key):
 *
 *   JEV_LIVE_TEST=1 TYPESAFE_API_KEY=... npx vitest run src/lib/ai/jev.live.test.ts
 *
 * Only Jev is real. Supabase and the generative model stay faked (no
 * providerConfig is passed, so the rules are the fallback), so nothing here
 * touches a database or DeepSeek.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}) }));
const chat = vi.hoisted(() => vi.fn());
vi.mock('./provider', async (orig) => ({ ...(await orig<typeof import('./provider')>()), chat }));

import { JEV_THRESHOLDS, jevGrounding, jevIntent, normalizeJevSettings, type JevIntentVerdict, type JevRuntime } from './jev';
import { classifyVisitorIntent, type IntentClassificationResult } from './intent';

const KEY = (process.env.TYPESAFE_API_KEY || '').trim();
const LIVE = process.env.JEV_LIVE_TEST === '1' && Boolean(KEY);

type Route = 'spam' | 'template' | 'human' | 'rag' | 'general';

/** Where the pipeline (generateHelpDeskResponseWithHandover) sends a classified message. */
function routeOf(r: IntentClassificationResult): Route {
  if (r.isSpam) return 'spam';
  if (r.isComplaint || r.intent === 'wants_human' || r.intent === 'account_specific') return 'human';
  if (r.intent === 'small_talk') return 'template';
  if (r.intent === 'out_of_scope') return 'general';
  return 'rag';
}

/** The same routing from Jev's answer alone, on the same bars. */
function jevRouteOf(v: JevIntentVerdict): Route {
  if (v.spam >= JEV_THRESHOLDS.spam) return 'spam';
  if (v.wantsHuman >= JEV_THRESHOLDS.wantsHuman || v.veryUpset >= JEV_THRESHOLDS.veryUpset) return 'human';
  if (v.intent === 'wants_human' || v.intent === 'account_specific') return 'human';
  if (v.intent === 'small_talk') return 'template';
  if (v.intent === 'out_of_scope') return 'general';
  return 'rag';
}

const CASES: { message: string; lang: 'en' | 'roman_ur'; expected: Route; note: string; urgent?: boolean }[] = [
  { message: 'My payment was charged twice, please refund today', lang: 'en', expected: 'human', note: 'billing, urgent', urgent: true },
  { message: 'bhai mera order abhi tak nahi aya 5 din ho gaye', lang: 'roman_ur', expected: 'human', note: 'order/shipping' },
  { message: 'yeh kya bakwas service hai, koi jawab hi nahi deta', lang: 'roman_ur', expected: 'human', note: 'angry' },
  { message: 'hi', lang: 'en', expected: 'template', note: 'greeting' },
  { message: 'thanks bro', lang: 'en', expected: 'template', note: 'thanks' },
  { message: 'Earn $5000 daily click here', lang: 'en', expected: 'spam', note: 'spam' },
  { message: 'How do I connect my WhatsApp to the inbox?', lang: 'en', expected: 'rag', note: 'technical' },
  { message: 'Do you offer a student discount on the yearly plan?', lang: 'en', expected: 'rag', note: 'not in KB (grounding below)' },
  // Extra Roman Urdu, so its accuracy is not read off two messages.
  { message: 'mujhe kisi insaan se baat karni hai', lang: 'roman_ur', expected: 'human', note: 'asks for a person' },
  { message: 'WhatsApp inbox se kaise connect karte hain?', lang: 'roman_ur', expected: 'rag', note: 'technical' },
  { message: 'shukriya bhai', lang: 'roman_ur', expected: 'template', note: 'thanks' },
];

const runtime: JevRuntime = { apiKey: KEY, settings: { ...normalizeJevSettings({ mode: 'live' }) } };
const TOPICS = ['Connect WhatsApp', 'Inbox basics', 'Pricing plans', 'Refunds', 'Shipping times'];

describe.skipIf(!LIVE)('Jev triage against the live API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('classifies the audit messages', async () => {
    const rows: Record<string, unknown>[] = [];
    const score = { en: [0, 0], roman_ur: [0, 0], jev_en: [0, 0], jev_roman_ur: [0, 0] };
    for (const c of CASES) {
      const started = Date.now();
      const final = await classifyVisitorIntent({ message: c.message, workspaceName: 'Zentry Demo', topics: TOPICS, jev: runtime });
      const pipelineMs = Date.now() - started;
      // Jev's own answer, also for messages the rules settle without it.
      let v: JevIntentVerdict | null = null;
      let error: string | null = null;
      try {
        v = await jevIntent(runtime, { message: c.message, workspaceName: 'Zentry Demo', topics: TOPICS });
      } catch (err) {
        error = (err as Error).message;
      }
      const route = routeOf(final);
      const jevRoute = v ? jevRouteOf(v) : null;
      score[c.lang][1] += 1;
      if (route === c.expected) score[c.lang][0] += 1;
      score[`jev_${c.lang}`][1] += 1;
      if (jevRoute === c.expected) score[`jev_${c.lang}`][0] += 1;
      rows.push({
        message: c.message.slice(0, 48),
        lang: c.lang,
        expected: c.expected,
        decided_by: final.source,
        final: route,
        urgent: Boolean(final.isUrgent),
        jev_intent: v?.intent ?? error,
        jev_route: jevRoute,
        jev_conf: v ? v.confidence.toFixed(2) : null,
        human: v ? v.wantsHuman.toFixed(2) : null,
        upset: v ? v.veryUpset.toFixed(2) : null,
        jev_urgent: v ? v.urgent.toFixed(2) : null,
        spam: v ? v.spam.toFixed(2) : null,
        jev_ms: v?.latencyMs ?? null,
        tokens: v ? `${v.usage.inputTokens}/${v.usage.outputTokens}` : null,
        pipeline_ms: pipelineMs,
      });
    }
    console.table(rows);
    const pct = ([ok, n]: number[]) => `${ok}/${n} (${n ? Math.round((ok / n) * 100) : 0}%)`;
    console.log('Final routing accuracy  English:', pct(score.en), ' Roman Urdu:', pct(score.roman_ur));
    console.log('Jev-only routing accuracy English:', pct(score.jev_en), ' Roman Urdu:', pct(score.jev_roman_ur));
    expect(rows).toHaveLength(CASES.length);
  }, 120_000);

  it('a question the articles do not cover: Jev says the draft is not supported', async () => {
    const v = await jevGrounding(runtime, {
      question: 'Do you offer a student discount on the yearly plan?',
      answer: 'Yes, students get 20% off the yearly plan.',
      passages:
        '[1] Connect WhatsApp: open Settings → Omnichannel Chat → Channels and click Connect WhatsApp.\n[2] Pricing plans: Starter is $19 a month, Growth is $49 a month, billed monthly or yearly.',
    });
    console.log('grounding supported =', v.supported.toFixed(2), 'bar =', runtime.settings.minGrounding, 'latency', v.latencyMs, 'ms');
    // Below the bar the pipeline hands over and records the question as unanswered.
    expect(v.supported).toBeLessThan(runtime.settings.minGrounding);
  }, 30_000);

  it('Jev failing (bad key, then a forced timeout) never stops the chat', async () => {
    const bad: JevRuntime = { ...runtime, apiKey: 'ts_invalid_key_for_test' };
    const r1 = await classifyVisitorIntent({ message: 'bhai mera order abhi tak nahi aya 5 din ho gaye', workspaceName: 'Zentry Demo', jev: bad });
    console.log('bad key →', r1.intent, '| error logged:', r1.jev?.error);
    expect(r1.intent).toBeTruthy();
    expect(r1.jev?.error).toMatch(/refused|TypeSafe/);

    // A fetch that never answers: the 2 s timeout fires and the rules decide.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
          })
      )
    );
    const started = Date.now();
    const r2 = await classifyVisitorIntent({ message: 'bhai mera order abhi tak nahi aya 5 din ho gaye', workspaceName: 'Zentry Demo', jev: runtime });
    const ms = Date.now() - started;
    console.log('timeout →', r2.intent, 'in', ms, 'ms | error logged:', r2.jev?.error);
    expect(r2.jev?.error).toMatch(/in time/);
    expect(ms).toBeLessThan(3000);
  }, 30_000);
});
