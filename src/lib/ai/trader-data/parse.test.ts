import { describe, expect, it } from 'vitest';
import { extractCode, extractEmail, extractHints, maskEmail } from './parse';
import { parseTraderRecord } from './client';

describe('extractEmail', () => {
  it.each([
    ['ali.khan@gmail.com', 'ali.khan@gmail.com'],
    ['meri email Ali.Khan@Gmail.com hai.', 'ali.khan@gmail.com'],
    ['my email is trader+1@firm.co.uk', 'trader+1@firm.co.uk'],
    ['no email here', null],
  ])('%s → %s', (text, email) => expect(extractEmail(text)).toBe(email));
});

describe('extractCode: only a message that is essentially the code', () => {
  it.each([
    ['482913', '482913'],
    ['482 913', '482913'],
    ['code: 482-913', '482913'],
    ['ye raha 482913', '482913'],
    ['my login is 482913, why was my account breached today?', null],
    ['10k challenge kitne ka hai', null],
    ['12345', null],
  ])('%s → %s', (text, code) => expect(extractCode(text)).toBe(code));
});

describe('extractHints', () => {
  it('reads an account login, an order id and a coupon code', () => {
    expect(extractHints('mera account 50012345 breach kyun hua')).toEqual({ account_login: '50012345' });
    expect(extractHints('order id ORD-77812 ka account nahi mila')).toMatchObject({ order_id: 'ORD-77812' });
    expect(extractHints('kindly mer orderid ka staus check kr dein o-2681')).toMatchObject({ order_id: 'o-2681' });
    expect(extractHints('SAVE20 code apply nahi ho raha')).toMatchObject({ coupon_code: 'SAVE20' });
    expect(extractHints('coupon: welcome10 not working')).toMatchObject({ coupon_code: 'welcome10' });
  });

  it('a word after "code" is not a code', () => {
    expect(extractHints('coupon code apply nahi ho raha').coupon_code).toBeUndefined();
    expect(extractHints('promo code not working').coupon_code).toBeUndefined();
  });
});

describe('maskEmail', () => {
  it('keeps the domain and the first letters', () => {
    expect(maskEmail('alikhan@gmail.com')).toBe('al•••••@gmail.com');
    expect(maskEmail('a@x.io')).toBe('a••@x.io');
  });
});

describe('parseTraderRecord', () => {
  it('a found record is compact JSON for the prompt', () => {
    expect(parseTraderRecord({ found: true, record: { status: 'breached' } })).toEqual({ found: true, text: '{"record":{"status":"breached"}}' });
  });
  it('a record without "found" counts as found; found:false carries its message', () => {
    expect(parseTraderRecord({ data: { a: 1 } })?.found).toBe(true);
    expect(parseTraderRecord({ found: false, message: 'No such email' })).toEqual({ found: false, text: '{"message":"No such email"}' });
  });
  it('a long record is cut; a non-object is no answer', () => {
    const r = parseTraderRecord({ found: true, record: { notes: 'x'.repeat(10_000) } });
    expect(r!.text.length).toBeLessThan(4_100);
    expect(parseTraderRecord('ok')).toBeNull();
    expect(parseTraderRecord([1, 2])).toBeNull();
  });
});
