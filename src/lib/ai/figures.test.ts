import { describe, expect, it } from 'vitest';
import { unsupportedFigures } from './figures';

const ARTICLE = [
  'Maximum Daily Loss: 3% of initial balance ($3,000 on a $100k account).',
  'The maximum withdrawable profit per payout period is capped at 6% of your Initial Account Balance.',
  'Profit split: 80% to the trader.',
].join('\n');

describe('unsupportedFigures', () => {
  it('accepts figures that are in the articles, in any notation', () => {
    expect(unsupportedFigures('The daily loss limit is 3%, which is $3,000 on a 100k account.', ARTICLE)).toEqual([]);
    expect(unsupportedFigures('You keep 80% of the profit.', ARTICLE)).toEqual([]);
    expect(unsupportedFigures('On a $100,000 account the limit is 3,000 USD.', ARTICLE)).toEqual([]);
  });

  it('accepts one simple step from them: a percentage of an amount the customer gave', () => {
    const q = 'How much can I withdraw on my 5k account?';
    expect(unsupportedFigures('At most 6% of $5,000, so $300 per payout period.', `${ARTICLE}\n${q}`)).toEqual([]);
  });

  it('flags invented amounts and percentages', () => {
    expect(unsupportedFigures('Use code SAVE40 for 40% off.', ARTICLE)).toEqual(['40%']);
    expect(unsupportedFigures('The demo account has a $10,000 virtual balance.', ARTICLE)).toEqual(['$10,000']);
    expect(unsupportedFigures('Payouts are capped at 10% per period.', ARTICLE)).toEqual(['10%']);
  });

  it('leaves plain counts alone', () => {
    expect(unsupportedFigures('You need 14 trading days and 3 profitable days.', ARTICLE)).toEqual([]);
  });
});
