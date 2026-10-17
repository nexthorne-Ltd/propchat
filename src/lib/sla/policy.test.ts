import { describe, expect, it } from 'vitest';
import {
  blankPolicy,
  formatMinutes,
  formatRemaining,
  hasPolicyErrors,
  holidayError,
  normalizeConditions,
  normalizeTargets,
  parseList,
  slaBadge,
  splitMinutes,
  summarizeAlerts,
  summarizeConditions,
  summarizePolicy,
  summarizeTargets,
  toMinutes,
  validatePolicyDraft,
  type SlaPolicyDraft,
} from './policy';

const lookups = { groups: { g1: 'Billing', g2: 'Tier 2' }, channels: { email: 'Email', chat: 'Chat' } };
const draft = (over: Partial<SlaPolicyDraft> = {}): SlaPolicyDraft => ({ ...blankPolicy(), name: 'VIP', targets: { normal: { first_reply: 30 } }, ...over });

describe('durations', () => {
  it('formats minutes the way people say them', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(90)).toBe('1 h 30 min');
    expect(formatMinutes(1440)).toBe('1 day');
    expect(formatMinutes(1440 * 2 + 60 + 5)).toBe('2 days 1 h 5 min');
  });

  it('round-trips through the form units', () => {
    expect(splitMinutes(2880)).toEqual({ value: 2, unit: 'days' });
    expect(splitMinutes(120)).toEqual({ value: 2, unit: 'hours' });
    expect(splitMinutes(90)).toEqual({ value: 90, unit: 'minutes' });
    expect(toMinutes(1.5, 'hours')).toBe(90);
    expect(toMinutes(2, 'days')).toBe(2880);
  });
});

describe('normalising stored policies', () => {
  it('drops empty conditions and normalises case, spacing and "@"', () => {
    expect(normalizeConditions({ tags: [' VIP ', 'vip', ''], requester_domains: ['@Acme.com'], channels: [] })).toEqual({
      tags: ['vip'],
      requester_domains: ['acme.com'],
    });
    expect(normalizeConditions(null)).toEqual({});
  });

  it('keeps whole-minute targets in range and drops priorities with none', () => {
    expect(normalizeTargets({ urgent: { first_reply: 15.4, resolution: 0 }, high: {}, bogus: { resolution: 5 }, low: { resolution: 99999 } })).toEqual({
      urgent: { first_reply: 15 },
      low: { resolution: 43200 },
    });
  });
});

describe('policy validation', () => {
  it('accepts a complete policy', () => {
    expect(hasPolicyErrors(validatePolicyDraft(draft()))).toBe(false);
  });

  it('needs a name and at least one target', () => {
    expect(validatePolicyDraft(draft({ name: '  ' })).name).toMatch(/name/);
    expect(validatePolicyDraft(draft({ targets: {} })).targets).toMatch(/at least one target/);
  });

  it('rejects out-of-range targets and alerts', () => {
    expect(validatePolicyDraft(draft({ targets: { high: { resolution: 0 } } })).targets).toMatch(/High resolution/);
    expect(validatePolicyDraft(draft({ targets: { normal: { resolution: 50_000 } } })).targets).toMatch(/43200/);
    expect(validatePolicyDraft(draft({ alert_before_minutes: -1 })).alert).toBeDefined();
    expect(validatePolicyDraft(draft({ alert_before_minutes: 0 })).alert).toBeUndefined();
  });

  it('rejects malformed requester conditions', () => {
    expect(validatePolicyDraft(draft({ conditions: { requester_emails: ['not-an-email'] } })).conditions).toMatch(/not an email/);
    expect(validatePolicyDraft(draft({ conditions: { requester_domains: ['acme'] } })).conditions).toMatch(/not a domain/);
    expect(validatePolicyDraft(draft({ conditions: { requester_domains: ['acme.com'], requester_emails: ['a@b.co'] } })).conditions).toBeUndefined();
  });

  it('parses comma and newline separated lists', () => {
    expect(parseList('a@b.co, c@d.co\n a@b.co ,')).toEqual(['a@b.co', 'c@d.co']);
  });
});

describe('plain-language summary', () => {
  it('describes who a policy applies to', () => {
    expect(summarizeConditions({}, lookups)).toBe('Applies to every ticket that no earlier policy matches.');
    expect(summarizeConditions({ channels: ['email', 'chat'], group_ids: ['g1'], tags: ['vip', 'gold'], requester_domains: ['acme.com'] }, lookups)).toBe(
      'Applies to tickets from Email or Chat, in group Billing, tagged vip or gold, requested by anyone at acme.com.'
    );
    expect(summarizeConditions({ group_ids: ['gone'] }, lookups)).toContain('a deleted group');
  });

  it('lists targets most urgent first and skips priorities without any', () => {
    const lines = summarizeTargets({ normal: { resolution: 1440 }, urgent: { first_reply: 15, next_reply: 30, resolution: 240 } });
    expect(lines).toEqual([
      'Urgent: first reply within 15 min, next reply within 30 min, resolved within 4 h.',
      'Normal: resolved within 1 day.',
    ]);
  });

  it('describes alerts for each combination', () => {
    expect(summarizeAlerts({ alert_before_minutes: 30, notify_assignee: true, notify_group: true })).toBe(
      "Emails the assignee and the ticket's group 30 min before a target is missed, and again when it is."
    );
    expect(summarizeAlerts({ alert_before_minutes: 0, notify_assignee: true, notify_group: false })).toBe('Emails the assignee when a target is missed.');
    expect(summarizeAlerts({ alert_before_minutes: 15, notify_assignee: false, notify_group: false })).toMatch(/Nobody is emailed/);
  });

  it('says how the clock runs', () => {
    expect(summarizePolicy(draft({ business_hours: true }), lookups).join(' ')).toMatch(/business hours only.*Pending or On-hold/);
    expect(summarizePolicy(draft({ business_hours: false }), lookups).join(' ')).toMatch(/every hour of the day/);
  });
});

describe('remaining time', () => {
  it('formats compactly and never shows 0m while time is left', () => {
    expect(formatRemaining(30_000)).toBe('1m');
    expect(formatRemaining(0)).toBe('<1m');
    expect(formatRemaining(45 * 60_000)).toBe('45m');
    expect(formatRemaining(2 * 3_600_000)).toBe('2h');
    expect(formatRemaining(5 * 3_600_000 + 5 * 60_000)).toBe('5h 5m');
    expect(formatRemaining((3 * 24 + 4) * 3_600_000)).toBe('3d 4h');
  });
});

describe('the SLA badge', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

  it('shows nothing for a ticket without an SLA', () => {
    expect(slaBadge({ sla_state: null }, now)).toBeNull();
    expect(slaBadge({}, now)).toBeNull();
  });

  it('counts down in neutral, then amber from the warning point', () => {
    const base = { sla_state: 'running' as const, sla_next_metric: 'first_reply' as const, sla_next_due_at: at(90), sla_next_warn_at: at(60) };
    expect(slaBadge(base, now)).toMatchObject({ tone: 'neutral', label: '1h 30m', breached: false });
    expect(slaBadge(base, new Date(now.getTime() + 60 * 60_000))).toMatchObject({ tone: 'warn', label: '30m' });
    expect(slaBadge(base, new Date(now.getTime() + 60 * 60_000))!.detail).toMatch(/First reply due in 30m \(close to breach\)/);
  });

  it('stays neutral until due when the policy has no warning', () => {
    expect(slaBadge({ sla_state: 'running', sla_next_due_at: at(5), sla_next_warn_at: null }, now)).toMatchObject({ tone: 'neutral', label: '5m' });
  });

  it('turns red the moment the due time arrives', () => {
    expect(slaBadge({ sla_state: 'running', sla_next_metric: 'resolution', sla_next_due_at: at(0) }, now)).toMatchObject({ tone: 'danger', breached: true });
    const late = slaBadge({ sla_state: 'running', sla_next_metric: 'resolution', sla_next_due_at: at(-135) }, now)!;
    expect(late).toMatchObject({ tone: 'danger', label: 'Breached 2h 15m ago', breached: true });
    expect(late.detail).toBe('Resolution target breached 2h 15m ago.');
  });

  it('uses the recorded breach time when there is one', () => {
    expect(slaBadge({ sla_state: 'running', sla_next_due_at: at(500), sla_breached_at: at(-60) }, now)).toMatchObject({ tone: 'danger', label: 'Breached 1h ago' });
  });

  it('shows paused tickets as paused, unless they already breached', () => {
    expect(slaBadge({ sla_state: 'paused' }, now)).toMatchObject({ tone: 'neutral', label: 'SLA paused' });
    expect(slaBadge({ sla_state: 'paused', sla_breached_at: at(-10) }, now)).toMatchObject({ tone: 'danger', label: 'Breached' });
  });

  it('shows met when every target was met', () => {
    expect(slaBadge({ sla_state: 'met' }, now)).toMatchObject({ tone: 'success', label: 'SLA met' });
  });
});

describe('holiday validation', () => {
  const ok = { name: 'Eid', starts_on: '2026-03-20', ends_on: '2026-03-22', repeats_yearly: false };

  it('accepts a normal holiday and a one-day one', () => {
    expect(holidayError(ok)).toBeNull();
    expect(holidayError({ ...ok, ends_on: ok.starts_on })).toBeNull();
  });

  it('rejects missing names, bad dates and reversed ranges', () => {
    expect(holidayError({ ...ok, name: ' ' })).toMatch(/name/);
    expect(holidayError({ ...ok, starts_on: '' })).toMatch(/start and end/);
    expect(holidayError({ ...ok, starts_on: '2026-02-31', ends_on: '2026-03-01' })).toMatch(/valid date|before/);
    expect(holidayError({ ...ok, ends_on: '2026-03-19' })).toMatch(/before the start/);
  });

  it('caps a closure at 61 days and keeps yearly ones inside a year', () => {
    expect(holidayError({ ...ok, starts_on: '2026-01-01', ends_on: '2026-03-02' })).toBeNull();
    expect(holidayError({ ...ok, starts_on: '2026-01-01', ends_on: '2026-03-03' })).toMatch(/at most 61 days/);
    expect(holidayError({ ...ok, starts_on: '2026-12-30', ends_on: '2027-01-02', repeats_yearly: true })).toMatch(/inside one year/);
    expect(holidayError({ ...ok, starts_on: '2026-12-30', ends_on: '2027-01-02' })).toBeNull();
  });
});
