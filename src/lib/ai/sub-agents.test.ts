import { describe, expect, it } from 'vitest';
import { routeSubAgent, SUB_AGENTS, subAgentEnabled, type SubAgentId } from '@/lib/ai/sub-agents';

describe('routeSubAgent: each message reaches the right specialist', () => {
  it.each<[string, SubAgentId, string?]>([
    ['10k challenge kitne ka hai?', 'pricing_offers'],
    ['any discount code?', 'pricing_offers'],
    ['2 step vs 1 step which is better', 'pricing_offers'],
    ['can I pay with crypto?', 'pricing_offers'],
    ['dd kitna hai 10k pe', 'rules'],
    ['can I trade news?', 'trading_tools'],
    ['weekend pe trade hold kar sakta hoon?', 'rules'],
    ['phase 2 target kya hai', 'rules'],
    ['is EA allowed', 'trading_tools'],
    ['stop loss lagana zaroori hai?', 'rules'],
    ['payout kab milega?', 'payouts'],
    ['what is the profit split', 'payouts'],
    ['fee refund hoti hai?', 'payouts'],
    ['mera account breach kyun hua?', 'account_status', 'account_specific'],
    ['credentials nahi mile', 'account', 'account_specific'],
    ['mt5 pe login kaise karun', 'platform'],
    ['server name kya hai', 'platform'],
    ['kyc ke liye kya documents chahiye', 'kyc'],
    ['is Pakistan allowed?', 'kyc'],
    ['affiliate program hai?', 'affiliate'],
    ['copy trading allowed hai?', 'trading_tools'],
    ['hedging allowed?', 'trading_tools'],
    ['mera account active hai?', 'account_status', 'account_specific'],
    ['kitna drawdown bacha hai mere account mein', 'account_status', 'account_specific'],
    ['meri kyc reject ho gayi', 'kyc_status', 'account_specific'],
    ['kyc status kya hai', 'kyc_status'],
    ['coupon code apply nahi ho raha', 'coupon_check'],
    ['promo code not working', 'coupon_check'],
    ['payment kar di lekin account nahi mila', 'order_lookup', 'account_specific'],
    ['paise kat gaye account nahi aaya', 'order_lookup', 'account_specific'],
    ['mera commission kitna hua', 'affiliate_stats', 'account_specific'],
    ['affiliate commission not credited', 'affiliate_stats'],
    ['refund chahiye', 'refunds'],
    ['how do I cancel my order', 'refunds'],
    ['I was charged twice', 'refunds'],
    ['mera win rate kitna hai', 'account_status', 'account_specific'],
    ['my profit this week?', 'account_status', 'account_specific'],
    ['what is my profit split', 'payouts'],
    ['is this firm legit?', 'general'],
    ['tell me something', 'general'],
  ])('"%s" → %s', (message, agent, intent) => {
    expect(routeSubAgent({ message, intent: intent ?? 'help_center_question' }).agent).toBe(agent);
  });

  it('a question about their own account that names a topic goes to that topic', () => {
    expect(routeSubAgent({ message: 'my payout is late', intent: 'account_specific' }).agent).toBe('payouts');
  });

  it('their own account with no topic goes to Account', () => {
    expect(routeSubAgent({ message: 'please check what happened', intent: 'account_specific' }).agent).toBe('account');
  });

  it('the challenge-fee refund with a payout is Payouts; a purchase refund is Refunds', () => {
    expect(routeSubAgent({ message: 'fee refund kab milti hai?', intent: 'help_center_question' }).agent).toBe('payouts');
    expect(routeSubAgent({ message: 'mujhe refund chahiye, galti se khareed liya', intent: 'help_center_question' }).agent).toBe('refunds');
  });

  it('asking for discounts is Pricing; a code that will not apply is Coupon check', () => {
    expect(routeSubAgent({ message: 'any discount code?', intent: 'help_center_question' }).agent).toBe('pricing_offers');
    expect(routeSubAgent({ message: 'SAVE20 code apply nahi ho raha', intent: 'help_center_question' }).agent).toBe('coupon_check');
  });

  it('a follow-up with no topic stays with the specialist of the previous messages', () => {
    const recent = [
      { role: 'user', content: 'max drawdown kitna hai 10k pe?' },
      { role: 'assistant', content: 'Max drawdown is 10%, so 1,000 on a 10k account.' },
    ];
    expect(routeSubAgent({ message: 'aur 25k pe?', recent, intent: 'help_center_question' }).agent).toBe('rules');
  });

  it('small talk is the Greeting specialist; asking for a person is Human handover', () => {
    expect(routeSubAgent({ message: 'salam', intent: 'small_talk' }).agent).toBe('greeting');
    expect(routeSubAgent({ message: 'human se baat karwao', intent: 'wants_human', asksForHuman: true }).agent).toBe('human_handover');
  });

  it('a wants_human verdict from anger alone is routed by its topic', () => {
    const r = routeSubAgent({ message: 'this is unfair, why breach on news trade', intent: 'wants_human', asksForHuman: false });
    expect(r.agent).toBe('trading_tools');
  });
});

describe('sub-agent definitions', () => {
  it('every model specialist has a brief, examples and a handover rule', () => {
    for (const a of SUB_AGENTS) {
      expect(a.examples.length, a.id).toBeGreaterThan(0);
      expect(a.handsOverWhen, a.id).toBeTruthy();
      if (a.engine === 'model') expect(a.brief, a.id).toBeTruthy();
    }
  });

  it('each example routes to its own specialist', () => {
    for (const a of SUB_AGENTS.filter((x) => x.engine === 'model' && x.id !== 'account')) {
      for (const ex of a.examples) {
        expect(routeSubAgent({ message: ex, intent: 'help_center_question' }).agent, `${a.id}: ${ex}`).toBe(a.id);
      }
    }
  });

  it('Greeting and Human handover cannot be switched off', () => {
    const off = { greeting: { enabled: false }, human_handover: { enabled: false }, rules: { enabled: false } };
    expect(subAgentEnabled(off, 'greeting')).toBe(true);
    expect(subAgentEnabled(off, 'human_handover')).toBe(true);
    expect(subAgentEnabled(off, 'rules')).toBe(false);
    expect(subAgentEnabled(null, 'rules')).toBe(true);
  });
});
