import { describe, expect, it } from 'vitest';
import {
  SYSTEM_VIEWS,
  applyTicketFilters,
  normalizeFilters,
  normalizeSort,
  parseTicketNumber,
  sortColumn,
  type FilterableQuery,
} from '@/lib/tickets/views';
import { sanitizeTicketPatch } from '@/lib/tickets/patch';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';

/** Records the filter calls a view makes. */
class Recorder implements FilterableQuery<Recorder> {
  calls: [string, ...unknown[]][] = [];
  eq(c: string, v: unknown) { this.calls.push(['eq', c, v]); return this; }
  in(c: string, v: readonly unknown[]) { this.calls.push(['in', c, [...v]]); return this; }
  is(c: string, v: null) { this.calls.push(['is', c, v]); return this; }
  or(f: string) { this.calls.push(['or', f]); return this; }
  overlaps(c: string, v: readonly unknown[]) { this.calls.push(['overlaps', c, [...v]]); return this; }
  gte(c: string, v: string) { this.calls.push(['gte', c, v]); return this; }
}

const run = (filters: Parameters<typeof applyTicketFilters>[1], now = new Date('2026-10-09T12:00:00Z')) =>
  applyTicketFilters(new Recorder(), filters, ME, now).calls;

describe('system views', () => {
  const byName = Object.fromEntries(SYSTEM_VIEWS.map((v) => [v.name, v]));

  it('are the five inbox views', () => {
    expect(SYSTEM_VIEWS.map((v) => v.name)).toEqual(['My open tickets', 'Unassigned', 'All open', 'Pending', 'Recently solved']);
  });

  it('"My open tickets" means assigned to whoever is looking, new or open', () => {
    expect(run(byName['My open tickets'].filters)).toEqual([
      ['in', 'status', ['new', 'open']],
      ['in', 'assignee_id', [ME]],
    ]);
  });

  it('"Unassigned" covers every unsolved status', () => {
    expect(run(byName['Unassigned'].filters)).toEqual([
      ['in', 'status', ['new', 'open', 'pending', 'on_hold']],
      ['is', 'assignee_id', null],
    ]);
  });

  it('"Recently solved" is the last 7 days of solved and closed, newest first', () => {
    const v = byName['Recently solved'];
    expect(run(v.filters)).toEqual([
      ['in', 'status', ['solved', 'closed']],
      ['gte', 'solved_at', '2026-10-02T12:00:00.000Z'],
    ]);
    expect(v.sort).toEqual({ field: 'solved_at', direction: 'desc' });
  });
});

describe('custom view filters', () => {
  it('apply status, priority, type, channel and tags', () => {
    expect(
      run({ status: ['open'], priority: ['high', 'urgent'], type: ['incident'], channel: ['email'], tags: ['vip'] })
    ).toEqual([
      ['in', 'status', ['open']],
      ['in', 'priority', ['high', 'urgent']],
      ['in', 'type', ['incident']],
      ['in', 'channel', ['email']],
      ['overlaps', 'tags', ['vip']],
    ]);
  });

  it('combine "unassigned" with specific assignees or groups', () => {
    expect(run({ assignee: ['none', A] })).toEqual([['or', `assignee_id.is.null,assignee_id.in.(${A})`]]);
    expect(run({ group: [B] })).toEqual([['in', 'group_id', [B]]]);
    expect(run({ group: ['none'] })).toEqual([['is', 'group_id', null]]);
  });

  it('ignore anything not understood, so a saved view can never inject a filter', () => {
    const filters = normalizeFilters({
      status: ['open', 'deleted', 42],
      priority: 'high',
      assignee: ['me', 'not-a-uuid', `${A}),workspace_id.neq.(x`],
      group: [B, 'none'],
      tags: ['  VIP Customer ', 'vip customer', '<script>'],
      channel: ['fax', 'chat'],
      workspace_id: 'other',
      solvedWithinDays: '9999',
    });
    expect(filters).toEqual({
      status: ['open'],
      assignee: ['me'],
      group: [B, 'none'],
      tags: ['vip-customer', 'script'],
      channel: ['chat'],
      solvedWithinDays: 365,
    });
    expect(normalizeFilters(null)).toEqual({});
    expect(normalizeFilters('status=open')).toEqual({});
  });
});

describe('sorting', () => {
  it('sorts priority and status by rank, not alphabetically', () => {
    expect(sortColumn({ field: 'priority', direction: 'desc' })).toBe('priority_rank');
    expect(sortColumn({ field: 'status', direction: 'asc' })).toBe('status_rank');
    expect(sortColumn({ field: 'created_at', direction: 'asc' })).toBe('created_at');
  });

  it('falls back to most recently updated for anything unknown', () => {
    expect(normalizeSort({ field: 'password', direction: 'sideways' })).toEqual({ field: 'updated_at', direction: 'desc' });
    expect(normalizeSort({ field: 'number', direction: 'asc' })).toEqual({ field: 'number', direction: 'asc' });
  });
});

describe('search by number', () => {
  it.each([
    ['#1042', 1042],
    ['1042', 1042],
    [' #7 ', 7],
    ['1042a', null],
    ['refund', null],
  ])('%s → %s', (input, expected) => expect(parseTicketNumber(input)).toBe(expected));
});

describe('ticket patches', () => {
  it('keep only fields agents may set', () => {
    expect(
      sanitizeTicketPatch({
        subject: '  Card declined  ',
        status: 'pending',
        priority: 'urgent',
        type: 'incident',
        assignee_id: A,
        group_id: null,
        tags: ['Billing', 'billing', ' VIP '],
        // @ts-expect-error: not a patchable field
        workspace_id: B,
        number: 1,
      })
    ).toEqual({
      subject: 'Card declined',
      status: 'pending',
      priority: 'urgent',
      type: 'incident',
      assignee_id: A,
      group_id: null,
      tags: ['billing', 'vip'],
    });
  });

  it('refuse New as a status and invalid values', () => {
    expect(
      sanitizeTicketPatch({
        status: 'new',
        // @ts-expect-error: invalid on purpose
        priority: 'critical',
        assignee_id: 'someone',
      })
    ).toEqual({});
  });
});
