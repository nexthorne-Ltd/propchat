import { describe, expect, it } from 'vitest';
import { continueList, insertBlock, insertLink, toggleLines, wrap } from './markdown-edit';

const sel = (text: string, from: string, to = from) => {
  const start = text.indexOf(from);
  return [start, to === from ? start + from.length : text.indexOf(to) + to.length] as const;
};

describe('wrap', () => {
  it('bolds the selection and keeps it selected', () => {
    const r = wrap('make this bold', ...sel('make this bold', 'this'), '**');
    expect(r.text).toBe('make **this** bold');
    expect(r.text.slice(r.start, r.end)).toBe('this');
  });
  it('unbolds when already bold', () => {
    const t = 'make **this** bold';
    const r = wrap(t, t.indexOf('this'), t.indexOf('this') + 4, '**');
    expect(r.text).toBe('make this bold');
  });
  it('inserts a placeholder with nothing selected', () => {
    const r = wrap('a ', 2, 2, '**');
    expect(r.text).toBe('a **text**');
    expect(r.text.slice(r.start, r.end)).toBe('text');
  });
});

describe('toggleLines', () => {
  it('turns lines into a numbered list, replacing bullets', () => {
    const t = '- one\ntwo\n- three';
    expect(toggleLines(t, 0, t.length, 'number').text).toBe('1. one\n2. two\n3. three');
  });
  it('removes the list when every line already is one', () => {
    const t = '- one\n- two';
    expect(toggleLines(t, 0, t.length, 'bullet').text).toBe('one\ntwo');
  });
  it('makes a heading of the caret line and keeps the caret on the word', () => {
    const t = 'intro\nPayouts\nbody';
    const caret = t.indexOf('Payouts') + 3;
    const r = toggleLines(t, caret, caret, 'h2');
    expect(r.text).toBe('intro\n## Payouts\nbody');
    expect(r.text.slice(r.start, r.start + 4)).toBe('outs');
  });
  it('switches a heading level instead of stacking', () => {
    expect(toggleLines('## Title', 0, 0, 'h3').text).toBe('### Title');
  });
  it('makes a checklist', () => {
    expect(toggleLines('buy\nsell', 0, 8, 'task').text).toBe('- [ ] buy\n- [ ] sell');
  });
});

describe('blocks and links', () => {
  it('puts a block on its own lines', () => {
    expect(insertBlock('above\nbelow', 5, 5, '---').text).toBe('above\n\n---\n\nbelow');
    expect(insertBlock('', 0, 0, '---').text).toBe('---');
  });
  it('links the selection and selects the url to type over', () => {
    const t = 'see the docs';
    const r = insertLink(t, ...sel(t, 'docs'));
    expect(r.text).toBe('see the [docs](https://)');
    expect(r.text.slice(r.start, r.end)).toBe('https://');
  });
});

describe('continueList', () => {
  it('continues bullets, numbers and checklists', () => {
    expect(continueList('- a', 3)?.text).toBe('- a\n- ');
    expect(continueList('1. a', 4)?.text).toBe('1. a\n2. ');
    expect(continueList('- [x] done', 10)?.text).toBe('- [x] done\n- [ ] ');
  });
  it('ends the list on an empty item', () => {
    expect(continueList('- a\n- ', 6)?.text).toBe('- a\n');
  });
  it('leaves ordinary lines alone', () => {
    expect(continueList('hello', 5)).toBeNull();
  });
});
