import { describe, expect, it } from 'vitest';
import { flatten, isPaletteShortcut, moveHighlight, rankItems, scoreItem, type PaletteItem } from './command-palette';

const items: PaletteItem[] = [
  { id: 'nav:inbox', group: 'Navigate', title: 'Inbox' },
  { id: 'nav:tickets', group: 'Navigate', title: 'Tickets' },
  { id: 'nav:settings', group: 'Navigate', title: 'Settings' },
  { id: 'view:my', group: 'Ticket views', title: 'My open tickets' },
  { id: 'view:unassigned', group: 'Ticket views', title: 'Unassigned' },
  { id: 'set:email', group: 'Settings', title: 'Email (SMTP)', keywords: ['smtp', 'mail server'] },
  { id: 'set:team', group: 'Settings', title: 'Team Members & Roles', keywords: ['invite', 'agents'] },
  { id: 'set:domains', group: 'Settings', title: 'Custom Domains & DNS' },
  { id: 't:1003', group: 'Tickets', title: '#1003 The widget does not load on checkout', subtitle: 'Sofia Rossi' },
  { id: 't:1010', group: 'Tickets', title: '#1010 Refund for October', subtitle: 'Lena Fischer' },
];

const ids = (q: string) => flatten(rankItems(q, items)).map((i) => i.id);

describe('command palette ranking', () => {
  it('shows everything in natural order for an empty query', () => {
    expect(ids('')).toEqual([
      't:1003',
      't:1010',
      'nav:inbox',
      'nav:tickets',
      'nav:settings',
      'view:my',
      'view:unassigned',
      'set:email',
      'set:team',
      'set:domains',
    ]);
  });

  it('prefers a title prefix over a match inside a word', () => {
    const r = ids('ti');
    expect(r.indexOf('nav:tickets')).toBeLessThan(r.indexOf('nav:settings'));
  });

  it('finds settings by keyword', () => {
    expect(ids('smtp')).toEqual(['set:email']);
    expect(ids('invite')).toEqual(['set:team']);
  });

  it('matches ticket numbers with or without #', () => {
    expect(ids('1003')).toEqual(['t:1003']);
    expect(ids('#1003')).toEqual(['t:1003']);
    // A number never fuzzy-matches unrelated titles.
    expect(ids('10')).toEqual(['t:1003', 't:1010']);
    expect(ids('100')).toEqual(['t:1003']);
  });

  it('matches multi-word queries against word starts', () => {
    expect(ids('cust dom')).toEqual(['set:domains']);
  });

  it('falls back to in-order characters', () => {
    expect(scoreItem('unsgnd', items[4])).not.toBeNull();
    expect(scoreItem('zzz', items[4])).toBeNull();
  });

  it('ignores case and accents', () => {
    expect(ids('INBOX')).toEqual(['nav:inbox']);
    expect(scoreItem('reunion', { id: 'x', group: 'Actions', title: 'Réunion' })).toBe(120);
  });

  it('matches requester names through the subtitle', () => {
    expect(ids('lena')).toEqual(['t:1010']);
  });

  it('caps each group', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, group: 'Navigate' as const, title: `Item ${i}` }));
    expect(rankItems('item', many, 5)[0].items).toHaveLength(5);
  });
});

describe('highlight movement', () => {
  it('wraps around both ends', () => {
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });
});

describe('shortcut', () => {
  const k = { key: 'k', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  it('accepts Ctrl+K and Cmd+K only', () => {
    expect(isPaletteShortcut({ ...k, ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...k, metaKey: true, key: 'K' })).toBe(true);
    expect(isPaletteShortcut(k)).toBe(false);
    expect(isPaletteShortcut({ ...k, ctrlKey: true, shiftKey: true })).toBe(false);
  });
});
