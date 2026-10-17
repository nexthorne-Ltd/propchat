import { describe, expect, it } from 'vitest';
import { correctTerm, editDistance, searchQueriesFor, understandMessage } from '@/lib/ai/understanding';
import { routeSubAgent, type SubAgentId } from '@/lib/ai/sub-agents';
import { fuseRankings, parseQueryList } from '@/lib/ai/semantic-retrieval';
import type { RetrievedChunk } from '@/types/database';

/*
 * Messages the way traders really type them: typos, shorthand, Roman Urdu,
 * venting first. Add a row when a real message was misread.
 */

describe('understandMessage: what the trader actually asks', () => {
  it.each<[string, string]>([
    ['bhai kya bakwas hai 3 din se pyout nahi aaya!!!', '3 days payout not received'],
    ['dd kitna hai 10k pe', 'drawdown how much 10k'],
    ['mera acc ud gaya kyun???', 'my account breached why'],
    ['drwadown rules for p2 plzzz', 'drawdown rules for phase 2'],
    ['withdrawl kese karun', 'withdrawal how'],
    ['credentails nahi mile abhi tak', 'credentials not received still'],
    ['coupen code kaam nahi kar raha', 'coupon code not working'],
    ['Assalam o alaikum sir, chalange ki fees kya hai', 'challenge fees what'],
    ['yaar verfication kab tak hogi 😡😡', 'verification by when'],
  ])('"%s" → "%s"', (message, core) => {
    expect(understandMessage(message).core).toBe(core);
  });

  it('splits a message that asks several things', () => {
    const u = understandMessage('25k chalange ki price kya hai? aur max dd kitna hai');
    expect(u.parts).toEqual(['25k challenge price what', 'max drawdown how much']);
  });

  it('notices venting and urgency', () => {
    expect(understandMessage('WHERE IS MY PAYOUT THIS IS A SCAM').frustrated).toBe(true);
    expect(understandMessage('payout jaldi chahiye').urgent).toBe(true);
    expect(understandMessage('what is the daily drawdown?').frustrated).toBe(false);
  });

  it('a short or ordinary word is never "corrected" into a domain term', () => {
    expect(correctTerm('rest')).toBeNull();
    expect(correctTerm('amount')).toBeNull();
    expect(correctTerm('payment')).toBeNull();
    expect(correctTerm('challange')).toBe('challenge');
    expect(correctTerm('verfication')).toBe('verification');
    expect(understandMessage('rest of the rules').core).toBe('rest of rules');
  });

  it('edit distance counts a swapped pair as one edit', () => {
    expect(editDistance('drwadown', 'drawdown')).toBe(1);
    expect(editDistance('payout', 'payment')).toBeGreaterThan(2);
  });
});

describe('searchQueriesFor', () => {
  it('model queries first, then each question, the normalised request and the raw words, without duplicates', () => {
    const q = searchQueriesFor('dd kitna hai 10k pe', ['daily drawdown limit 10k account']);
    expect(q).toEqual(['daily drawdown limit 10k account', 'drawdown how much 10k', 'dd kitna hai 10k pe']);
    expect(searchQueriesFor('What is the profit split?')).toEqual(['profit split', 'What is the profit split?']);
  });
});

describe('the router reads past typos and shorthand', () => {
  it.each<[string, SubAgentId, string?]>([
    ['pyout kab ayga', 'payouts'],
    ['mera acc ud gaya kyun', 'account_status', 'account_specific'],
    ['drwadown kitna hai 10k pe', 'rules'],
    ['coupen kaam nahi kar raha', 'coupon_check'],
    ['verfication pending hai abhi tak', 'kyc_status', 'account_specific'],
    ['withdrawl kese karun', 'payouts'],
    ['refnd chahiye', 'refunds'],
    ['affilate comission kitna milta hai', 'affiliate'],
  ])('"%s" → %s', (message, agent, intent) => {
    expect(routeSubAgent({ message, intent: intent ?? 'help_center_question' }).agent).toBe(agent);
  });
});

describe('parseQueryList', () => {
  it('reads the JSON array, or lines when the model ignored the format', () => {
    expect(parseQueryList('["payout not received", "payout processing time"]')).toEqual(['payout not received', 'payout processing time']);
    expect(parseQueryList('Sure:\n1. payout not received\n2. payout processing time')).toEqual(['Sure:', 'payout not received', 'payout processing time']);
    expect(parseQueryList('[1, "ok query", "x"]')).toEqual(['ok query']);
  });
});

describe('fuseRankings', () => {
  const chunk = (id: string, combined: number, sim = combined): RetrievedChunk => ({
    id,
    article_id: `a-${id}`,
    article_title: id,
    chunk_index: 0,
    content: id,
    similarity: sim,
    keyword_score: 0,
    combined_score: combined,
  });

  it('the passage several wordings agree on beats one wording\'s top hit, and keeps its best scores', () => {
    const fused = fuseRankings([
      [chunk('only-once', 0.9), chunk('agreed', 0.5)],
      [chunk('agreed', 0.6, 0.7), chunk('other', 0.4)],
      [chunk('agreed', 0.55)],
    ]);
    expect(fused[0]).toMatchObject({ id: 'agreed', hits: 3, combined_score: 0.6, similarity: 0.7 });
    expect(fused.map((c) => c.id)).toEqual(['agreed', 'only-once', 'other']);
  });
});
