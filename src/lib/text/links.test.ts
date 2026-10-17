import { describe, expect, it } from 'vitest';
import { splitLinks } from './links';

const links = (text: string) => splitLinks(text).filter((p) => p.href).map((p) => [p.text, p.href]);

describe('links in chat text', () => {
  it('finds full URLs, www addresses, bare domains and emails', () => {
    expect(links('Pay here https://genzprop.com/pay?id=7&x=1 thanks')).toEqual([
      ['https://genzprop.com/pay?id=7&x=1', 'https://genzprop.com/pay?id=7&x=1'],
    ]);
    expect(links('see www.genzprop.com/pricing')).toEqual([['www.genzprop.com/pricing', 'https://www.genzprop.com/pricing']]);
    expect(links('go to genzprop.com or app.genzprop.co/login')).toEqual([
      ['genzprop.com', 'https://genzprop.com'],
      ['app.genzprop.co/login', 'https://app.genzprop.co/login'],
    ]);
    expect(links('mail sarmad.shahzad208@gmail.com now')).toEqual([
      ['sarmad.shahzad208@gmail.com', 'mailto:sarmad.shahzad208@gmail.com'],
    ]);
  });

  it('leaves sentence punctuation and brackets outside the link', () => {
    expect(links('Visit genzprop.com.')).toEqual([['genzprop.com', 'https://genzprop.com']]);
    expect(links('(see https://x.com/a)')).toEqual([['https://x.com/a', 'https://x.com/a']]);
    expect(links('wiki https://en.wikipedia.org/wiki/Foo_(bar), ok')).toEqual([
      ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ]);
    const parts = splitLinks('Is it genzprop.com?');
    expect(parts.map((p) => p.text).join('')).toBe('Is it genzprop.com?');
    expect(parts[parts.length - 1]).toEqual({ text: '?' });
  });

  it('does not turn ordinary words, files or numbers into links', () => {
    expect(links('version 1.2.3, file report.pdf, e.g. this, Mr.Smith')).toEqual([]);
    expect(links('the price is 10.50 rs')).toEqual([]);
    expect(links('folder/my.site.com')).toEqual([]);
  });

  it('keeps every character of the original text', () => {
    const text = 'Hi! Check https://a.com, www.b.io and c@d.pk; bye.';
    expect(splitLinks(text).map((p) => p.text).join('')).toBe(text);
  });

  it('only builds web and mail links', () => {
    expect(links('javascript:alert(1) data:text/html,x')).toEqual([]);
  });
});
