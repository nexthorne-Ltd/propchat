/**
 * Member shifts and who gets a team email.
 *
 * Shift hours are weekly, in the workspace's timezone (agent_shifts, migration
 * 20261103090000_team_invites_and_shifts.sql). The rule for recipients:
 *
 *   - Only active members who can reply (not light agents), with an email
 *     address, who have not turned the email off in their preferences.
 *   - If anyone has shift hours and someone's shift is running now, only the
 *     members on shift get it. A conversation already assigned to one of them
 *     goes to that person alone.
 *   - If shifts exist but nobody is on shift right now, the owner and admins
 *     get it, so a waiting customer is never told to nobody.
 *   - If nobody has shift hours, the assignee gets it, or everyone when the
 *     conversation is unassigned.
 */

export interface Shift {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes from midnight. An end at or before the start runs past midnight. */
  start_minute: number;
  end_minute: number;
}

export interface ShiftMember {
  id: string;
  email: string | null;
  role: string;
  is_active: boolean;
  /** False when the member turned this email off in their preferences. */
  wants_email: boolean;
  shifts: Shift[];
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const MINUTES_PER_WEEK = 7 * 24 * 60;

/** Day of week and minute of day for `now` in `timeZone` (UTC when invalid). */
export function localWeekMinute(now: Date, timeZone: string | null | undefined): { weekday: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return localWeekMinute(now, 'UTC');
  }
  const weekday = WEEKDAYS.indexOf((parts.find((p) => p.type === 'weekday')?.value || 'Sun') as (typeof WEEKDAYS)[number]);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return { weekday: Math.max(0, weekday), minute: hour * 60 + minute };
}

/** Whether any of the shifts covers this moment of the week. */
export function isOnShift(shifts: Shift[], at: { weekday: number; minute: number }): boolean {
  const now = at.weekday * 1440 + at.minute;
  return shifts.some((s) => {
    const start = s.weekday * 1440 + s.start_minute;
    const length = (s.end_minute - s.start_minute + 1440) % 1440;
    // Distance from the start, wrapping round the end of the week (Saturday
    // night into Sunday morning).
    const since = (now - start + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
    return since < length;
  });
}

export interface RecipientChoice {
  ids: string[];
  /** Why these people, for logs and the internal note. */
  reason: 'assignee_on_shift' | 'on_shift' | 'nobody_on_shift' | 'assignee' | 'everyone' | 'nobody';
}

export function pickRecipients(input: {
  members: ShiftMember[];
  assigneeId: string | null;
  /** Owner and admins: used when shifts exist but none is running. */
  fallbackIds: string[];
  at: { weekday: number; minute: number };
}): RecipientChoice {
  const eligible = input.members.filter(
    (m) => m.is_active && m.role !== 'light_agent' && m.wants_email && Boolean(m.email && m.email.includes('@'))
  );
  if (!eligible.length) return { ids: [], reason: 'nobody' };

  const anyShifts = input.members.some((m) => m.is_active && m.shifts.length > 0);
  if (anyShifts) {
    const onShift = eligible.filter((m) => m.shifts.length > 0 && isOnShift(m.shifts, input.at));
    if (onShift.length) {
      const assignee = onShift.find((m) => m.id === input.assigneeId);
      return assignee ? { ids: [assignee.id], reason: 'assignee_on_shift' } : { ids: onShift.map((m) => m.id), reason: 'on_shift' };
    }
    const fallback = eligible.filter((m) => input.fallbackIds.includes(m.id));
    return fallback.length ? { ids: fallback.map((m) => m.id), reason: 'nobody_on_shift' } : { ids: [], reason: 'nobody' };
  }

  const assignee = eligible.find((m) => m.id === input.assigneeId);
  if (assignee) return { ids: [assignee.id], reason: 'assignee' };
  return { ids: eligible.map((m) => m.id), reason: 'everyone' };
}

/** "09:00" → 540; null when not a valid HH:MM. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatClock(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "Mon–Fri 09:00–17:00", "Mon 09:00–13:00, Sat 10:00–14:00", or "" with no shifts. */
export function formatShiftSummary(shifts: Shift[]): string {
  if (!shifts.length) return '';
  const sorted = [...shifts].sort((a, b) => a.weekday - b.weekday || a.start_minute - b.start_minute);
  const groups: { days: number[]; start: number; end: number }[] = [];
  for (const s of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.start === s.start_minute && last.end === s.end_minute && last.days[last.days.length - 1] === s.weekday - 1) {
      last.days.push(s.weekday);
    } else {
      groups.push({ days: [s.weekday], start: s.start_minute, end: s.end_minute });
    }
  }
  return groups
    .map((g) => {
      const days = g.days.length > 2 ? `${WEEKDAYS[g.days[0]]}–${WEEKDAYS[g.days[g.days.length - 1]]}` : g.days.map((d) => WEEKDAYS[d]).join(', ');
      return `${days} ${formatClock(g.start)}–${formatClock(g.end)}`;
    })
    .join('; ');
}

/** Validates shifts sent from the browser; returns an error message or null. */
export function validateShifts(shifts: Shift[]): string | null {
  if (!Array.isArray(shifts)) return 'Shifts must be a list.';
  if (shifts.length > 21) return 'At most three shifts a day.';
  for (const s of shifts) {
    if (!Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) return 'Choose a day of the week.';
    for (const v of [s.start_minute, s.end_minute]) {
      if (!Number.isInteger(v) || v < 0 || v > 1439) return 'Times must be between 00:00 and 23:59.';
    }
    if (s.start_minute === s.end_minute) return `${WEEKDAYS[s.weekday]}: the start and end time are the same.`;
  }
  return null;
}
