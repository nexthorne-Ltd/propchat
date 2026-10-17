/**
 * Who a conversation goes to (chooseAssignee): the person on shift first,
 * online people only when no shift is running, never someone who cannot
 * take it.
 */
import { describe, expect, it } from 'vitest';
import { chooseAssignee, type AssignCandidate } from './auto-assign';

// Wednesday 14:00 in the workspace's timezone.
const at = { weekday: 3, minute: 14 * 60 };
const dayShift = [{ weekday: 3, start_minute: 9 * 60, end_minute: 17 * 60 }];
const nightShift = [{ weekday: 3, start_minute: 22 * 60, end_minute: 6 * 60 }];

const agent = (id: string, over: Partial<AssignCandidate> = {}): AssignCandidate => ({
  id,
  status: 'online',
  is_active: true,
  role: 'agent',
  max_open_tickets: null,
  shifts: [],
  ...over,
});

describe('chooseAssignee', () => {
  it('gives it to the person on shift, even when they show as away', () => {
    const choice = chooseAssignee({
      candidates: [agent('night', { shifts: nightShift }), agent('day', { status: 'away', shifts: dayShift })],
      load: new Map(),
      at,
    });
    expect(choice).toEqual({ id: 'day', basis: 'on_shift' });
  });

  it('prefers the online one among several on shift, then the least busy', () => {
    const choice = chooseAssignee({
      candidates: [
        agent('a', { status: 'away', shifts: dayShift }),
        agent('b', { shifts: dayShift }),
        agent('c', { shifts: dayShift }),
      ],
      load: new Map([['b', 3], ['c', 1]]),
      at,
    });
    expect(choice?.id).toBe('c');
  });

  it('falls back to online people when no shift is running', () => {
    const choice = chooseAssignee({
      candidates: [agent('night', { status: 'offline', shifts: nightShift }), agent('online')],
      load: new Map(),
      at,
    });
    expect(choice).toEqual({ id: 'online', basis: 'online' });
  });

  it('without any shifts, works as before: least-loaded online', () => {
    const choice = chooseAssignee({
      candidates: [agent('a'), agent('b'), agent('off', { status: 'offline' })],
      load: new Map([['a', 2]]),
      at,
    });
    expect(choice?.id).toBe('b');
  });

  it('never picks light agents, deactivated people or anyone at capacity', () => {
    const choice = chooseAssignee({
      candidates: [
        agent('light', { role: 'light_agent', shifts: dayShift }),
        agent('gone', { is_active: false, shifts: dayShift }),
        agent('full', { max_open_tickets: 2, shifts: dayShift }),
      ],
      load: new Map([['full', 2]]),
      at,
    });
    expect(choice).toBeNull();
  });

  it('keeps the current assignee when they are on shift', () => {
    const choice = chooseAssignee({
      candidates: [agent('mine', { status: 'away', shifts: dayShift }), agent('other', { shifts: dayShift })],
      load: new Map(),
      at,
      currentAssigneeId: 'mine',
    });
    expect(choice).toEqual({ id: 'mine', basis: 'kept' });
  });

  it('moves it off an assignee whose shift has ended', () => {
    const choice = chooseAssignee({
      candidates: [agent('night', { shifts: nightShift }), agent('day', { shifts: dayShift })],
      load: new Map(),
      at,
      currentAssigneeId: 'night',
    });
    expect(choice).toEqual({ id: 'day', basis: 'on_shift' });
  });
});
