import { describe, expect, it } from 'vitest';
import {
  affordabilityRisk,
  decideChatMode,
  isOpeningMenu,
  menuChoice,
  modeSituation,
  openingMenu,
  SUPPORT_MODE_SITUATION,
} from './sales';
import { OPENING_MENU, OPENING_MENU_QUESTION } from './opening-menu';

const menuEn = openingMenu('en');
const menuUr = openingMenu('roman_ur');
const afterMenu = (text: string) => [{ role: 'assistant', content: text }];

describe('opening menu', () => {
  it('follows the visitor language and carries three buttons', () => {
    expect(menuEn.text).toContain('How can I help you today?');
    expect(menuUr.text).toContain('Main aap ki kis cheez mein madad karun?');
    expect(menuEn.quickReplies).toHaveLength(3);
    expect(isOpeningMenu(menuEn.text)).toBe(true);
    expect(isOpeningMenu(menuUr.text)).toBe(true);
    expect(isOpeningMenu('Hi! How are you?')).toBe(false);
  });

  it('keeps the workspace greeting as the intro and is still recognised', () => {
    const m = openingMenu('en', null, 'Welcome to Acme Funding!');
    expect(m.text.startsWith('Welcome to Acme Funding!')).toBe(true);
    expect(isOpeningMenu(m.text)).toBe(true);
  });
});

describe('the widget welcome', () => {
  // The same text widget/src/index.ts saves when a chat opens.
  const welcome = `Welcome to Bullish4ex 👋\n${OPENING_MENU_QUESTION}\n${OPENING_MENU.map((o, i) => `${i + 1}. ${o.value}`).join('\n')}`;

  it('is recognised as the menu, so its buttons and a typed digit work', () => {
    expect(isOpeningMenu(welcome)).toBe(true);
    expect(menuChoice('1', afterMenu(welcome))).toBe(1);
    expect(menuChoice(OPENING_MENU[1].value)).toBe(2);
  });
});

describe('menuChoice', () => {
  it('reads a button in any language', () => {
    expect(menuChoice(menuEn.quickReplies[0].value)).toBe(1);
    expect(menuChoice(menuUr.quickReplies[1].value)).toBe(2);
    expect(menuChoice(openingMenu('es').quickReplies[2].value)).toBe(3);
  });

  it('reads a typed digit only right after the menu', () => {
    expect(menuChoice('1', afterMenu(menuEn.text))).toBe(1);
    expect(menuChoice('2.', afterMenu(menuUr.text))).toBe(2);
    expect(menuChoice('1', afterMenu('Which account size, 1 or 2?'))).toBeNull();
    expect(menuChoice('10k', afterMenu(menuEn.text))).toBeNull();
  });
});

describe('decideChatMode', () => {
  it('maps menu options', () => {
    expect(decideChatMode({ message: menuEn.quickReplies[0].value, agent: 'pricing_offers' }).mode).toBe('sales');
    expect(decideChatMode({ message: '2', recent: afterMenu(menuEn.text), agent: 'general' }).mode).toBe('support');
  });

  it.each([
    ['10k challenge kitne ka hai?', 'pricing_offers', 'sales'],
    ['funded trader banna hai, kaise start karun', 'general', 'sales'],
    ['which plan is best for me?', 'pricing_offers', 'sales'],
    ['is this a scam?', 'general', 'sales'],
    ['my payout is late', 'payouts', 'support'],
    ['mt5 login nahi ho raha', 'platform', 'support'],
    ['mera account breach kyun hua', 'account_status', 'support'],
    ['what is the daily drawdown?', 'rules', 'neutral'],
  ] as const)('"%s" → %s', (message, agent, mode) => {
    expect(decideChatMode({ message, agent }).mode).toBe(mode);
  });

  it('switches from sales to support as soon as a problem comes up', () => {
    const recent = [
      { role: 'user', content: 'which plan for a beginner?' },
      { role: 'assistant', content: 'The 10k fits you.' },
    ];
    expect(decideChatMode({ message: 'checkout pe payment failed ho gayi', recent, agent: 'general' }).mode).toBe('support');
  });

  it('keeps a support chat in support for a neutral follow-up', () => {
    const recent = [
      { role: 'user', content: 'my payout is late' },
      { role: 'assistant', content: 'Payouts take 3 days.' },
    ];
    expect(decideChatMode({ message: 'ok and what about weekends?', recent, agent: 'general' }).mode).toBe('support');
  });

  it('goes back to sales after a problem only on a buying signal, flagged', () => {
    const recent = [
      { role: 'user', content: 'my payout is late' },
      { role: 'assistant', content: 'It is on its way.' },
    ];
    const r = decideChatMode({ message: 'thanks, I want to buy a 50k challenge too', recent, agent: 'pricing_offers' });
    expect(r.mode).toBe('sales');
    expect(r.hadProblem).toBe(true);
  });

  it('marks someone who already bought as a customer', () => {
    expect(decideChatMode({ message: 'I already bought a 10k, how much is 25k?', agent: 'pricing_offers' }).isCustomer).toBe(true);
    expect(decideChatMode({ message: 'how much is 25k?', agent: 'pricing_offers' }).isCustomer).toBe(false);
  });
});

describe('modeSituation', () => {
  it('adds the sales rules only when the Sales specialist is on', () => {
    const r = decideChatMode({ message: 'which plan is best for me?', agent: 'pricing_offers' });
    expect(modeSituation(r, 'which plan is best for me?', true).join('\n')).toContain('SALES MODE');
    expect(modeSituation(r, 'which plan is best for me?', false)).toEqual([SUPPORT_MODE_SITUATION]);
  });

  it('tells the model not to sell to someone spending savings or borrowed money', () => {
    const msg = 'ye meri aakhri bachat hai, 100k le loon?';
    expect(affordabilityRisk(msg)).toBe(true);
    expect(affordabilityRisk('I will borrow from a friend')).toBe(true);
    expect(affordabilityRisk('which plan is best')).toBe(false);
    const r = decideChatMode({ message: msg, agent: 'pricing_offers' });
    expect(modeSituation(r, msg, true).join('\n')).toContain('NOT to buy now');
  });

  it('says nothing extra in neutral mode', () => {
    const r = decideChatMode({ message: 'what is the daily drawdown?', agent: 'rules' });
    expect(modeSituation(r, 'what is the daily drawdown?', true)).toEqual([]);
  });
});
