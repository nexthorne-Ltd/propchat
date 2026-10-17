import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';
import { Linkified } from './Linkified';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('links in dashboard message bubbles', () => {
  it('plain text (visitor messages, notes) links URLs, domains and emails', () => {
    const out = html(React.createElement(Linkified, { text: 'site genzprop.com, mail a@b.co or https://x.io/p?a=1&b=2.' }));
    expect(out).toContain('href="https://genzprop.com" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('href="mailto:a@b.co"');
    expect(out).toContain('href="https://x.io/p?a=1&amp;b=2"');
    expect(out).toMatch(/<\/a>\.$/);
  });

  it('cannot inject markup', () => {
    const out = html(React.createElement(Linkified, { text: '<img src=x onerror=alert(1)> https://ok.com' }));
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('markdown replies keep [text](url) links and gain bare ones', () => {
    const out = html(React.createElement(ChatMarkdown, { content: 'See [docs](https://docs.x.com) or **www.genzprop.com**' }));
    expect(out).toContain('<a href="https://docs.x.com" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('>docs</a>');
    expect(out).toContain('<strong class="font-semibold"><a href="https://www.genzprop.com"');
    const bare = html(React.createElement(ChatMarkdown, { content: '- Pricing: www.genzprop.com/pricing' }));
    expect(bare).toContain('href="https://www.genzprop.com/pricing"');
  });
});
