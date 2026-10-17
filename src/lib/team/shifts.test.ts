import { describe, expect, it } from 'vitest';
import {
  formatShiftSummary,
  isOnShift,
  localWeekMinute,
  parseClock,
  pickRecipients,
  validateShifts,
  type ShiftMember,
} from './shifts';

const MON = 1;
const NINE_TO_FIVE = (weekday: number) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 });

function member(id: string, patch: Partial<ShiftMember> = {}): ShiftMember {
  return { id, email: `${id}@acme.test`, role: 'agent', is_active: true, wants_email: true, shifts: [], ...patch };
}

describe('isOnShift', () => {
  it('covers the start but not the end minute', () => {
    expect(isOnShift([NINE_TO_FIVE(MON)], { weekday: MON, minute: 9 * 60 })).toBe(true);
    expect(isOnShift([NINE_TO_FIVE(MON)], { weekday: MON, minute: 17 * 60 - 1 })).toBe(true);
    expect(isOnShift([NINE_TO_FIVE(MON)], { weekday: MON, minute: 17 * 60 })).toBe(false);
    expect(isOnShift([NINE_TO_FIVE(MON)], { weekday: 2, minute: 10 * 60 })).toBe(false);
  });

  it('runs a night shift past midnight into the next day', () => {
    const night = [{ weekday: MON, start_minute: 22 * 60, end_minute: 6 * 60 }];
    expect(isOnShift(night, { weekday: MON, minute: 23 * 60 })).toBe(true);
    expect(isOnShift(night, { weekday: 2, minute: 5 * 60 })).toBe(true);
    expect(isOnShift(night, { weekday: 2, minute: 7 * 60 })).toBe(false);
    expect(isOnShift(night, { weekday: MON, minute: 5 * 60 })).toBe(false);
  });

  it('wraps a Saturday night shift into Sunday morning', () => {
    const sat = [{ weekday: 6, start_minute: 20 * 60, end_minute: 2 * 60 }];
    expect(isOnShift(sat, { weekday: 0, minute: 60 })).toBe(true);
  });
});

describe('localWeekMinute', () => {
  it('reads the day and time in the workspace timezone', () => {
    // Monday 2026-10-12 04:30 UTC is Monday 09:30 in Karachi (UTC+5).
    expect(localWeekMinute(new Date('2026-10-12T04:30:00Z'), 'Asia/Karachi')).toEqual({ weekday: MON, minute: 9 * 60 + 30 });
    expect(localWeekMinute(new Date('2026-10-12T00:15:00Z'), 'UTC')).toEqual({ weekday: MON, minute: 15 });
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(localWeekMinute(new Date('2026-10-12T00:15:00Z'), 'Not/AZone')).toEqual({ weekday: MON, minute: 15 });
  });
});

describe('pickRecipients', () => {
  const at = { weekday: MON, minute: 10 * 60 };

  it('sends only to members on shift', () => {
    const r = pickRecipients({
      members: [member('ali', { shifts: [NINE_TO_FIVE(MON)] }), member('sara', { shifts: [NINE_TO_FIVE(2)] }), member('omar')],
      assigneeId: null,
      fallbackIds: [],
      at,
    });
    expect(r).toEqual({ ids: ['ali'], reason: 'on_shift' });
  });

  it('narrows to the assignee when they are on shift', () => {
    const r = pickRecipients({
      members: [member('ali', { shifts: [NINE_TO_FIVE(MON)] }), member('sara', { shifts: [NINE_TO_FIVE(MON)] })],
      assigneeId: 'sara',
      fallbackIds: [],
      at,
    });
    expect(r).toEqual({ ids: ['sara'], reason: 'assignee_on_shift' });
  });

  it('ignores an assignee who is off shift and tells whoever is on', () => {
    const r = pickRecipients({
      members: [member('ali', { shifts: [NINE_TO_FIVE(MON)] }), member('sara', { shifts: [NINE_TO_FIVE(2)] })],
      assigneeId: 'sara',
      fallbackIds: [],
      at,
    });
    expect(r.ids).toEqual(['ali']);
  });

  it('falls back to the owner and admins when nobody is on shift', () => {
    const r = pickRecipients({
      members: [member('owner', { role: 'owner' }), member('ali', { shifts: [NINE_TO_FIVE(2)] })],
      assigneeId: null,
      fallbackIds: ['owner'],
      at,
    });
    expect(r).toEqual({ ids: ['owner'], reason: 'nobody_on_shift' });
  });

  it('without any shifts: the assignee, or everyone when unassigned', () => {
    const members = [member('ali'), member('sara')];
    expect(pickRecipients({ members, assigneeId: 'sara', fallbackIds: [], at })).toEqual({ ids: ['sara'], reason: 'assignee' });
    expect(pickRecipients({ members, assigneeId: null, fallbackIds: [], at })).toEqual({ ids: ['ali', 'sara'], reason: 'everyone' });
  });

  it('never emails light agents, deactivated members, opted-out members or members without an address', () => {
    const r = pickRecipients({
      members: [
        member('light', { role: 'light_agent' }),
        member('gone', { is_active: false }),
        member('quiet', { wants_email: false }),
        member('noemail', { email: null }),
        member('ali'),
      ],
      assigneeId: null,
      fallbackIds: [],
      at,
    });
    expect(r.ids).toEqual(['ali']);
  });

  it('a deactivated member’s old shifts do not switch shift mode on', () => {
    const r = pickRecipients({
      members: [member('gone', { is_active: false, shifts: [NINE_TO_FIVE(2)] }), member('ali')],
      assigneeId: null,
      fallbackIds: [],
      at,
    });
    expect(r).toEqual({ ids: ['ali'], reason: 'everyone' });
  });
});

describe('shift helpers', () => {
  it('parses and validates times', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('24:00')).toBeNull();
    expect(validateShifts([{ weekday: 1, start_minute: 540, end_minute: 540 }])).toMatch(/same/);
    expect(validateShifts([{ weekday: 7, start_minute: 0, end_minute: 60 }])).toMatch(/day/);
    expect(validateShifts([NINE_TO_FIVE(1)])).toBeNull();
  });

  it('summarises consecutive days with the same hours', () => {
    expect(formatShiftSummary([1, 2, 3, 4, 5].map(NINE_TO_FIVE))).toBe('Mon–Fri 09:00–17:00');
    expect(formatShiftSummary([NINE_TO_FIVE(1), { weekday: 6, start_minute: 600, end_minute: 840 }])).toBe('Mon 09:00–17:00; Sat 10:00–14:00');
    expect(formatShiftSummary([])).toBe('');
  });
});
