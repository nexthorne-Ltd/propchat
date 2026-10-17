import { describe, expect, it } from 'vitest';
import {
  containsPersonalData,
  decideGrounding,
  knowledgeEntryFor,
  parseExtraction,
  parseJudgeVerdict,
  REWARD,
  scoreOutcome,
  shouldAutoApprove,
} from './safety';

const PASSAGES = [
  '[CHUNK 1]',
  'Article: Refund policy',
  '',
  'Refunds are available within 14 days of purchase. Approved refunds are sent back to the original payment method within 5 business days.',
  '',
  '---',
  '',
  '[CHUNK 2]',
  'Article: Shipping',
  '',
  'Standard shipping takes 3 to 5 days. Express shipping costs 1500 and arrives the next day.',
].join('\n');

const extraction = (over: Record<string, unknown>) =>
  JSON.stringify({
    usable: true,
    account_specific: false,
    question: 'How long do refunds take to arrive?',
    answer: 'Approved refunds are sent back to the original payment method within 5 business days.',
    ...over,
  });

describe('containsPersonalData', () => {
  it.each([
    ['Email me at sara.khan@example.com', true],
    ['Call 0300 1234567 for help', true],
    ['Your order #AB12345 has shipped', true],
    ['Order number: 784512 is on its way', true],
    ['Tracking ID: TRK-99812', true],
    ['IBAN PK36SCBL0000001123456702', true],
    ['your password is hunter22', true],
    ['Express shipping costs Rs 1,500 and arrives the next day', false],
    ['The Pro plan is $1,200.00 per year', false],
    ['Refunds take 5 to 7 business days', false],
  ])('%s -> %s', (text, expected) => {
    expect(containsPersonalData(text)).toBe(expected);
  });

  it('refuses answers that name the customer', () => {
    expect(containsPersonalData('Hi Fatima, refunds take 5 days', ['Fatima Noor'])).toBe(true);
    expect(containsPersonalData('Refunds take 5 days', ['Fatima Noor'])).toBe(false);
    // Placeholder names and short parts are not names.
    expect(containsPersonalData('Any visitor can ask for a refund', ['Visitor 1234'])).toBe(false);
  });
});

describe('parseExtraction', () => {
  it('accepts a general answer', () => {
    const res = parseExtraction(`Here you go: ${extraction({})}`);
    expect(res).toEqual({
      ok: true,
      qa: {
        question: 'How long do refunds take to arrive?',
        answer: 'Approved refunds are sent back to the original payment method within 5 business days.',
      },
    });
  });

  it.each([
    ['not json at all', 'no_json'],
    ['{"usable": tru', 'no_json'],
    [extraction({ usable: false, reason: 'agent asked for details' }), 'agent asked for details'],
    [extraction({ account_specific: true }), 'account_specific'],
    [extraction({ question: 'Refund?' }), 'bad_question'],
    [extraction({ answer: 'Yes.' }), 'bad_answer'],
    [extraction({ answer: "I'll check with the billing team and get back to you." }), 'no_answer_given'],
    [extraction({ answer: 'Your refund for order #AB99123 was sent to the original card.' }), 'personal_data'],
  ])('refuses %s', (raw, reason) => {
    expect(parseExtraction(raw)).toEqual({ ok: false, reason });
  });

  it('does not trust usable without the other rules', () => {
    expect(parseExtraction(extraction({ answer: 'Hi Fatima, refunds arrive within 5 business days.' }), ['Fatima'])).toEqual({
      ok: false,
      reason: 'personal_data',
    });
  });
});

describe('parseJudgeVerdict', () => {
  it.each([
    ['SUPPORTED', 'supported'],
    ['supported.', 'supported'],
    ['NOT_COVERED', 'not_covered'],
    ['Not supported', 'not_covered'],
    ['unsupported', 'not_covered'],
    ['CONTRADICTS', 'contradicts'],
    ['I am not sure', null],
  ])('%s -> %s', (raw, verdict) => {
    expect(parseJudgeVerdict(raw)).toBe(verdict);
  });
});

describe('decideGrounding', () => {
  const qa = {
    question: 'How long do refunds take?',
    answer: 'Approved refunds are sent back to the original payment method within 5 business days.',
  };

  it('is grounded only when every check agrees', () => {
    const res = decideGrounding({ judge: 'supported', passages: PASSAGES, ...qa });
    expect(res.grounding).toBe('grounded');
    expect(res.chunk).toBe(0);
  });

  it('a judge saying supported is not enough when the words are not in the passages', () => {
    const res = decideGrounding({
      judge: 'supported',
      passages: PASSAGES,
      question: 'Can I pay with crypto?',
      answer: 'Yes, we accept Bitcoin and Ethereum payments at checkout through our partner gateway.',
    });
    expect(res.grounding).toBe('new_fact');
  });

  it('an invented figure makes it a new fact', () => {
    const res = decideGrounding({
      judge: 'supported',
      passages: PASSAGES,
      question: 'How much is express shipping?',
      answer: 'Express shipping costs $2,750 and arrives the next day.',
    });
    expect(res.grounding).toBe('new_fact');
    expect(res.detail.invented_figures).toContain('$2,750');
  });

  it('Jev disagreeing makes it a new fact', () => {
    expect(decideGrounding({ judge: 'supported', passages: PASSAGES, jevSupported: 0.2, jevThreshold: 0.5, ...qa }).grounding).toBe('new_fact');
    expect(decideGrounding({ judge: 'supported', passages: PASSAGES, jevSupported: 0.9, jevThreshold: 0.5, ...qa }).grounding).toBe('grounded');
  });

  it('a contradiction is a contradiction, whatever else matches', () => {
    expect(decideGrounding({ judge: 'contradicts', passages: PASSAGES, ...qa }).grounding).toBe('contradicts');
  });

  it('no passages or no verdict is a new fact', () => {
    expect(decideGrounding({ judge: null, passages: '', ...qa }).grounding).toBe('new_fact');
    expect(decideGrounding({ judge: 'not_covered', passages: PASSAGES, ...qa }).grounding).toBe('new_fact');
  });
});

describe('shouldAutoApprove', () => {
  const settings = { autoApprove: true, minOccurrences: 3 };

  it('needs grounded and asked often enough', () => {
    expect(shouldAutoApprove({ status: 'pending_review', grounding: 'grounded', occurrences: 3 }, settings)).toBe(true);
    expect(shouldAutoApprove({ status: 'stale', grounding: 'grounded', occurrences: 5 }, settings)).toBe(true);
    expect(shouldAutoApprove({ status: 'pending_review', grounding: 'grounded', occurrences: 2 }, settings)).toBe(false);
  });

  it('never approves a new fact or a contradiction, however often it is asked', () => {
    expect(shouldAutoApprove({ status: 'pending_review', grounding: 'new_fact', occurrences: 50 }, settings)).toBe(false);
    expect(shouldAutoApprove({ status: 'pending_review', grounding: 'contradicts', occurrences: 50 }, settings)).toBe(false);
  });

  it('respects the switch, rejections and a floor of two', () => {
    expect(shouldAutoApprove({ status: 'pending_review', grounding: 'grounded', occurrences: 9 }, { ...settings, autoApprove: false })).toBe(false);
    expect(shouldAutoApprove({ status: 'rejected', grounding: 'grounded', occurrences: 9 }, settings)).toBe(false);
    expect(shouldAutoApprove({ status: 'pending_review', grounding: 'grounded', occurrences: 1 }, { ...settings, minOccurrences: 1 })).toBe(false);
  });
});

describe('knowledgeEntryFor', () => {
  it('keeps the title within the Bot knowledge limit', () => {
    const entry = knowledgeEntryFor({ question: 'q'.repeat(400), answer: 'An answer.' });
    expect(entry.title.length).toBeLessThanOrEqual(200);
    expect(entry.content).toContain('Answer: An answer.');
  });
});

describe('scoreOutcome', () => {
  const answeredAt = '2026-10-16T10:00:00Z';
  const at = (min: number) => new Date(Date.parse(answeredAt) + min * 60_000).toISOString();
  const now = new Date(at(60));

  it.each([
    ['rejection', [{ sender_type: 'visitor', content: "that didn't help", created_at: at(2) }], null, REWARD.bad],
    ['asks for a person', [{ sender_type: 'visitor', content: 'can I talk to a human agent', created_at: at(2) }], null, REWARD.bad],
    ['bad rating', [], 'bad', REWARD.bad],
    ['good rating', [], 'good', REWARD.good],
    ['thanks', [{ sender_type: 'visitor', content: 'shukriya, mil gaya', created_at: at(1) }], null, REWARD.good],
    ['next question', [{ sender_type: 'visitor', content: 'and how do I change my plan?', created_at: at(3) }], null, REWARD.movedOn],
    ['agent stepped in', [{ sender_type: 'agent', content: 'Let me add to that…', created_at: at(5) }], null, REWARD.agentStepIn],
  ])('%s', (_name, after, csat, reward) => {
    expect(scoreOutcome({ answeredAt, after, csat: csat as string | null, now })).toBe(reward);
  });

  it('waits before reading silence as fine', () => {
    expect(scoreOutcome({ answeredAt, after: [], now })).toBeNull();
    expect(scoreOutcome({ answeredAt, after: [], now: new Date(at(7 * 60)) })).toBe(REWARD.movedOn);
  });

  it('ignores internal notes and earlier messages', () => {
    const after = [
      { sender_type: 'visitor', content: 'useless', created_at: at(-1) },
      { sender_type: 'agent', content: 'note', is_internal: true, created_at: at(1) },
    ];
    expect(scoreOutcome({ answeredAt, after, now })).toBeNull();
  });
});
