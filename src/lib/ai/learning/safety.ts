/**
 * The rules that keep the bot from learning bad data. Pure functions, so every
 * rule is covered by safety.test.ts; the learner (learner.ts) only gathers the
 * inputs and stores the verdicts. See supabase/migrations/20261119090000_bot_learning.sql
 * for the whole loop.
 */
import { groundedChunkIndex } from '@/lib/ai/grounding';
import { unsupportedFigures } from '@/lib/ai/figures';
import { asksForHuman, NOT_HELPFUL } from '@/lib/ai/intent';

/* ── Personal data ────────────────────────────────────────────────────── */

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// Seven or more digits, allowing spaces, dashes and a leading +: phone,
// card, order and account numbers. Prices ("Rs 4,500", "$1,200.00") are
// shorter or carry separators every three digits, so they pass.
const LONG_NUMBER = /(?:\+?\d[\s-]?){7,}/;
const REFERENCE = /\b(?:order|invoice|ticket|account|acct|tracking|ref(?:erence)?|txn|transaction)\s*(?:no\.?|number|id|#)?\s*[:#-]?\s*[A-Z0-9-]*\d[A-Z0-9-]{3,}\b/i;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/;
const PASSWORD = /\b(?:password|passcode|otp|pin)\s*(?:is|:)\s*\S+/i;

/**
 * True when the text names a person's own details. A learned answer is read
 * to every future visitor, so anything that belongs to one customer makes the
 * whole candidate unusable; it is refused rather than scrubbed, because a
 * scrubbed answer about one customer's order is still about that order.
 */
export function containsPersonalData(text: string, names: (string | null | undefined)[] = []): boolean {
  if (EMAIL.test(text) || REFERENCE.test(text) || IBAN.test(text) || PASSWORD.test(text)) return true;
  if ((text.replace(/[,.](?=\d{3}\b)/g, '').match(LONG_NUMBER) || []).some((m) => m.replace(/\D/g, '').length >= 7)) {
    return true;
  }
  const words = new Set(text.toLowerCase().match(/[\p{L}']+/gu) || []);
  for (const name of names) {
    for (const part of (name || '').toLowerCase().split(/\s+/)) {
      // Short or generic name parts ("Ali", "Visitor") also occur in normal text.
      if (part.length >= 4 && !/^(?:visitor|guest|customer|user|anonymous)$/.test(part) && words.has(part)) {
        return true;
      }
    }
  }
  return false;
}

/* ── Extraction ───────────────────────────────────────────────────────── */

export interface ExtractedQa {
  question: string;
  answer: string;
}

export type ExtractionVerdict = { ok: true; qa: ExtractedQa } | { ok: false; reason: string };

/**
 * Reads the extraction model's JSON and applies the rules the prompt asks for,
 * because a model's own "usable: true" is not proof: a missing field, an
 * answer that only promises to look into it, or personal data all refuse it.
 */
export function parseExtraction(raw: string, names: (string | null | undefined)[] = []): ExtractionVerdict {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return { ok: false, reason: 'no_json' };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'bad_json' };
  }
  if (data.usable !== true) return { ok: false, reason: String(data.reason || 'not_usable').slice(0, 60) };
  if (data.account_specific === true) return { ok: false, reason: 'account_specific' };
  const question = typeof data.question === 'string' ? data.question.replace(/\s+/g, ' ').trim() : '';
  const answer = typeof data.answer === 'string' ? data.answer.trim() : '';
  if (question.length < 8 || question.length > 500) return { ok: false, reason: 'bad_question' };
  if (answer.length < 15 || answer.length > 4000) return { ok: false, reason: 'bad_answer' };
  if (DEFERRAL.test(answer)) return { ok: false, reason: 'no_answer_given' };
  if (containsPersonalData(`${question}\n${answer}`, names)) return { ok: false, reason: 'personal_data' };
  return { ok: true, qa: { question, answer } };
}

/** Replies that are not an answer: the person only promised one. */
const DEFERRAL =
  /^(?:(?:i(?:'| a)m|we(?:'| a)re|i will|we will|i'll|we'll|let me)\s+(?:check|look|ask|escalate|get back|forward|pass)|(?:checking|looking into it)|please wait|one moment)\b/i;

/* ── Grounding ────────────────────────────────────────────────────────── */

export type Grounding = 'grounded' | 'new_fact' | 'contradicts';

export interface GroundingInputs {
  /** The judge model's verdict on the answer against the passages. */
  judge: 'supported' | 'contradicts' | 'not_covered' | null;
  answer: string;
  question: string;
  /** "[CHUNK n] …" blocks of articles and manual Bot knowledge only. */
  passages: string;
  /** Jev's grounding score when Jev is set up, else null. */
  jevSupported?: number | null;
  jevThreshold?: number;
}

export interface GroundingResult {
  grounding: Grounding;
  /** 0-based passage the answer was matched to, when grounded. */
  chunk: number | null;
  detail: Record<string, unknown>;
}

/**
 * Grounded needs every check to agree: the judge says supported, the answer's
 * own words and every number are found in one passage, no figure is invented,
 * and Jev (when set up) does not disagree. Any doubt makes it a new fact, which
 * a person must approve; only the judge can call it a contradiction, and a
 * contradiction is never learned.
 */
export function decideGrounding(input: GroundingInputs): GroundingResult {
  const chunk = input.passages.trim() ? groundedChunkIndex(input.answer, input.passages, 'en') : null;
  const invented = input.passages.trim() ? unsupportedFigures(input.answer, `${input.passages}\n${input.question}`) : [];
  const jevDisagrees =
    typeof input.jevSupported === 'number' && input.jevSupported < (input.jevThreshold ?? 0.5);
  const detail = {
    judge: input.judge,
    overlap_chunk: chunk,
    invented_figures: invented.slice(0, 5),
    jev_supported: typeof input.jevSupported === 'number' ? Math.round(input.jevSupported * 1000) / 1000 : null,
  };
  if (input.judge === 'contradicts') return { grounding: 'contradicts', chunk: null, detail };
  if (input.judge === 'supported' && chunk !== null && invented.length === 0 && !jevDisagrees) {
    return { grounding: 'grounded', chunk, detail };
  }
  return { grounding: 'new_fact', chunk: null, detail };
}

/** Reads the judge model's one-word verdict. */
export function parseJudgeVerdict(raw: string): GroundingInputs['judge'] {
  const text = raw.toLowerCase();
  // Checked in this order so "not supported" is never read as "supported".
  if (/\bcontradict/.test(text)) return 'contradicts';
  if (/\bnot[_\s-]?(?:covered|supported)\b|\bunsupported\b/.test(text)) return 'not_covered';
  if (/\bsupported\b/.test(text)) return 'supported';
  return null;
}

/* ── Approval ─────────────────────────────────────────────────────────── */

export interface ApprovalSettings {
  autoApprove: boolean;
  minOccurrences: number;
}

/**
 * Only grounded candidates seen often enough are approved without a person.
 * A new fact is never approved automatically, however often it comes up:
 * repetition shows the question is common, not that the answer is right.
 */
export function shouldAutoApprove(
  candidate: { status: string; grounding: string; occurrences: number },
  settings: ApprovalSettings
): boolean {
  return (
    settings.autoApprove &&
    (candidate.status === 'pending_review' || candidate.status === 'stale') &&
    candidate.grounding === 'grounded' &&
    candidate.occurrences >= Math.max(2, settings.minOccurrences)
  );
}

/** The Bot knowledge entry an approved candidate becomes. */
export function knowledgeEntryFor(qa: ExtractedQa): { title: string; content: string } {
  const title = qa.question.length > 200 ? `${qa.question.slice(0, 197)}…` : qa.question;
  return { title, content: `Question: ${qa.question}\n\nAnswer: ${qa.answer}` };
}

/* ── Rewards for the retrieval policy ─────────────────────────────────── */

export interface OutcomeMessage {
  sender_type: string;
  content: string | null;
  is_internal?: boolean | null;
  created_at: string;
}

const THANKS = /\b(?:thanks?|thank\s+you|thx|ty|great|perfect|got\s+it|that\s+helped|helpful|shukriya|shukria|jazakallah|theek\s+hai|samajh\s+gaya|samajh\s+gayi|mil\s+gaya)\b/i;

/** Reward for an answer that was right, a handover, and an answer that was wrong. */
export const REWARD = { good: 1, movedOn: 0.8, handover: 0.4, agentStepIn: 0.3, bad: 0 } as const;

/**
 * What one bot answer earned, from what happened after it, or null when it is
 * too early to tell. Rejection, a request for a person or a bad rating mean
 * the answer failed; thanks or a good rating mean it worked; moving on to
 * another question or saying nothing more for six hours counts as mostly fine.
 */
export function scoreOutcome(input: {
  answeredAt: string;
  after: OutcomeMessage[];
  csat?: string | null;
  now?: Date;
}): number | null {
  const now = input.now ?? new Date();
  const answered = new Date(input.answeredAt).getTime();
  const ageHours = (now.getTime() - answered) / 3_600_000;
  const later = input.after
    .filter((m) => !m.is_internal && new Date(m.created_at).getTime() > answered)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const nextVisitor = later.find((m) => m.sender_type === 'visitor');
  const text = (nextVisitor?.content || '').trim();

  if (nextVisitor && (NOT_HELPFUL.test(text) || asksForHuman(text))) return REWARD.bad;
  if (input.csat === 'bad') return REWARD.bad;
  if (input.csat === 'good') return REWARD.good;
  if (nextVisitor && THANKS.test(text) && text.length <= 80) return REWARD.good;

  const agentFirst = later.find((m) => m.sender_type === 'agent');
  if (agentFirst && (!nextVisitor || agentFirst.created_at < nextVisitor.created_at)) return REWARD.agentStepIn;
  if (nextVisitor) return REWARD.movedOn;
  return ageHours >= 6 ? REWARD.movedOn : null;
}
