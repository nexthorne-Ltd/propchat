import { describe, expect, it } from 'vitest';
import { filterMacros, slashQuery } from './macro-search';

describe('slashQuery', () => {
  it('opens on a "/" at the start of the reply or of a line', () => {
    expect(slashQuery('/')).toEqual({ start: 0, query: '' });
    expect(slashQuery('/thanks sol')).toEqual({ start: 0, query: 'thanks sol' });
    expect(slashQuery('Hello,\n/esc')).toEqual({ start: 7, query: 'esc' });
  });

  it('stays closed for slashes inside text and for finished lines', () => {
    expect(slashQuery('see /etc/hosts')).toBeNull();
    expect(slashQuery('https://example.com')).toBeNull();
    expect(slashQuery('/thanks\nand more')).toBeNull();
    expect(slashQuery('')).toBeNull();
  });
});

describe('filterMacros', () => {
  const macros = [
    { title: 'Thanks, solved', owner_id: null },
    { title: 'Escalate to billing', owner_id: null },
    { title: 'Thanks for waiting', owner_id: 'me' },
    ...Array.from({ length: 10 }, (_, i) => ({ title: `Template ${i}`, owner_id: null })),
  ];

  it('needs every typed word, in any order, ignoring case', () => {
    expect(filterMacros(macros, 'SOLVED thanks').map((m) => m.title)).toEqual(['Thanks, solved']);
    expect(filterMacros(macros, 'zzz')).toEqual([]);
  });

  it('lists personal macros first, then shared, alphabetically', () => {
    expect(filterMacros(macros, 'thanks').map((m) => m.title)).toEqual(['Thanks for waiting', 'Thanks, solved']);
  });

  it('shows at most 8', () => {
    expect(filterMacros(macros, '')).toHaveLength(8);
  });
});
