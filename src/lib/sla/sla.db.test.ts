/**
 * SLA timers against a real Postgres: the working-time maths (pauses,
 * business hours, holidays, timezones, DST), policy matching, the timer
 * lifecycle, breach/warning events, alerts, rule conditions and access.
 * Run with `npm run test:db`.
 *
 * Time is controlled with the `zentry.sla_now` setting, which every SLA
 * function reads instead of now(); ticket timestamps are inserted explicitly.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createVisitor, createWorkspace, hasDatabase, startChat, agentSays, ticketOf, useTestDatabase, type WorkspaceFixture } from '@/test/db';

const MON_FRI = {
  enabled: true,
  timezone: 'UTC',
  schedule: Object.fromEntries(
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [
      d,
      { enabled: !['saturday', 'sunday'].includes(d), start: '09:00', end: '17:00' },
    ])
  ),
};

type Targets = Record<string, Record<string, number>>;
const SAME = (first: number, next: number, resolution: number): Targets =>
  Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((p) => [p, { first_reply: first, next_reply: next, resolution }]));

// 2026-10-09 is a Friday, 2026-10-12 a Monday.
const iso = (s: string) => new Date(s).toISOString();

describe.skipIf(!hasDatabase)('SLA policies (database)', () => {
  const { db } = useTestDatabase();

  // The SLA trigger swallows its own errors (a ticket write must never fail
  // because of SLA bookkeeping) and logs a warning instead. Tests treat any
  // such warning as a failure, so a broken sync cannot hide behind a pass.
  const warnings: string[] = [];
  beforeAll(() => {
    db().client.on('notice', (n) => {
      if (n.message?.startsWith('[SLA]')) warnings.push(n.message);
    });
  });
  afterEach(() => {
    const seen = warnings.splice(0);
    expect(seen).toEqual([]);
  });

  const setNow = (when: string) => db().q(`SELECT set_config('zentry.sla_now', $1, true)`, [when]);
  const setHours = (ws: WorkspaceFixture, cfg: unknown, timezone?: string) =>
    db().q('UPDATE workspaces SET business_hours = $2::jsonb, timezone = $3 WHERE id = $1', [ws.id, JSON.stringify(cfg), timezone ?? null]);

  async function walk(ws: WorkspaceFixture, start: string, business: boolean, minutes: number, ticketId: string | null = null) {
    const [r] = await db().q<{ due_at: Date | null }>(
      'SELECT due_at FROM fn_sla_walk($1, $2, $3, $4, $5, NULL)',
      [ws.id, ticketId, start, business, minutes * 60]
    );
    return r.due_at ? r.due_at.toISOString() : null;
  }
  async function worked(ws: WorkspaceFixture, start: string, until: string, business: boolean) {
    const [r] = await db().q<{ worked_seconds: string }>('SELECT worked_seconds FROM fn_sla_walk($1, NULL, $2, $3, 0, $4)', [ws.id, start, business, until]);
    return Number(r.worked_seconds) / 60;
  }

  async function policy(
    ws: WorkspaceFixture,
    name: string,
    targets: Targets,
    opts: { business?: boolean; position?: number; active?: boolean; conditions?: unknown; alert?: number } = {}
  ) {
    const [p] = await db().q<{ id: string }>(
      `INSERT INTO sla_policies (workspace_id, name, targets, business_hours, position, is_active, conditions, alert_before_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [ws.id, name, JSON.stringify(targets), opts.business ?? false, opts.position ?? 0, opts.active ?? true, JSON.stringify(opts.conditions ?? {}), opts.alert ?? 30]
    );
    return p.id;
  }

  async function newTicket(ws: WorkspaceFixture, createdAt: string, over: { priority?: string; tags?: string[]; assignee?: string; group?: string; channel?: string; requester?: string } = {}) {
    await setNow(createdAt);
    const [t] = await db().q<{ id: string }>(
      `INSERT INTO tickets (workspace_id, subject, created_at, priority, tags, assignee_id, group_id, channel, requester_id)
       VALUES ($1, 'Help', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [ws.id, createdAt, over.priority ?? 'normal', over.tags ?? [], over.assignee ?? null, over.group ?? null, over.channel ?? 'chat', over.requester ?? ws.visitorId]
    );
    return t.id;
  }

  const timers = (ticketId: string) =>
    db().q<{ metric: string; status: string; due_at: Date | null; breached_at: Date | null; met_at: Date | null; started_at: Date; target_minutes: number }>(
      'SELECT * FROM ticket_sla_timers WHERE ticket_id = $1 ORDER BY metric',
      [ticketId]
    );
  const timer = async (ticketId: string, metric: string) => (await timers(ticketId)).find((t) => t.metric === metric);
  const events = (ticketId: string) =>
    db().q<{ metric: string; event: string; occurred_at: Date; late: boolean; superseded_at: Date | null; policy_name: string }>(
      'SELECT * FROM sla_events WHERE ticket_id = $1 ORDER BY id',
      [ticketId]
    );
  const live = async (ticketId: string) => (await events(ticketId)).filter((e) => !e.superseded_at);
  const at = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  describe('working-time maths', () => {
    it('counts calendar time and skips paused periods', async () => {
      const ws = await createWorkspace(db());
      expect(await walk(ws, iso('2026-10-12T10:00:00Z'), false, 90)).toBe('2026-10-12T11:30:00.000Z');

      const tid = await newTicket(ws, '2026-10-12T10:00:00Z');
      await db().q(`INSERT INTO ticket_sla_pauses (workspace_id, ticket_id, paused_at, resumed_at, reason) VALUES ($1, $2, $3, $4, 'pending')`, [
        ws.id, tid, '2026-10-12T10:30:00Z', '2026-10-12T11:00:00Z',
      ]);
      // 30 minutes paused: 90 minutes of work now ends at 12:00, not 11:30.
      expect(await walk(ws, iso('2026-10-12T10:00:00Z'), false, 90, tid)).toBe('2026-10-12T12:00:00.000Z');
      expect(await worked(ws, iso('2026-10-12T10:00:00Z'), iso('2026-10-12T12:00:00Z'), false)).toBe(120); // no ticket: pauses not applied
    });

    it('has no due time while a pause is still open, but keeps one reached before it', async () => {
      const ws = await createWorkspace(db());
      const tid = await newTicket(ws, '2026-10-12T10:00:00Z');
      await db().q(`INSERT INTO ticket_sla_pauses (workspace_id, ticket_id, paused_at, reason) VALUES ($1, $2, '2026-10-12T10:30:00Z', 'pending')`, [ws.id, tid]);
      expect(await walk(ws, iso('2026-10-12T10:00:00Z'), false, 90, tid)).toBeNull();
      expect(await walk(ws, iso('2026-10-12T10:00:00Z'), false, 20, tid)).toBe('2026-10-12T10:20:00.000Z');
    });

    it('business hours: runs over the weekend and starts at opening time', async () => {
      const ws = await createWorkspace(db());
      await setHours(ws, MON_FRI);
      // Fri 16:00 + 2h: one hour Friday, one hour Monday morning.
      expect(await walk(ws, iso('2026-10-09T16:00:00Z'), true, 120)).toBe('2026-10-12T10:00:00.000Z');
      // Saturday noon starts counting Monday 09:00.
      expect(await walk(ws, iso('2026-10-10T12:00:00Z'), true, 30)).toBe('2026-10-12T09:30:00.000Z');
      // Before opening on a weekday.
      expect(await walk(ws, iso('2026-10-12T06:00:00Z'), true, 30)).toBe('2026-10-12T09:30:00.000Z');
      // Exactly at closing time: nothing left today.
      expect(await walk(ws, iso('2026-10-12T17:00:00Z'), true, 15)).toBe('2026-10-13T09:15:00.000Z');
      // A full-day target lands exactly at closing.
      expect(await walk(ws, iso('2026-10-12T09:00:00Z'), true, 480)).toBe('2026-10-12T17:00:00.000Z');
      expect(await worked(ws, iso('2026-10-09T16:00:00Z'), iso('2026-10-12T10:00:00Z'), true)).toBe(120);
    });

    it('falls back to calendar time when the workspace has not enabled business hours', async () => {
      const ws = await createWorkspace(db());
      await setHours(ws, { ...MON_FRI, enabled: false });
      expect(await walk(ws, iso('2026-10-10T12:00:00Z'), true, 30)).toBe('2026-10-10T12:30:00.000Z');
    });

    it('business hours: pauses across a weekend', async () => {
      const ws = await createWorkspace(db());
      await setHours(ws, MON_FRI);
      const tid = await newTicket(ws, '2026-10-09T16:00:00Z');
      await db().q(`INSERT INTO ticket_sla_pauses (workspace_id, ticket_id, paused_at, resumed_at, reason) VALUES ($1, $2, $3, $4, 'on_hold')`, [
        ws.id, tid, '2026-10-09T16:30:00Z', '2026-10-12T09:30:00Z',
      ]);
      // 30 minutes Friday, then 90 more after Monday 09:30.
      expect(await walk(ws, iso('2026-10-09T16:00:00Z'), true, 120, tid)).toBe('2026-10-12T11:00:00.000Z');
    });

    it('skips holidays, including ranges and yearly repeats', async () => {
      const ws = await createWorkspace(db());
      await setHours(ws, MON_FRI);
      await db().q(`INSERT INTO workspace_holidays (workspace_id, name, starts_on, ends_on) VALUES ($1, 'Founders day', '2026-10-12', '2026-10-12')`, [ws.id]);
      expect(await walk(ws, iso('2026-10-09T16:00:00Z'), true, 120)).toBe('2026-10-13T10:00:00.000Z');

      await db().q(`INSERT INTO workspace_holidays (workspace_id, name, starts_on, ends_on) VALUES ($1, 'Offsite', '2026-10-13', '2026-10-14')`, [ws.id]);
      expect(await walk(ws, iso('2026-10-09T16:00:00Z'), true, 120)).toBe('2026-10-15T10:00:00.000Z');

      // A holiday that repeats yearly, entered for an earlier year.
      const ws2 = await createWorkspace(db());
      await setHours(ws2, MON_FRI);
      await db().q(`INSERT INTO workspace_holidays (workspace_id, name, starts_on, ends_on, repeats_yearly) VALUES ($1, 'Founders day', '2020-10-12', '2020-10-12', true)`, [ws2.id]);
      expect(await walk(ws2, iso('2026-10-09T16:00:00Z'), true, 120)).toBe('2026-10-13T10:00:00.000Z');
    });

    it('holidays only apply to their own workspace and to business-hour policies', async () => {
      const a = await createWorkspace(db());
      const b = await createWorkspace(db());
      await setHours(a, MON_FRI);
      await setHours(b, MON_FRI);
      await db().q(`INSERT INTO workspace_holidays (workspace_id, name, starts_on, ends_on) VALUES ($1, 'Closed', '2026-10-12', '2026-10-12')`, [a.id]);
      expect(await walk(b, iso('2026-10-09T16:00:00Z'), true, 120)).toBe('2026-10-12T10:00:00.000Z');
      expect(await walk(a, iso('2026-10-11T23:00:00Z'), false, 120)).toBe('2026-10-12T01:00:00.000Z');
    });

    it('uses the calendar timezone: a Friday-night UTC ticket is Saturday in Karachi', async () => {
      const ws = await createWorkspace(db());
      await setHours(ws, { ...MON_FRI, timezone: 'Asia/Karachi' });
      // Fri 23:30Z = Sat 04:30 PKT: closed, so counting starts Monday 09:00 PKT = 04:00Z.
      expect(await walk(ws, iso('2026-10-09T23:30:00Z'), true, 60)).toBe('2026-10-12T05:00:00.000Z');
      // Thu 11:30Z = 16:30 PKT: 30 minutes Thursday, 30 more Friday 09:00 PKT = 04:00Z.
      expect(await walk(ws, iso('2026-10-08T11:30:00Z'), true, 60)).toBe('2026-10-09T04:30:00.000Z');
    });

    it('decides the local date in the calendar timezone, not in UTC', async () => {
      const ws = await createWorkspace(db());
      await setHours(ws, { ...MON_FRI, timezone: 'America/Los_Angeles' });
      // Sat 03:00Z is still Friday 20:00 in Los Angeles (closed); Monday opens 09:00 PDT = 16:00Z.
      expect(await walk(ws, iso('2026-10-10T03:00:00Z'), true, 30)).toBe('2026-10-12T16:30:00.000Z');
      // A holiday is a local date too: Monday the 12th in LA.
      await db().q(`INSERT INTO workspace_holidays (workspace_id, name, starts_on, ends_on) VALUES ($1, 'Closed', '2026-10-12', '2026-10-12')`, [ws.id]);
      expect(await walk(ws, iso('2026-10-10T03:00:00Z'), true, 30)).toBe('2026-10-13T16:30:00.000Z');
    });

    it('handles daylight saving: the spring day is an hour short, the autumn day an hour long', async () => {
      const ws = await createWorkspace(db());
      const sunday = { start: '01:00', end: '05:00' };
      await setHours(ws, { ...MON_FRI, timezone: 'America/New_York', schedule: { ...MON_FRI.schedule, sunday: { enabled: true, ...sunday } } });
      // 2026-03-08: clocks jump 02:00 -> 03:00, so 01:00-05:00 is only 3 real hours (06:00Z-09:00Z).
      expect(await walk(ws, iso('2026-03-08T06:00:00Z'), true, 180)).toBe('2026-03-08T09:00:00.000Z');
      // A fourth hour spills to the next open day: Mon 09:00 EDT = 13:00Z, so 10:00 EDT = 14:00Z.
      expect(await walk(ws, iso('2026-03-08T06:00:00Z'), true, 240)).toBe('2026-03-09T14:00:00.000Z');

      await setHours(ws, {
        ...MON_FRI,
        timezone: 'America/New_York',
        schedule: { ...MON_FRI.schedule, sunday: { enabled: true, start: '00:00', end: '04:00' } },
      });
      // 2026-11-01: clocks fall back, so 00:00-04:00 is 5 real hours (04:00Z-09:00Z).
      expect(await walk(ws, iso('2026-11-01T04:00:00Z'), true, 300)).toBe('2026-11-01T09:00:00.000Z');
    });

    it('ignores days with a broken schedule instead of failing', async () => {
      const ws = await createWorkspace(db());
      await setHours(ws, { ...MON_FRI, timezone: 'Not/AZone', schedule: { ...MON_FRI.schedule, monday: { enabled: true, start: 'soon', end: 'later' } } });
      // Unknown timezone -> UTC; Monday is unusable, so Tuesday opens.
      expect(await walk(ws, iso('2026-10-12T08:00:00Z'), true, 30)).toBe('2026-10-13T09:30:00.000Z');
    });
  });

  describe('matching', () => {
    it('the first matching active policy applies, in order', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Everyone', SAME(120, 120, 600), { position: 2 });
      const vip = await policy(ws, 'VIP', SAME(15, 15, 60), { position: 1, conditions: { tags: ['vip'] } });
      await policy(ws, 'Disabled', SAME(1, 1, 1), { position: 0, active: false });

      const plain = await newTicket(ws, '2026-10-12T10:00:00Z');
      expect((await timer(plain, 'first_reply'))!.target_minutes).toBe(120);
      const tagged = await newTicket(ws, '2026-10-12T10:00:00Z', { tags: ['VIP'] });
      expect((await timer(tagged, 'first_reply'))!.target_minutes).toBe(15);
      expect((await live(tagged)).length).toBe(0);
      expect((await db().q<{ sla_policy_id: string }>('SELECT sla_policy_id FROM tickets WHERE id = $1', [tagged]))[0].sla_policy_id).toBe(vip);
    });

    it('matches on channel, group and requester', async () => {
      const ws = await createWorkspace(db());
      const [g] = await db().q<{ id: string }>(`INSERT INTO ticket_groups (workspace_id, name) VALUES ($1, 'Billing') RETURNING id`, [ws.id]);
      const acme = await createVisitor(db(), ws.id, 'Ann', 'ann@acme.com');
      await policy(ws, 'Acme', SAME(10, 10, 60), { position: 0, conditions: { requester_domains: ['ACME.com'] } });
      await policy(ws, 'Billing email', SAME(20, 20, 60), { position: 1, conditions: { channels: ['email'], group_ids: [g.id] } });
      await policy(ws, 'Default', SAME(30, 30, 60), { position: 2 });

      const t1 = await newTicket(ws, '2026-10-12T10:00:00Z', { requester: acme });
      expect((await timer(t1, 'first_reply'))!.target_minutes).toBe(10);
      const t2 = await newTicket(ws, '2026-10-12T10:00:00Z', { channel: 'email', group: g.id });
      expect((await timer(t2, 'first_reply'))!.target_minutes).toBe(20);
      // Right group, wrong channel: every dimension has to match.
      const t3 = await newTicket(ws, '2026-10-12T10:00:00Z', { channel: 'chat', group: g.id });
      expect((await timer(t3, 'first_reply'))!.target_minutes).toBe(30);
    });

    it('re-matches when the group or tags change', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'VIP', SAME(15, 15, 60), { position: 0, conditions: { tags: ['vip'] } });
      await policy(ws, 'Default', SAME(60, 60, 600), { position: 1 });
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      expect((await timer(t, 'first_reply'))!.target_minutes).toBe(60);
      await setNow('2026-10-12T10:05:00Z');
      await db().q(`UPDATE tickets SET tags = ARRAY['vip'] WHERE id = $1`, [t]);
      const r = (await timer(t, 'first_reply'))!;
      expect(r.target_minutes).toBe(15);
      expect(at(r.due_at)).toBe('2026-10-12T10:15:00.000Z');
    });

    it('cancels timers when no policy applies any more', async () => {
      const ws = await createWorkspace(db());
      const p = await policy(ws, 'All', SAME(30, 30, 60));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      expect((await timer(t, 'resolution'))!.status).toBe('running');
      await db().q('UPDATE sla_policies SET is_active = false WHERE id = $1', [p]);
      await db().q('SELECT fn_sla_reapply_workspace($1)', [ws.id]);
      expect((await timers(t)).every((x) => x.status === 'cancelled')).toBe(true);
      const row = (await db().q<{ sla_state: string | null; sla_next_due_at: Date | null }>('SELECT sla_state, sla_next_due_at FROM tickets WHERE id = $1', [t]))[0];
      expect(row.sla_state).toBeNull();
      expect(row.sla_next_due_at).toBeNull();
    });
  });

  describe('timer lifecycle', () => {
    it('starts first-reply and resolution timers on creation and caches the earliest due time', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 240));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      expect(at((await timer(t, 'first_reply'))!.due_at)).toBe('2026-10-12T10:30:00.000Z');
      expect(at((await timer(t, 'resolution'))!.due_at)).toBe('2026-10-12T14:00:00.000Z');
      expect(await timer(t, 'next_reply')).toBeUndefined();
      const [row] = await db().q<{ sla_state: string; sla_next_due_at: Date; sla_next_metric: string }>('SELECT * FROM tickets WHERE id = $1', [t]);
      expect(row.sla_state).toBe('running');
      expect(at(row.sla_next_due_at)).toBe('2026-10-12T10:30:00.000Z');
      expect(row.sla_next_metric).toBe('first_reply');
    });

    it('a cache refresh is not an edit: updated_at and the audit trail stay put', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 240));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      const before = (await db().q<{ updated_at: Date }>('SELECT updated_at FROM tickets WHERE id = $1', [t]))[0].updated_at;
      await setNow('2026-10-12T11:00:00Z'); // the tick now records a breach and refreshes the cache
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      expect((await db().q('SELECT 1 FROM tickets WHERE id = $1 AND sla_breached_at IS NOT NULL', [t])).length).toBe(1);
      const after = (await db().q<{ updated_at: Date }>('SELECT updated_at FROM tickets WHERE id = $1', [t]))[0].updated_at;
      expect(at(after)).toBe(at(before));
    });

    it('a first reply on time is met; one after the due time is a breach then a late met', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 240));
      const onTime = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T10:20:00Z');
      await db().q(`UPDATE tickets SET first_agent_reply_at = $2, last_agent_reply_at = $2 WHERE id = $1`, [onTime, '2026-10-12T10:20:00Z']);
      expect((await timer(onTime, 'first_reply'))!.status).toBe('met');
      expect((await live(onTime)).map((e) => [e.metric, e.event, e.late])).toEqual([['first_reply', 'met', false]]);

      const late = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T10:50:00Z');
      await db().q(`UPDATE tickets SET first_agent_reply_at = $2, last_agent_reply_at = $2 WHERE id = $1`, [late, '2026-10-12T10:50:00Z']);
      const evs = await live(late);
      expect(evs.map((e) => [e.event, e.late])).toEqual([['breached', false], ['met', true]]);
      // The breach carries the moment it happened, not when it was noticed.
      expect(at(evs[0].occurred_at)).toBe('2026-10-12T10:30:00.000Z');
      expect(at(evs[1].occurred_at)).toBe('2026-10-12T10:50:00.000Z');
    });

    it('replying exactly at the due time is on time', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 240));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T10:30:00Z');
      await db().q(`UPDATE tickets SET first_agent_reply_at = $2, last_agent_reply_at = $2 WHERE id = $1`, [t, '2026-10-12T10:30:00Z']);
      expect((await live(t)).map((e) => [e.event, e.late])).toEqual([['met', false]]);
    });

    it('pending and on-hold pause every timer, and resuming moves the due time by the pause', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 120));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T10:10:00Z');
      await db().q(`UPDATE tickets SET status = 'pending' WHERE id = $1`, [t]);
      const paused = await timers(t);
      expect(paused.map((x) => x.status)).toEqual(['paused', 'paused']);
      expect(paused.every((x) => x.due_at === null)).toBe(true);
      expect((await db().q<{ sla_state: string; sla_next_due_at: Date | null }>('SELECT sla_state, sla_next_due_at FROM tickets WHERE id = $1', [t]))[0]).toMatchObject({ sla_state: 'paused', sla_next_due_at: null });

      // pending -> on_hold keeps one continuous pause.
      await setNow('2026-10-12T10:40:00Z');
      await db().q(`UPDATE tickets SET status = 'on_hold' WHERE id = $1`, [t]);
      expect((await db().q('SELECT 1 FROM ticket_sla_pauses WHERE ticket_id = $1', [t])).length).toBe(1);

      // 50 minutes paused (10:10 -> 11:00).
      await setNow('2026-10-12T11:00:00Z');
      await db().q(`UPDATE tickets SET status = 'open' WHERE id = $1`, [t]);
      expect(at((await timer(t, 'first_reply'))!.due_at)).toBe('2026-10-12T11:20:00.000Z');
      expect(at((await timer(t, 'resolution'))!.due_at)).toBe('2026-10-12T12:50:00.000Z');
      expect((await timer(t, 'first_reply'))!.status).toBe('running');
    });

    it('a paused ticket does not breach however long it waits', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 120));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T10:10:00Z');
      await db().q(`UPDATE tickets SET status = 'pending' WHERE id = $1`, [t]);
      await setNow('2026-10-20T10:00:00Z');
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      expect(await live(t)).toEqual([]);
    });

    it('a breach noticed late is still recorded at the due time, even if the ticket paused meanwhile', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 120));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      // The cron never ran; at 11:00 someone sets the ticket pending.
      await setNow('2026-10-12T11:00:00Z');
      await db().q(`UPDATE tickets SET status = 'pending' WHERE id = $1`, [t]);
      const evs = await live(t);
      expect(evs.map((e) => [e.metric, e.event, at(e.occurred_at)])).toEqual([['first_reply', 'breached', '2026-10-12T10:30:00.000Z']]);
    });

    it('recalculates when the priority changes, and retracts a breach the new target does not have', async () => {
      const ws = await createWorkspace(db());
      const targets: Targets = {
        low: { resolution: 960 },
        normal: { resolution: 480 },
        high: { resolution: 60 },
        urgent: { resolution: 30 },
      };
      await policy(ws, 'By priority', targets);
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      expect(at((await timer(t, 'resolution'))!.due_at)).toBe('2026-10-12T18:00:00.000Z');

      await setNow('2026-10-12T10:30:00Z');
      await db().q(`UPDATE tickets SET priority = 'high' WHERE id = $1`, [t]);
      expect(at((await timer(t, 'resolution'))!.due_at)).toBe('2026-10-12T11:00:00.000Z');

      await setNow('2026-10-12T12:00:00Z');
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      expect((await live(t)).map((e) => [e.event, at(e.occurred_at)])).toEqual([['breached', '2026-10-12T11:00:00.000Z']]);
      expect((await db().q<{ sla_breached_at: Date }>('SELECT sla_breached_at FROM tickets WHERE id = $1', [t]))[0].sla_breached_at).not.toBeNull();

      // Dropped back to normal: due 18:00, so the 11:00 breach never happened.
      await db().q(`UPDATE tickets SET priority = 'normal' WHERE id = $1`, [t]);
      expect(await live(t)).toEqual([]);
      expect((await events(t)).map((e) => e.event)).toEqual(['breached']); // kept for audit, but superseded
      expect((await db().q<{ sla_breached_at: Date | null }>('SELECT sla_breached_at FROM tickets WHERE id = $1', [t]))[0].sla_breached_at).toBeNull();
    });

    it('a priority with no target for a metric stops tracking it', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Partial', { normal: { first_reply: 30, resolution: 120 }, high: { resolution: 60 } });
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      expect((await timer(t, 'first_reply'))!.status).toBe('running');
      await db().q(`UPDATE tickets SET priority = 'high' WHERE id = $1`, [t]);
      expect((await timer(t, 'first_reply'))!.status).toBe('cancelled');
      expect((await timer(t, 'resolution'))!.target_minutes).toBe(60);
      await db().q(`UPDATE tickets SET priority = 'normal' WHERE id = $1`, [t]);
      expect((await timer(t, 'first_reply'))!.status).toBe('running');
    });

    it('editing a policy and re-applying recalculates existing timers from their original start', async () => {
      const ws = await createWorkspace(db());
      const p = await policy(ws, 'Standard', SAME(30, 20, 120));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T10:05:00Z');
      await db().q(`UPDATE sla_policies SET targets = $2 WHERE id = $1`, [p, JSON.stringify(SAME(45, 20, 120))]);
      await db().q('SELECT fn_sla_reapply_workspace($1)', [ws.id]);
      expect(at((await timer(t, 'first_reply'))!.due_at)).toBe('2026-10-12T10:45:00.000Z');
    });

    it('a policy saved after a ticket exists starts counting from then, not from creation', async () => {
      const ws = await createWorkspace(db());
      const t = await newTicket(ws, '2026-10-12T08:00:00Z');
      expect(await timers(t)).toEqual([]);
      await policy(ws, 'New', SAME(30, 20, 120));
      await setNow('2026-10-12T10:00:00Z');
      await db().q('SELECT fn_sla_reapply_workspace($1)', [ws.id]);
      expect(at((await timer(t, 'first_reply'))!.due_at)).toBe('2026-10-12T10:30:00.000Z');
      expect(await live(t)).toEqual([]);
    });

    it('switching a policy to business hours recomputes in the workspace calendar', async () => {
      const ws = await createWorkspace(db());
      await setHours(ws, MON_FRI);
      const p = await policy(ws, 'Standard', SAME(120, 20, 600));
      const t = await newTicket(ws, '2026-10-09T16:00:00Z');
      expect(at((await timer(t, 'first_reply'))!.due_at)).toBe('2026-10-09T18:00:00.000Z');
      await db().q('UPDATE sla_policies SET business_hours = true WHERE id = $1', [p]);
      await db().q('SELECT fn_sla_reapply_workspace($1)', [ws.id]);
      expect(at((await timer(t, 'first_reply'))!.due_at)).toBe('2026-10-12T10:00:00.000Z');
    });

    it('starts a next-reply timer when the customer writes after a human reply, and re-arms for each round', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 600));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T10:10:00Z');
      await db().q(`UPDATE tickets SET first_agent_reply_at = $2, last_agent_reply_at = $2 WHERE id = $1`, [t, '2026-10-12T10:10:00Z']);
      expect(await timer(t, 'next_reply')).toBeUndefined();

      await setNow('2026-10-12T10:40:00Z');
      await db().q(`UPDATE tickets SET last_customer_reply_at = $2 WHERE id = $1`, [t, '2026-10-12T10:40:00Z']);
      expect(at((await timer(t, 'next_reply'))!.due_at)).toBe('2026-10-12T11:00:00.000Z');

      // A second customer line does not restart the clock.
      await setNow('2026-10-12T10:50:00Z');
      await db().q(`UPDATE tickets SET last_customer_reply_at = $2 WHERE id = $1`, [t, '2026-10-12T10:50:00Z']);
      expect(at((await timer(t, 'next_reply'))!.due_at)).toBe('2026-10-12T11:00:00.000Z');

      await setNow('2026-10-12T10:55:00Z');
      await db().q(`UPDATE tickets SET last_agent_reply_at = $2 WHERE id = $1`, [t, '2026-10-12T10:55:00Z']);
      expect((await timer(t, 'next_reply'))!.status).toBe('met');

      // Round two.
      await setNow('2026-10-12T12:00:00Z');
      await db().q(`UPDATE tickets SET last_customer_reply_at = $2 WHERE id = $1`, [t, '2026-10-12T12:00:00Z']);
      const again = (await timer(t, 'next_reply'))!;
      expect(again.status).toBe('running');
      expect(at(again.due_at)).toBe('2026-10-12T12:20:00.000Z');
      expect((await live(t)).filter((e) => e.metric === 'next_reply').map((e) => e.event)).toEqual(['met']);
    });

    it('solving meets the resolution timer and cancels reply timers; reopening re-arms it without charging the solved time', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 120));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T10:50:00Z');
      await db().q(`UPDATE tickets SET status = 'solved' WHERE id = $1`, [t]);
      expect((await timer(t, 'resolution'))!.status).toBe('met');
      expect((await timer(t, 'first_reply'))!.status).toBe('cancelled');
      const first = (await live(t)).filter((e) => e.metric === 'resolution');
      expect(first.map((e) => [e.event, e.late])).toEqual([['met', false]]);
      expect((await db().q<{ sla_state: string }>('SELECT sla_state FROM tickets WHERE id = $1', [t]))[0].sla_state).toBe('met');

      // Solved for 2 hours, then reopened: the resolution clock resumes with 70 minutes left.
      await setNow('2026-10-12T12:50:00Z');
      await db().q(`UPDATE tickets SET status = 'open' WHERE id = $1`, [t]);
      const r = (await timer(t, 'resolution'))!;
      expect(r.status).toBe('running');
      expect(at(r.due_at)).toBe('2026-10-12T14:00:00.000Z');
      expect((await events(t)).filter((e) => e.metric === 'resolution').map((e) => [e.event, e.superseded_at !== null])).toEqual([['met', true]]);
    });

    it('a late resolution is a breach followed by a late met', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', { normal: { resolution: 60 } });
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T12:00:00Z');
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      await db().q(`UPDATE tickets SET status = 'solved' WHERE id = $1`, [t]);
      // (The solve time comes from the real clock, so only the breach's time is asserted.)
      const evs = await live(t);
      expect(evs.map((e) => [e.event, e.late])).toEqual([['breached', false], ['met', true]]);
      expect(at(evs[0].occurred_at)).toBe('2026-10-12T11:00:00.000Z');
    });

    it('closing and merging leave no live timers', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 120));
      const closed = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T10:20:00Z');
      await db().q(`UPDATE tickets SET status = 'closed' WHERE id = $1`, [closed]);
      expect((await timers(closed)).map((x) => x.status).sort()).toEqual(['cancelled', 'met']);

      // Merging needs real conversations (it leaves a system line in each).
      await db().q(`SELECT set_config('zentry.sla_now', '', true)`);
      const a = (await startChat(db(), ws, 'First')).ticket.id;
      const b = (await startChat(db(), ws, 'Second')).ticket.id;
      expect((await timer(b, 'resolution'))!.status).toBe('running');
      await db().as({ kind: 'user', id: ws.agentId }, 'SELECT fn_merge_tickets($1, ARRAY[$2]::uuid[])', [a, b]);
      expect((await timers(b)).every((x) => x.status === 'cancelled')).toBe(true);
      expect((await timer(a, 'resolution'))!.status).toBe('running');
    });

    it('is wired to real messages: a human reply meets the first-reply timer, a bot reply does not', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 600));
      await db().q(`SELECT set_config('zentry.sla_now', '', true)`);
      const { conversationId, ticket } = await startChat(db(), ws, 'Where is my order?');
      expect((await timer(ticket.id, 'first_reply'))!.status).toBe('running');
      await db().q(`INSERT INTO messages (conversation_id, sender_type, content) VALUES ($1, 'ai', 'Let me check')`, [conversationId]);
      expect((await timer(ticket.id, 'first_reply'))!.status).toBe('running');
      await agentSays(db(), conversationId, ws.agentId, 'On it');
      expect((await timer((await ticketOf(db(), conversationId)).id, 'first_reply'))!.status).toBe('met');
    });
  });

  describe('events, alerts and the cron tick', () => {
    it('records a breach once, however often the tick runs', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(30, 20, 600));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T11:00:00Z');
      const first = (await db().q<{ n: number }>('SELECT fn_sla_tick($1) AS n', [ws.id]))[0].n;
      const second = (await db().q<{ n: number }>('SELECT fn_sla_tick($1) AS n', [ws.id]))[0].n;
      expect(first).toBeGreaterThan(0);
      expect(second).toBe(0);
      const evs = await live(t);
      expect(evs.map((e) => [e.metric, e.event, e.policy_name])).toEqual([['first_reply', 'breached', 'Standard']]);
      expect((await timer(t, 'first_reply'))!.breached_at).not.toBeNull();
    });

    it('warns before the breach and emails the assignee and the group once', async () => {
      const ws = await createWorkspace(db());
      const [g] = await db().q<{ id: string }>(`INSERT INTO ticket_groups (workspace_id, name) VALUES ($1, 'Support') RETURNING id`, [ws.id]);
      const mate = await addMember(db(), ws.id, 'agent');
      const light = await addMember(db(), ws.id, 'light_agent');
      for (const a of [ws.agentId, mate, light]) {
        await db().q('INSERT INTO ticket_group_members (workspace_id, group_id, agent_id) VALUES ($1, $2, $3)', [ws.id, g.id, a]);
      }
      await policy(ws, 'Standard', SAME(120, 20, 600), { alert: 30 });
      const t = await newTicket(ws, '2026-10-12T10:00:00Z', { assignee: ws.agentId, group: g.id });

      await setNow('2026-10-12T11:00:00Z'); // 60 minutes left: too early
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      expect(await live(t)).toEqual([]);

      await setNow('2026-10-12T11:35:00Z'); // 25 minutes left
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      expect((await live(t)).map((e) => e.event)).toEqual(['warning']);
      const mails = await db().q<{ payload: { to: string; subject: string } }>(`SELECT payload FROM automation_outbox WHERE ticket_id = $1 AND kind = 'email_agent'`, [t]);
      // The assignee is also a group member and is mailed once; the light agent is not mailed.
      expect(mails.map((m) => m.payload.to).sort()).toEqual([`${ws.agentId}@example.test`, `${mate}@example.test`].sort());
      expect(mails[0].payload.subject).toContain('[SLA warning]');

      await setNow('2026-10-12T12:30:00Z');
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      const breach = await db().q<{ payload: { subject: string } }>(`SELECT payload FROM automation_outbox WHERE ticket_id = $1 AND payload->>'subject' LIKE '[SLA breached]%'`, [t]);
      expect(breach.length).toBe(2);
    });

    it('does not warn when the target is too short for an advance warning to make sense', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Tight', SAME(1, 1, 600), { alert: 30 });
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      expect((await timer(t, 'first_reply'))).toBeDefined();
      await setNow('2026-10-12T10:00:30Z');
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      expect(await live(t)).toEqual([]);
    });

    it('business-hours warnings count working time, not the clock', async () => {
      const ws = await createWorkspace(db());
      await setHours(ws, MON_FRI);
      await policy(ws, 'Business', SAME(120, 20, 600), { business: true, alert: 30 });
      // Fri 16:30 + 120 working minutes -> due Mon 10:30; warn 30 working minutes earlier -> Mon 10:00.
      const t = await newTicket(ws, '2026-10-09T16:30:00Z');
      expect(at((await timer(t, 'first_reply'))!.due_at)).toBe('2026-10-12T10:30:00.000Z');
      await setNow('2026-10-10T12:00:00Z'); // Saturday: by the wall clock the warning would be overdue
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      expect(await live(t)).toEqual([]);
      await setNow('2026-10-12T10:05:00Z');
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      expect((await live(t)).map((e) => e.event)).toEqual(['warning']);
    });
  });

  describe('rule conditions', () => {
    const cond = (ticketId: string, c: unknown) =>
      db()
        .one<{ ok: boolean }>('SELECT fn_rule_matches($2::jsonb, \'all\', t, NULL, \'{}\') AS ok FROM tickets t WHERE t.id = $1', [ticketId, JSON.stringify([c])])
        .then((r) => r.ok);

    it('exposes "SLA breached" and "hours until breach"', async () => {
      const ws = await createWorkspace(db());
      await policy(ws, 'Standard', SAME(120, 20, 600));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');

      await setNow('2026-10-12T11:00:00Z'); // one hour to the first-reply due time
      expect(await cond(t, { field: 'sla_breached', op: 'is', value: 'no' })).toBe(true);
      expect(await cond(t, { field: 'sla_breached', op: 'is', value: 'yes' })).toBe(false);
      expect(await cond(t, { field: 'hours_until_breach', op: 'lte', value: 1 })).toBe(true);
      expect(await cond(t, { field: 'hours_until_breach', op: 'lte', value: 0.5 })).toBe(false);
      expect(await cond(t, { field: 'hours_until_breach', op: 'gte', value: 2 })).toBe(false);

      // Live: true as soon as the due time passes, before any cron has run.
      await setNow('2026-10-12T12:30:00Z');
      expect(await cond(t, { field: 'sla_breached', op: 'is', value: 'yes' })).toBe(true);
      expect(await cond(t, { field: 'hours_until_breach', op: 'lte', value: 0 })).toBe(true);
    });

    it('a paused or untracked ticket has no hours until breach', async () => {
      const ws = await createWorkspace(db());
      const untracked = await newTicket(ws, '2026-10-12T10:00:00Z');
      expect(await cond(untracked, { field: 'hours_until_breach', op: 'lte', value: 1000 })).toBe(false);
      await policy(ws, 'Standard', SAME(120, 20, 600));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      await db().q(`UPDATE tickets SET status = 'pending' WHERE id = $1`, [t]);
      expect(await cond(t, { field: 'hours_until_breach', op: 'lte', value: 1000 })).toBe(false);
    });

    it('validates the new conditions and rejects nonsense', async () => {
      const ws = await createWorkspace(db());
      const base = (conditions: unknown) =>
        db().q(
          `INSERT INTO automation_rules (workspace_id, kind, name, match_mode, conditions, actions)
           VALUES ($1, 'trigger', 'x', 'all', $2, '[{"type":"add_tags","value":["late"]}]')`,
          [ws.id, JSON.stringify(conditions)]
        );
      await base([{ field: 'sla_breached', op: 'is', value: 'yes' }, { field: 'hours_until_breach', op: 'lte', value: -2 }]);
      await base([{ field: 'changed', op: 'is', value: 'sla_breach' }]);
      expect(await db().rejects({ kind: 'superuser' }, `INSERT INTO automation_rules (workspace_id, kind, name, match_mode, conditions, actions) VALUES ($1, 'trigger', 'x', 'all', '[{"field":"sla_breached","op":"is","value":"maybe"}]', '[{"type":"add_tags","value":["a"]}]')`, [ws.id])).toMatch(/yes or no/);
      expect(await db().rejects({ kind: 'superuser' }, `INSERT INTO automation_rules (workspace_id, kind, name, match_mode, conditions, actions) VALUES ($1, 'trigger', 'x', 'all', '[{"field":"hours_until_breach","op":"is","value":2}]', '[{"type":"add_tags","value":["a"]}]')`, [ws.id])).toMatch(/Hours until breach/);
    });

    it('a trigger can react at the moment of breach', async () => {
      const ws = await createWorkspace(db());
      await db().q('DELETE FROM automation_rules WHERE workspace_id = $1', [ws.id]);
      await db().q(
        `INSERT INTO automation_rules (workspace_id, kind, name, match_mode, conditions, actions)
         VALUES ($1, 'trigger', 'Escalate', 'all', $2, '[{"type":"add_tags","value":["sla-breached"]}]')`,
        [ws.id, JSON.stringify([{ field: 'changed', op: 'is', value: 'sla_breach' }, { field: 'sla_breached', op: 'is', value: 'yes' }])]
      );
      await policy(ws, 'Standard', SAME(30, 20, 600));
      const t = await newTicket(ws, '2026-10-12T10:00:00Z');
      await setNow('2026-10-12T11:00:00Z');
      await db().q('SELECT fn_sla_tick($1)', [ws.id]);
      expect((await db().q<{ tags: string[] }>('SELECT tags FROM tickets WHERE id = $1', [t]))[0].tags).toContain('sla-breached');
    });
  });

  describe('access', () => {
    it('only owners and admins write policies and holidays; every member reads; other workspaces see nothing', async () => {
      const a = await createWorkspace(db());
      const b = await createWorkspace(db());
      const asUser = (id: string) => ({ kind: 'user', id }) as const;
      const row = `INSERT INTO sla_policies (workspace_id, name, targets) VALUES ($1, 'P', '{"normal":{"resolution":60}}')`;

      await db().as(asUser(a.adminId), row, [a.id]);
      expect(await db().rejects(asUser(a.agentId), row, [a.id])).toMatch(/row-level security/);
      expect(await db().rejects(asUser(b.adminId), row, [a.id])).toMatch(/row-level security/);
      expect(await db().as(asUser(a.agentId), 'SELECT 1 FROM sla_policies')).toHaveLength(1);
      expect(await db().as(asUser(b.agentId), 'SELECT 1 FROM sla_policies')).toHaveLength(0);

      const holiday = `INSERT INTO workspace_holidays (workspace_id, name, starts_on, ends_on) VALUES ($1, 'H', '2026-12-25', '2026-12-25')`;
      await db().as(asUser(a.ownerId), holiday, [a.id]);
      expect(await db().rejects(asUser(a.agentId), holiday, [a.id])).toMatch(/row-level security/);
      expect(await db().as(asUser(b.adminId), 'SELECT 1 FROM workspace_holidays')).toHaveLength(0);

      const t = await newTicket(a, '2026-10-12T10:00:00Z');
      await policy(a, 'Standard', SAME(30, 20, 120));
      await db().q('SELECT fn_sla_sync($1)', [t]);
      expect((await db().as(asUser(a.agentId), 'SELECT 1 FROM ticket_sla_timers')).length).toBeGreaterThan(0);
      expect(await db().as(asUser(b.agentId), 'SELECT 1 FROM ticket_sla_timers')).toHaveLength(0);
      expect(await db().as(asUser(b.agentId), 'SELECT 1 FROM sla_events')).toHaveLength(0);
      // Nobody writes timers or events directly.
      expect(await db().as(asUser(a.adminId), `UPDATE ticket_sla_timers SET status = 'met' RETURNING 1`)).toHaveLength(0);
    });

    it('re-applying and reordering are admin-only and stay inside the workspace', async () => {
      const a = await createWorkspace(db());
      const b = await createWorkspace(db());
      const p1 = await policy(a, 'One', SAME(30, 20, 120), { position: 0 });
      const p2 = await policy(a, 'Two', SAME(30, 20, 120), { position: 1 });
      const asUser = (id: string) => ({ kind: 'user', id }) as const;
      expect(await db().rejects(asUser(a.agentId), 'SELECT fn_sla_reapply_workspace($1)', [a.id])).toMatch(/Forbidden/);
      expect(await db().rejects(asUser(b.adminId), 'SELECT fn_sla_reapply_workspace($1)', [a.id])).toMatch(/Forbidden/);
      await db().as(asUser(a.adminId), 'SELECT fn_sla_reorder_policies($1, $2::uuid[])', [a.id, [p2, p1]]);
      const order = await db().q<{ name: string }>('SELECT name FROM sla_policies WHERE workspace_id = $1 ORDER BY position', [a.id]);
      expect(order.map((r) => r.name)).toEqual(['Two', 'One']);
      // The cron tick is for the service role only.
      expect(await db().rejects(asUser(a.adminId), 'SELECT fn_sla_tick($1)', [a.id])).toMatch(/permission denied/);
    });

    it('rejects policies that could never work', async () => {
      const ws = await createWorkspace(db());
      const insert = (targets: unknown, conditions: unknown = {}) =>
        db().rejects({ kind: 'superuser' }, `INSERT INTO sla_policies (workspace_id, name, targets, conditions) VALUES ($1, 'P', $2, $3)`, [ws.id, JSON.stringify(targets), JSON.stringify(conditions)]);
      expect(await insert({})).toMatch(/at least one target/);
      expect(await insert({ normal: { resolution: 0 } })).toMatch(/between 1 and 43200/);
      expect(await insert({ normal: { resolution: 1.5 } })).toMatch(/whole number/);
      expect(await insert({ medium: { resolution: 10 } })).toMatch(/Unknown priority/);
      expect(await insert({ normal: { speed: 10 } })).toMatch(/Unknown target/);
      expect(await insert({ normal: { resolution: 10 } }, { colour: ['red'] })).toMatch(/Unknown condition/);
      expect(await insert({ normal: { resolution: 10 } }, { group_ids: ['nope'] })).toMatch(/Choose groups/);
    });
  });
});
