/**
 * SLA policies as the settings screen and the ticket screens see them: the
 * shapes, the form validation (kept in step with fn_sla_policy_before_write in
 * supabase/migrations/20261016090000_sla_policies.sql), the plain-language
 * summary of a policy, and the badge a ticket shows.
 *
 * The timing itself (business hours, holidays, pauses) is computed in the
 * database, where every writer is covered; the badge only reads the cached
 * due time from the ticket, so it never re-implements that maths.
 */
import type { TicketPriority } from '@/types/database';

export const SLA_METRICS = ['first_reply', 'next_reply', 'resolution'] as const;
export type SlaMetric = (typeof SLA_METRICS)[number];
export const SLA_PRIORITIES: readonly TicketPriority[] = ['urgent', 'high', 'normal', 'low'];

export const METRIC_LABEL: Record<SlaMetric, string> = {
  first_reply: 'First reply time',
  next_reply: 'Next reply time',
  resolution: 'Resolution time',
};
/** Short form for badges and tooltips. */
export const METRIC_SHORT: Record<SlaMetric, string> = {
  first_reply: 'First reply',
  next_reply: 'Next reply',
  resolution: 'Resolution',
};
const METRIC_PHRASE: Record<SlaMetric, string> = {
  first_reply: 'first reply within',
  next_reply: 'next reply within',
  resolution: 'resolved within',
};
const PRIORITY_NAME: Record<TicketPriority, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };

export const MAX_TARGET_MINUTES = 43_200; // 30 days, the same cap as the database
export const MAX_ALERT_MINUTES = 1_440;
export const MAX_LIST = 50;

export type SlaTargets = Partial<Record<TicketPriority, Partial<Record<SlaMetric, number>>>>;

export interface SlaConditions {
  channels?: string[];
  group_ids?: string[];
  tags?: string[];
  requester_emails?: string[];
  requester_domains?: string[];
}

export interface SlaPolicyRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  position: number;
  is_active: boolean;
  conditions: SlaConditions;
  targets: SlaTargets;
  business_hours: boolean;
  alert_before_minutes: number;
  notify_assignee: boolean;
  notify_group: boolean;
}

export interface SlaPolicyDraft {
  id?: string;
  name: string;
  description: string;
  is_active: boolean;
  conditions: SlaConditions;
  targets: SlaTargets;
  business_hours: boolean;
  alert_before_minutes: number;
  notify_assignee: boolean;
  notify_group: boolean;
}

export interface Holiday {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  repeats_yearly: boolean;
}

export function blankPolicy(): SlaPolicyDraft {
  return {
    name: '',
    description: '',
    is_active: true,
    conditions: {},
    targets: {},
    business_hours: false,
    alert_before_minutes: 30,
    notify_assignee: true,
    notify_group: true,
  };
}

export function draftFromRow(row: SlaPolicyRow): SlaPolicyDraft {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    is_active: row.is_active,
    conditions: normalizeConditions(row.conditions),
    targets: normalizeTargets(row.targets),
    business_hours: row.business_hours,
    alert_before_minutes: row.alert_before_minutes,
    notify_assignee: row.notify_assignee,
    notify_group: row.notify_group,
  };
}

/* ── Durations ────────────────────────────────────────────────────────── */

export type DurationUnit = 'minutes' | 'hours' | 'days';
export const UNIT_MINUTES: Record<DurationUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** 90 → "1 h 30 min"; 1440 → "1 day"; 45 → "45 min". */
export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  if (m === 0) return '0 min';
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours) parts.push(`${hours} h`);
  if (mins) parts.push(`${mins} min`);
  return parts.join(' ');
}

/** The largest unit that divides the value evenly, for showing it in a form. */
export function splitMinutes(total: number): { value: number; unit: DurationUnit } {
  if (total > 0 && total % 1440 === 0) return { value: total / 1440, unit: 'days' };
  if (total > 0 && total % 60 === 0) return { value: total / 60, unit: 'hours' };
  return { value: total, unit: 'minutes' };
}

export function toMinutes(value: number, unit: DurationUnit): number {
  return Math.round(value * UNIT_MINUTES[unit]);
}

/* ── Holidays ─────────────────────────────────────────────────────────── */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface HolidayInput {
  id?: string;
  name: string;
  starts_on: string;
  ends_on: string;
  repeats_yearly: boolean;
}

/** The same limits as the table's CHECK constraints, with messages a form can show. */
export function holidayError(input: HolidayInput): string | null {
  const name = (input.name || '').trim();
  if (!name) return 'Give the holiday a name.';
  if (name.length > 100) return 'Keep the name under 100 characters.';
  if (!ISO_DATE.test(input.starts_on) || !ISO_DATE.test(input.ends_on)) return 'Choose a start and end date.';
  const start = Date.parse(`${input.starts_on}T00:00:00Z`);
  const end = Date.parse(`${input.ends_on}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 'Choose a valid date.';
  if (end < start) return 'The end date cannot be before the start date.';
  if ((end - start) / 86_400_000 > 60) return 'A holiday can last at most 61 days. Add a second entry for longer closures.';
  if (input.repeats_yearly && input.starts_on.slice(0, 4) !== input.ends_on.slice(0, 4)) {
    return 'A yearly holiday has to stay inside one year. Add one entry for each part.';
  }
  return null;
}

/* ── Normalising what the database or a form hands us ─────────────────── */

const uniq = (values: unknown, lower = true): string[] | undefined => {
  if (!Array.isArray(values)) return undefined;
  const out = Array.from(
    new Set(values.filter((v): v is string => typeof v === 'string').map((v) => (lower ? v.trim().toLowerCase() : v.trim())).filter(Boolean))
  );
  return out.length ? out.slice(0, MAX_LIST) : undefined;
};

/** Drops empty dimensions (an empty list means "any", the same as absent). */
export function normalizeConditions(input: unknown): SlaConditions {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: SlaConditions = {
    channels: uniq(raw.channels),
    group_ids: uniq(raw.group_ids),
    tags: uniq(raw.tags),
    requester_emails: uniq(raw.requester_emails),
    requester_domains: uniq(raw.requester_domains)?.map((d) => d.replace(/^@/, '')),
  };
  for (const key of Object.keys(out) as (keyof SlaConditions)[]) {
    if (!out[key]) delete out[key];
  }
  return out;
}

/** Keeps only whole-minute targets in range; priorities with none are dropped. */
export function normalizeTargets(input: unknown): SlaTargets {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: SlaTargets = {};
  for (const prio of SLA_PRIORITIES) {
    const row = raw[prio];
    if (!row || typeof row !== 'object') continue;
    const clean: Partial<Record<SlaMetric, number>> = {};
    for (const metric of SLA_METRICS) {
      const n = Number((row as Record<string, unknown>)[metric]);
      if (Number.isFinite(n) && n >= 1) clean[metric] = Math.min(Math.round(n), MAX_TARGET_MINUTES);
    }
    if (Object.keys(clean).length) out[prio] = clean;
  }
  return out;
}

/* ── Validation ───────────────────────────────────────────────────────── */

export type PolicyErrors = Partial<Record<'name' | 'targets' | 'alert' | 'conditions', string>>;

export function validatePolicyDraft(draft: SlaPolicyDraft): PolicyErrors {
  const errors: PolicyErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Give the policy a name.';
  else if (name.length > 80) errors.name = 'Keep the name under 80 characters.';

  let any = false;
  for (const prio of SLA_PRIORITIES) {
    for (const metric of SLA_METRICS) {
      const v = draft.targets[prio]?.[metric];
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 1 || v > MAX_TARGET_MINUTES) {
        errors.targets = `${PRIORITY_NAME[prio]} ${METRIC_SHORT[metric].toLowerCase()} must be a whole number of minutes between 1 and ${MAX_TARGET_MINUTES} (30 days).`;
        return withRest(errors, draft);
      }
      any = true;
    }
  }
  if (!any) errors.targets = 'Set at least one target, for example a first reply time for Normal.';
  return withRest(errors, draft);
}

function withRest(errors: PolicyErrors, draft: SlaPolicyDraft): PolicyErrors {
  if (!Number.isInteger(draft.alert_before_minutes) || draft.alert_before_minutes < 0 || draft.alert_before_minutes > MAX_ALERT_MINUTES) {
    errors.alert = `Warn between 0 and ${MAX_ALERT_MINUTES} minutes before a breach (0 turns warnings off).`;
  }
  const c = draft.conditions;
  const sizes = [c.channels, c.group_ids, c.tags, c.requester_emails, c.requester_domains].map((l) => l?.length ?? 0);
  if (sizes.some((n) => n > MAX_LIST)) errors.conditions = `Each condition takes at most ${MAX_LIST} entries.`;
  const badEmail = c.requester_emails?.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (badEmail) errors.conditions = `“${badEmail}” is not an email address.`;
  const badDomain = c.requester_domains?.find((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d));
  if (badDomain) errors.conditions = `“${badDomain}” is not a domain such as acme.com.`;
  return errors;
}

export const hasPolicyErrors = (e: PolicyErrors) => Object.keys(e).length > 0;

/** Splits "a, b ,c" into a trimmed, de-duplicated list. */
export function parseList(text: string): string[] {
  return Array.from(new Set(text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)));
}

/* ── Plain-language summary ───────────────────────────────────────────── */

export interface SummaryLookups {
  groups: Record<string, string>;
  channels: Record<string, string>;
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** "Applies to tickets from Email or Chat, in group Billing, tagged vip, from acme.com." */
export function summarizeConditions(conditions: SlaConditions, lookups: SummaryLookups): string {
  const c = normalizeConditions(conditions);
  const parts: string[] = [];
  if (c.channels) parts.push(`from ${joinOr(c.channels.map((ch) => lookups.channels[ch] ?? ch))}`);
  if (c.group_ids) parts.push(`in ${c.group_ids.length === 1 ? 'group' : 'groups'} ${joinOr(c.group_ids.map((g) => lookups.groups[g] ?? 'a deleted group'))}`);
  if (c.tags) parts.push(`tagged ${joinOr(c.tags)}`);
  const requesters = [...(c.requester_emails ?? []), ...(c.requester_domains ?? []).map((d) => `anyone at ${d}`)];
  if (requesters.length) parts.push(`requested by ${joinOr(requesters)}`);
  if (parts.length === 0) return 'Applies to every ticket that no earlier policy matches.';
  return `Applies to tickets ${parts.join(', ')}.`;
}

/** One line per priority that has targets, most urgent first. */
export function summarizeTargets(targets: SlaTargets): string[] {
  const t = normalizeTargets(targets);
  const lines: string[] = [];
  for (const prio of SLA_PRIORITIES) {
    const row = t[prio];
    if (!row) continue;
    const bits = SLA_METRICS.filter((m) => row[m] !== undefined).map((m) => `${METRIC_PHRASE[m]} ${formatMinutes(row[m]!)}`);
    lines.push(`${PRIORITY_NAME[prio]}: ${bits.join(', ')}.`);
  }
  return lines;
}

export function summarizeAlerts(policy: Pick<SlaPolicyDraft, 'alert_before_minutes' | 'notify_assignee' | 'notify_group'>): string {
  const who = [policy.notify_assignee && 'the assignee', policy.notify_group && "the ticket's group"].filter(Boolean) as string[];
  if (who.length === 0) return 'Nobody is emailed; breaches are still recorded for reports.';
  const when = policy.alert_before_minutes > 0 ? `Emails ${who.join(' and ')} ${formatMinutes(policy.alert_before_minutes)} before a target is missed, and again when it is.` : `Emails ${who.join(' and ')} when a target is missed.`;
  return when;
}

export function summarizeClock(businessHours: boolean): string {
  return businessHours
    ? 'Counts business hours only (your hours and holidays); the clock stops outside them.'
    : 'Counts every hour of the day, including nights, weekends and holidays.';
}

export const PAUSE_NOTE = 'The clock pauses while a ticket is Pending or On-hold.';

/** The whole plain-language description of a policy, as separate lines. */
export function summarizePolicy(policy: SlaPolicyDraft | SlaPolicyRow, lookups: SummaryLookups): string[] {
  return [
    summarizeConditions(policy.conditions, lookups),
    ...summarizeTargets(policy.targets),
    `${summarizeClock(policy.business_hours)} ${PAUSE_NOTE}`,
    summarizeAlerts(policy),
  ];
}

/* ── The badge ────────────────────────────────────────────────────────── */

export interface SlaCache {
  sla_state?: 'running' | 'paused' | 'met' | null;
  sla_next_due_at?: string | null;
  sla_next_warn_at?: string | null;
  sla_next_metric?: SlaMetric | null;
  sla_breached_at?: string | null;
}

export type SlaTone = 'neutral' | 'success' | 'warn' | 'danger';
export interface SlaBadgeInfo {
  tone: SlaTone;
  /** Short enough for a table cell: "1h 20m", "Breached 2h ago". */
  label: string;
  /** Longer, for a tooltip and screen readers. */
  detail: string;
  /** True once a target has been missed (the badge is red). */
  breached: boolean;
}

/** 90 s → "2m"; 5 h 5 m → "5h 5m"; 3 d 4 h → "3d 4h". Rounds up so "0m" never shows while time is left. */
export function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  if (totalMinutes < 1) return '<1m';
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * What to show for a ticket's SLA, or null when it has none. Amber starts at
 * the policy's warning point (the moment the "due soon" email goes out), red
 * once the due time has passed or a breach was recorded. Paused tickets show
 * their state instead of a ticking clock.
 */
export function slaBadge(ticket: SlaCache, now: Date = new Date()): SlaBadgeInfo | null {
  const state = ticket.sla_state;
  if (!state) return null;
  const metric = ticket.sla_next_metric ? METRIC_SHORT[ticket.sla_next_metric] : 'SLA';
  const breachedAt = ticket.sla_breached_at ? new Date(ticket.sla_breached_at) : null;

  if (state === 'met') {
    return { tone: 'success', label: 'SLA met', detail: 'Every SLA target on this ticket was met.', breached: false };
  }
  if (state === 'paused') {
    if (breachedAt) {
      return { tone: 'danger', label: 'Breached', detail: `An SLA target was breached ${formatRemaining(now.getTime() - breachedAt.getTime())} ago. The clock is paused while the ticket waits.`, breached: true };
    }
    return { tone: 'neutral', label: 'SLA paused', detail: 'The clock is paused while the ticket is Pending or On-hold.', breached: false };
  }

  const due = ticket.sla_next_due_at ? new Date(ticket.sla_next_due_at) : null;
  if (breachedAt || (due && due.getTime() <= now.getTime())) {
    const since = breachedAt ?? due!;
    const ago = formatRemaining(Math.max(0, now.getTime() - since.getTime()));
    return {
      tone: 'danger',
      label: `Breached ${ago} ago`,
      detail: `${metric} target breached ${ago} ago.`,
      breached: true,
    };
  }
  if (!due) return { tone: 'neutral', label: 'SLA', detail: 'An SLA applies to this ticket.', breached: false };

  const remaining = due.getTime() - now.getTime();
  const warnAt = ticket.sla_next_warn_at ? new Date(ticket.sla_next_warn_at) : null;
  const near = warnAt !== null && warnAt.getTime() <= now.getTime();
  const left = formatRemaining(remaining);
  return {
    tone: near ? 'warn' : 'neutral',
    label: left,
    detail: `${metric} due in ${left}${near ? ' (close to breach)' : ''}.`,
    breached: false,
  };
}
