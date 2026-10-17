import { describe, expect, it } from 'vitest';
import { buildIndex, type RetrievableArticle } from '@/lib/ai/retrieval';
import { checkCoverage, COVERAGE } from '@/lib/ai/coverage';
import { SUB_AGENTS } from '@/lib/ai/sub-agents';

/*
 * Which specialist is missing knowledge: a help centre that covers payouts
 * fully, the rules partly and nothing about refunds must say exactly that.
 */

const article = (id: string, title: string, content: string, sectionName = 'General'): RetrievableArticle =>
  ({ id, title, content, sectionName, slug: id }) as RetrievableArticle;

const HELP_CENTER = [
  article('p1', 'When can I request my first payout?', 'Your first payout can be requested 14 days after your first trade on a funded account. After that the payout schedule is every 14 days.', 'Payouts'),
  article('p2', 'Profit split', 'The profit split is 80% to the trader and can scale to 90%.', 'Payouts'),
  article('p3', 'Minimum payout amount', 'The minimum payout is $50. Smaller balances roll over to the next cycle.', 'Payouts'),
  article('p4', 'Payout methods', 'Payouts are sent by crypto (USDT) or bank transfer. Withdrawal by crypto is fastest.', 'Payouts'),
  article('p5', 'Payout processing time', 'Approved payouts are processed within 24 hours on business days.', 'Payouts'),
  article('p6', 'How to request a payout', 'To request a payout, open the dashboard, choose Withdraw and confirm. That is how to withdraw.', 'Payouts'),
  article('r1', 'Daily drawdown', 'The daily drawdown (daily loss limit) is 5% of the starting balance of the day.', 'Trading rules'),
  article('r2', 'Maximum drawdown', 'The maximum drawdown (overall loss limit) is 10% of the initial balance.', 'Trading rules'),
  article('r3', 'Profit target', 'The profit target is 8% in phase 1 and 5% in phase 2.', 'Trading rules'),
];

describe('checkCoverage', () => {
  const report = checkCoverage(buildIndex(HELP_CENTER));
  const of = (id: string) => report.find((s) => s.agent === id)!;

  it('a fully covered specialist has every item, with the article that covers it', () => {
    const payouts = of('payouts');
    expect(payouts.covered).toBe(payouts.total);
    expect(payouts.items.find((i) => i.id === 'split')).toMatchObject({ covered: true, article: 'Profit split' });
  });

  it('a partly covered specialist lists exactly what is missing', () => {
    const rules = of('rules');
    const missing = rules.items.filter((i) => !i.covered).map((i) => i.id);
    expect(rules.items.filter((i) => i.covered).map((i) => i.id)).toEqual(['daily_dd', 'max_dd', 'target']);
    expect(missing).toEqual(['days', 'consistency', 'weekend', 'leverage']);
  });

  it('a specialist with nothing in the help center is all missing', () => {
    const refunds = of('refunds');
    expect(refunds.covered).toBe(0);
    expect(refunds.items.every((i) => !i.covered && i.article === null)).toBe(true);
  });

  it('a switched-off specialist is reported as off, with nothing to fill', () => {
    const off = checkCoverage(buildIndex(HELP_CENTER), (id) => id !== 'refunds');
    expect(off.find((s) => s.agent === 'refunds')).toMatchObject({ enabled: false, covered: 0 });
  });

  it('an empty help center misses everything', () => {
    expect(checkCoverage(buildIndex([])).every((s) => s.covered === 0)).toBe(true);
  });
});

describe('the checklist', () => {
  it('every model specialist has one, with probes for each item', () => {
    for (const a of SUB_AGENTS.filter((x) => x.engine === 'model')) {
      expect(COVERAGE[a.id]?.length, a.id).toBeGreaterThan(0);
      for (const item of COVERAGE[a.id]!) expect(item.probes.length, `${a.id}.${item.id}`).toBeGreaterThan(0);
    }
  });
});
