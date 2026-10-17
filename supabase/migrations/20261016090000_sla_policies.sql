-- SLA policies on top of tickets.
--
-- What this adds
--   * workspace_holidays: days the team is closed. Together with the existing
--     workspaces.business_hours (schedule + timezone, edited in Settings →
--     Workspace → Business hours) they form the calendar business-hour SLAs
--     count against. The hours setting is reused, not duplicated.
--   * sla_policies: ordered, per workspace. The first active policy whose
--     conditions (channel, group, tags, requester) match a ticket applies.
--     Targets are minutes per priority for first reply, next reply and
--     resolution.
--   * ticket_sla_timers / ticket_sla_pauses / sla_events: one timer per ticket
--     and metric, the ledger of paused periods, and an append-only record of
--     every met / breached / warning event for reporting.
--   * tickets.sla_*: a cache of the earliest due time, so views can sort by
--     next breach without joining.
--   * Rule conditions "SLA breached" and "Hours until breach", and the
--     "What just happened" values sla_breach / sla_warning.
--
-- Why it lives in the database
--   Like every other ticket rule, SLA timing has to hold for every writer: the
--   widget, the bot, channel webhooks, the inbox and the ticket screens. A due
--   time is a pure function of (start, target, calendar, pauses), so it is
--   recomputed from scratch on every relevant change (fn_sla_sync) instead of
--   being nudged incrementally. That makes "recalculate when priority or
--   policy changes" the same code path as everything else.
--
-- Rules of the engine
--   * Pending and on-hold pause every timer. Solved pauses too, so a reopened
--     ticket does not charge the resolution timer for the time it sat solved.
--   * First reply = first public reply from a person (bot replies don't
--     count). Next reply = a customer message that arrives after that and is
--     still unanswered. Resolution = until the ticket is solved.
--   * Business-hour policies count only the open hours of the workspace
--     calendar, in the calendar's timezone, minus holidays. If the workspace
--     has not switched business hours on, they count calendar time.
--   * A breach is recorded with the moment it happened (the due time), not the
--     moment a cron noticed it. Recalculating to a later due time retracts a
--     breach that, under the new target, never happened.
--   * SLA failures never block a ticket write: the trigger logs a warning.
--   * Policy ids on tickets/timers are plain columns, not foreign keys: a
--     cascading SET NULL would try to update closed tickets, which are
--     read-only.

-- ----------------------------------------------------------------------------
-- 1. Calendar: business hours (existing) and holidays
-- ----------------------------------------------------------------------------

ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS business_hours JSONB;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS timezone TEXT;

CREATE TABLE IF NOT EXISTS public.workspace_holidays (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name           TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  starts_on      DATE NOT NULL,
  ends_on        DATE NOT NULL,
  -- Repeats every year on the same month and day. A repeating holiday must
  -- sit inside one calendar year so "12-24 to 01-02" is two entries.
  repeats_yearly BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_holidays_range CHECK (ends_on >= starts_on AND ends_on - starts_on <= 60),
  CONSTRAINT workspace_holidays_yearly CHECK (
    NOT repeats_yearly OR extract(year FROM starts_on) = extract(year FROM ends_on))
);
CREATE INDEX IF NOT EXISTS workspace_holidays_ws ON public.workspace_holidays (workspace_id, starts_on);

ALTER TABLE public.workspace_holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_holidays_select ON public.workspace_holidays;
CREATE POLICY workspace_holidays_select ON public.workspace_holidays FOR SELECT TO authenticated
  USING (public.fn_workspace_role(workspace_id) IS NOT NULL);

DROP POLICY IF EXISTS workspace_holidays_write ON public.workspace_holidays;
CREATE POLICY workspace_holidays_write ON public.workspace_holidays FOR ALL TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'))
  WITH CHECK (public.fn_role_can(workspace_id, 'manage_settings'));

-- ----------------------------------------------------------------------------
-- 2. Policies
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sla_policies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description          TEXT NOT NULL DEFAULT '',
  position             INTEGER NOT NULL DEFAULT 0,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  -- {"channels":["email"],"group_ids":["<uuid>"],"tags":["vip"],
  --  "requester_emails":["a@b.com"],"requester_domains":["acme.com"]}
  -- Missing or empty = any. Every dimension given must match; inside one
  -- dimension any entry may match.
  conditions           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {"urgent":{"first_reply":15,"next_reply":30,"resolution":240}, ...} in
  -- minutes. A metric left out is not tracked for that priority.
  targets              JSONB NOT NULL DEFAULT '{}'::jsonb,
  business_hours       BOOLEAN NOT NULL DEFAULT false,
  -- Warn this many minutes of SLA time before a breach (0 = no warning).
  alert_before_minutes INTEGER NOT NULL DEFAULT 30 CHECK (alert_before_minutes BETWEEN 0 AND 1440),
  notify_assignee      BOOLEAN NOT NULL DEFAULT true,
  notify_group         BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sla_policies_ws ON public.sla_policies (workspace_id, position, created_at);

ALTER TABLE public.sla_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sla_policies_select ON public.sla_policies;
CREATE POLICY sla_policies_select ON public.sla_policies FOR SELECT TO authenticated
  USING (public.fn_workspace_role(workspace_id) IS NOT NULL);

DROP POLICY IF EXISTS sla_policies_write ON public.sla_policies;
CREATE POLICY sla_policies_write ON public.sla_policies FOR ALL TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'))
  WITH CHECK (public.fn_role_can(workspace_id, 'manage_settings'));

-- Rejects a policy that could never work, with a message the form can show.
CREATE OR REPLACE FUNCTION public.fn_sla_policy_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  k TEXT;
  prio TEXT;
  metric TEXT;
  v JSONB;
  n NUMERIC;
  v_any BOOLEAN := false;
  x JSONB;
BEGIN
  NEW.name := btrim(NEW.name);
  NEW.description := left(coalesce(NEW.description, ''), 500);
  NEW.updated_at := now();

  IF jsonb_typeof(NEW.conditions) <> 'object' THEN
    RAISE EXCEPTION 'Conditions must be an object.' USING ERRCODE = '22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(NEW.conditions) LOOP
    IF k NOT IN ('channels', 'group_ids', 'tags', 'requester_emails', 'requester_domains') THEN
      RAISE EXCEPTION 'Unknown condition: %.', k USING ERRCODE = '22023';
    END IF;
    v := NEW.conditions -> k;
    IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > 50 THEN
      RAISE EXCEPTION 'The % condition must be a list of at most 50 entries.', k USING ERRCODE = '22023';
    END IF;
    FOR x IN SELECT * FROM jsonb_array_elements(v) LOOP
      IF jsonb_typeof(x) <> 'string' OR char_length(x #>> '{}') NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'The % condition has an invalid entry.', k USING ERRCODE = '22023';
      END IF;
      IF k = 'group_ids' AND NOT (x #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Choose groups from the list.' USING ERRCODE = '22023';
      END IF;
      IF k = 'channels' AND NOT (x #>> '{}') ~ '^[a-z_]{2,20}$' THEN
        RAISE EXCEPTION 'Choose channels from the list.' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;

  IF jsonb_typeof(NEW.targets) <> 'object' THEN
    RAISE EXCEPTION 'Targets must be an object.' USING ERRCODE = '22023';
  END IF;
  FOR prio IN SELECT jsonb_object_keys(NEW.targets) LOOP
    IF prio NOT IN ('low', 'normal', 'high', 'urgent') THEN
      RAISE EXCEPTION 'Unknown priority: %.', prio USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(NEW.targets -> prio) <> 'object' THEN
      RAISE EXCEPTION 'Targets for % must be an object.', prio USING ERRCODE = '22023';
    END IF;
    FOR metric IN SELECT jsonb_object_keys(NEW.targets -> prio) LOOP
      IF metric NOT IN ('first_reply', 'next_reply', 'resolution') THEN
        RAISE EXCEPTION 'Unknown target: %.', metric USING ERRCODE = '22023';
      END IF;
      v := NEW.targets -> prio -> metric;
      IF v IS NULL OR jsonb_typeof(v) = 'null' THEN CONTINUE; END IF;
      IF jsonb_typeof(v) <> 'number' THEN
        RAISE EXCEPTION 'Targets are numbers of minutes.' USING ERRCODE = '22023';
      END IF;
      n := (v #>> '{}')::numeric;
      IF n <> trunc(n) OR n < 1 OR n > 43200 THEN
        RAISE EXCEPTION 'A target is a whole number of minutes between 1 and 43200 (30 days).' USING ERRCODE = '22023';
      END IF;
      v_any := true;
    END LOOP;
  END LOOP;
  IF NOT v_any THEN
    RAISE EXCEPTION 'Set at least one target.' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sla_policy_before_write ON public.sla_policies;
CREATE TRIGGER trg_sla_policy_before_write
  BEFORE INSERT OR UPDATE ON public.sla_policies
  FOR EACH ROW EXECUTE FUNCTION public.fn_sla_policy_before_write();

-- ----------------------------------------------------------------------------
-- 3. Timers, pauses and the event record
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ticket_sla_pauses (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id    UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  paused_at    TIMESTAMPTZ NOT NULL,
  resumed_at   TIMESTAMPTZ,
  reason       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_sla_pauses_ticket ON public.ticket_sla_pauses (ticket_id, paused_at);

CREATE TABLE IF NOT EXISTS public.ticket_sla_timers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id      UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  policy_id      UUID,
  metric         TEXT NOT NULL CHECK (metric IN ('first_reply', 'next_reply', 'resolution')),
  -- running: counting down. paused: ticket is pending/on-hold (no due time).
  -- met: the reply/solve happened. cancelled: the policy stopped applying.
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'met', 'cancelled')),
  target_minutes INTEGER NOT NULL,
  business_hours BOOLEAN NOT NULL DEFAULT false,
  started_at     TIMESTAMPTZ NOT NULL,
  due_at         TIMESTAMPTZ,
  warn_at        TIMESTAMPTZ,
  warned_at      TIMESTAMPTZ,
  breached_at    TIMESTAMPTZ,
  met_at         TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ticket_sla_timers_one_per_metric UNIQUE (ticket_id, metric)
);
CREATE INDEX IF NOT EXISTS ticket_sla_timers_due ON public.ticket_sla_timers (due_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS ticket_sla_timers_warn ON public.ticket_sla_timers (warn_at) WHERE status = 'running' AND warned_at IS NULL;
CREATE INDEX IF NOT EXISTS ticket_sla_timers_ws ON public.ticket_sla_timers (workspace_id, status);

-- Append-only. Policy name and the ticket's assignee/group/priority are
-- copied in because they change later and reports must show what was true
-- when the event happened.
CREATE TABLE IF NOT EXISTS public.sla_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id      UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  timer_id       UUID NOT NULL,
  policy_id      UUID,
  policy_name    TEXT NOT NULL DEFAULT '',
  metric         TEXT NOT NULL CHECK (metric IN ('first_reply', 'next_reply', 'resolution')),
  event          TEXT NOT NULL CHECK (event IN ('met', 'breached', 'warning')),
  priority       TEXT,
  assignee_id    UUID,
  group_id       UUID,
  target_minutes INTEGER NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  due_at         TIMESTAMPTZ,
  -- When it happened: the reply/solve time for met, the due time for
  -- breached, the time the warning went out for warning.
  occurred_at    TIMESTAMPTZ NOT NULL,
  -- A "met" that came after the breach.
  late           BOOLEAN NOT NULL DEFAULT false,
  -- Set when a recalculation or a reopen made this event stop being true.
  superseded_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sla_events_once ON public.sla_events (timer_id, started_at, event) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS sla_events_ws_time ON public.sla_events (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS sla_events_ticket ON public.sla_events (ticket_id, occurred_at);

ALTER TABLE public.ticket_sla_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_sla_timers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sla_events ENABLE ROW LEVEL SECURITY;

-- Members read; nobody writes directly. Only the functions below do.
DROP POLICY IF EXISTS ticket_sla_pauses_select ON public.ticket_sla_pauses;
CREATE POLICY ticket_sla_pauses_select ON public.ticket_sla_pauses FOR SELECT TO authenticated
  USING (public.fn_ticket_member(workspace_id));
DROP POLICY IF EXISTS ticket_sla_timers_select ON public.ticket_sla_timers;
CREATE POLICY ticket_sla_timers_select ON public.ticket_sla_timers FOR SELECT TO authenticated
  USING (public.fn_ticket_member(workspace_id));
DROP POLICY IF EXISTS sla_events_select ON public.sla_events;
CREATE POLICY sla_events_select ON public.sla_events FOR SELECT TO authenticated
  USING (public.fn_ticket_member(workspace_id));

-- ----------------------------------------------------------------------------
-- 4. Cache columns on tickets
-- ----------------------------------------------------------------------------

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS sla_policy_id UUID,
  ADD COLUMN IF NOT EXISTS sla_state TEXT,
  ADD COLUMN IF NOT EXISTS sla_next_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_next_metric TEXT,
  ADD COLUMN IF NOT EXISTS sla_next_warn_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ;
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_sla_state_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_sla_state_check CHECK (sla_state IN ('running', 'paused', 'met'));
CREATE INDEX IF NOT EXISTS tickets_sla_next_due ON public.tickets (workspace_id, sla_next_due_at) WHERE sla_next_due_at IS NOT NULL;

-- Keeping the cache fresh must not look like an edit: no updated_at bump, no
-- "ticket is closed" refusal, and nothing but the sla_* columns may change
-- ----------------------------------------------------------------------------
-- 5. Time and calendar maths
-- ----------------------------------------------------------------------------

-- "Now" for SLA maths. Tests set zentry.sla_now to move the clock; in
-- production the setting is empty and this is now().
CREATE OR REPLACE FUNCTION public.fn_sla_now()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(nullif(current_setting('zentry.sla_now', true), '')::timestamptz, now());
$$;

-- while the flag is on (the flag is only ever set around such a statement).
-- The generated rank columns are left out of the comparison: they are not
-- computed yet while a BEFORE trigger runs, so NEW holds stale values.
CREATE OR REPLACE FUNCTION public.fn_ticket_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_internal BOOLEAN := coalesce(current_setting('zentry.ticket_internal', true), '') = 'on';
BEGIN
  IF coalesce(current_setting('zentry.sla_internal', true), '') = 'on'
     AND (to_jsonb(NEW) - 'sla_policy_id' - 'sla_state' - 'sla_next_due_at' - 'sla_next_metric' - 'sla_next_warn_at' - 'sla_breached_at' - 'status_rank' - 'priority_rank')
       = (to_jsonb(OLD) - 'sla_policy_id' - 'sla_state' - 'sla_next_due_at' - 'sla_next_metric' - 'sla_next_warn_at' - 'sla_breached_at' - 'status_rank' - 'priority_rank') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'Ticket #% is closed and read-only. Reply to create a follow-up ticket.', OLD.number
      USING ERRCODE = '55000';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'A ticket''s workspace and number cannot change.' USING ERRCODE = '42501';
  END IF;
  IF NOT v_internal AND (
       NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.follow_up_of_id IS DISTINCT FROM OLD.follow_up_of_id
    OR NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'Use the merge or follow-up functions to relink tickets.' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'new' AND OLD.status <> 'new' THEN
    RAISE EXCEPTION 'A ticket cannot go back to New.' USING ERRCODE = '22023';
  END IF;
  -- Assigning a new ticket means someone has picked it up.
  IF NEW.status = 'new' AND NEW.assignee_id IS NOT NULL THEN
    NEW.status := 'open';
  END IF;

  NEW.subject := left(trim(coalesce(NEW.subject, '')), 250);
  NEW.tags := coalesce(NEW.tags, '{}');
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := public.fn_sla_now();
    IF NEW.status = 'solved' THEN
      NEW.solved_at := coalesce(NEW.solved_at, public.fn_sla_now());
    ELSIF NEW.status = 'closed' THEN
      NEW.solved_at := coalesce(OLD.solved_at, public.fn_sla_now());
      NEW.closed_at := public.fn_sla_now();
    ELSE
      -- Reopened: it is no longer "recently solved".
      NEW.solved_at := NULL;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- The calendar's timezone: business hours' own, else the workspace's, else
-- UTC. A name Postgres does not know falls back to UTC rather than failing
-- every ticket write.
CREATE OR REPLACE FUNCTION public.fn_sla_timezone(p_ws UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz TEXT;
BEGIN
  SELECT coalesce(nullif(w.business_hours ->> 'timezone', ''), nullif(w.timezone, ''), 'UTC')
    INTO v_tz FROM public.workspaces w WHERE w.id = p_ws;
  PERFORM now() AT TIME ZONE coalesce(v_tz, 'UTC');
  RETURN coalesce(v_tz, 'UTC');
EXCEPTION WHEN OTHERS THEN
  RETURN 'UTC';
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_sla_is_holiday(p_ws UUID, p_day DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_holidays h
     WHERE h.workspace_id = p_ws
       AND ((NOT h.repeats_yearly AND p_day BETWEEN h.starts_on AND h.ends_on)
         OR (h.repeats_yearly AND to_char(p_day, 'MMDD') BETWEEN to_char(h.starts_on, 'MMDD') AND to_char(h.ends_on, 'MMDD'))));
$$;

-- Unpaused seconds inside [p_a, p_b). With p_need set, also the instant at
-- which p_need unpaused seconds have passed, when that happens inside the
-- window. p_pauses are ordered and may end at 'infinity' (still paused).
CREATE OR REPLACE FUNCTION public.fn_sla_window_free(
  p_a TIMESTAMPTZ, p_b TIMESTAMPTZ, p_pauses TSTZRANGE[], p_need NUMERIC,
  OUT o_seconds NUMERIC, OUT o_hit TIMESTAMPTZ
)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  r TSTZRANGE;
  v_cursor TIMESTAMPTZ := p_a;
  v_free NUMERIC := 0;
  v_end TIMESTAMPTZ;
  v_len NUMERIC;
BEGIN
  o_seconds := 0;
  o_hit := NULL;
  IF p_pauses IS NOT NULL THEN
    FOREACH r IN ARRAY p_pauses LOOP
      CONTINUE WHEN upper(r) <= v_cursor;
      EXIT WHEN lower(r) >= p_b;
      IF lower(r) > v_cursor THEN
        v_end := least(lower(r), p_b);
        v_len := extract(epoch FROM (v_end - v_cursor));
        IF p_need IS NOT NULL AND v_free + v_len >= p_need THEN
          o_hit := v_cursor + make_interval(secs => (p_need - v_free)::double precision);
          o_seconds := p_need;
          RETURN;
        END IF;
        v_free := v_free + v_len;
      END IF;
      v_cursor := greatest(v_cursor, upper(r));
      EXIT WHEN v_cursor >= p_b;
    END LOOP;
  END IF;

  IF v_cursor < p_b THEN
    IF p_b = 'infinity' THEN
      IF p_need IS NOT NULL THEN
        o_hit := v_cursor + make_interval(secs => (p_need - v_free)::double precision);
        o_seconds := p_need;
      ELSE
        o_seconds := v_free;
      END IF;
      RETURN;
    END IF;
    v_len := extract(epoch FROM (p_b - v_cursor));
    IF p_need IS NOT NULL AND v_free + v_len >= p_need THEN
      o_hit := v_cursor + make_interval(secs => (p_need - v_free)::double precision);
      o_seconds := p_need;
      RETURN;
    END IF;
    v_free := v_free + v_len;
  END IF;
  o_seconds := v_free;
END;
$$;

-- The one piece of SLA arithmetic.
--
--   p_until NULL:  when have p_target_seconds of working time passed since
--                  p_start? (due_at; NULL if the ticket is paused for good
--                  or the target is not reachable within ~13 months)
--   p_until set:   how many working seconds are there in [p_start, p_until]?
--                  (worked_seconds)
--
-- "Working time" is calendar time, or with p_business the workspace's open
-- hours in its timezone minus holidays; either way minus the ticket's
-- paused periods (ticket_sla_pauses).
CREATE OR REPLACE FUNCTION public.fn_sla_walk(
  p_ws UUID, p_ticket UUID, p_start TIMESTAMPTZ, p_business BOOLEAN,
  p_target_seconds NUMERIC, p_until TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (due_at TIMESTAMPTZ, worked_seconds NUMERIC)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg JSONB;
  v_tz TEXT;
  v_pauses TSTZRANGE[];
  v_acc NUMERIC := 0;
  v_need NUMERIC;
  d DATE;
  v_last DATE;
  v_day JSONB;
  v_s TIME;
  v_e TIME;
  v_a TIMESTAMPTZ;
  v_b TIMESTAMPTZ;
  r RECORD;
  v_days TEXT[] := ARRAY['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
BEGIN
  SELECT coalesce(array_agg(tstzrange(p.paused_at, coalesce(p.resumed_at, 'infinity'::timestamptz), '[)') ORDER BY p.paused_at), '{}')
    INTO v_pauses
    FROM public.ticket_sla_pauses p
   WHERE p.ticket_id = p_ticket AND coalesce(p.resumed_at, 'infinity'::timestamptz) > p.paused_at;

  SELECT w.business_hours INTO v_cfg FROM public.workspaces w WHERE w.id = p_ws;
  IF NOT (p_business AND coalesce((v_cfg ->> 'enabled')::boolean, false)) THEN
    SELECT * INTO r FROM public.fn_sla_window_free(
      p_start, coalesce(p_until, 'infinity'::timestamptz), v_pauses,
      CASE WHEN p_until IS NULL THEN p_target_seconds END);
    due_at := r.o_hit;
    worked_seconds := r.o_seconds;
    RETURN NEXT;
    RETURN;
  END IF;

  v_tz := public.fn_sla_timezone(p_ws);
  d := (p_start AT TIME ZONE v_tz)::date;
  v_last := CASE WHEN p_until IS NULL THEN d + 400 ELSE (p_until AT TIME ZONE v_tz)::date END;

  WHILE d <= v_last LOOP
    IF NOT public.fn_sla_is_holiday(p_ws, d) THEN
      v_day := v_cfg -> 'schedule' -> v_days[extract(dow FROM d)::int + 1];
      IF coalesce((v_day ->> 'enabled')::boolean, false) THEN
        BEGIN
          v_s := coalesce(nullif(v_day ->> 'start', ''), '09:00')::time;
          v_e := coalesce(nullif(v_day ->> 'end', ''), '17:00')::time;
        EXCEPTION WHEN OTHERS THEN
          v_s := NULL;
          v_e := NULL;
        END;
        IF v_s IS NOT NULL AND v_e > v_s THEN
          v_a := greatest((d + v_s) AT TIME ZONE v_tz, p_start);
          v_b := (d + v_e) AT TIME ZONE v_tz;
          IF p_until IS NOT NULL THEN v_b := least(v_b, p_until); END IF;
          IF v_b > v_a THEN
            v_need := CASE WHEN p_until IS NULL THEN p_target_seconds - v_acc END;
            SELECT * INTO r FROM public.fn_sla_window_free(v_a, v_b, v_pauses, v_need);
            IF r.o_hit IS NOT NULL THEN
              due_at := r.o_hit;
              worked_seconds := p_target_seconds;
              RETURN NEXT;
              RETURN;
            END IF;
            v_acc := v_acc + r.o_seconds;
          END IF;
        END IF;
      END IF;
    END IF;
    d := d + 1;
  END LOOP;

  due_at := NULL;
  worked_seconds := v_acc;
  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_sla_walk(UUID, UUID, TIMESTAMPTZ, BOOLEAN, NUMERIC, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_sla_timezone(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_sla_is_holiday(UUID, DATE) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. Matching a ticket to a policy
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_sla_policy_matches(p public.sla_policies, t public.tickets)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c JSONB := coalesce(p.conditions, '{}'::jsonb);
  v_list TEXT[];
  v_email TEXT;
  v_emails TEXT[];
  v_domains TEXT[];
BEGIN
  SELECT coalesce(array_agg(lower(x)), '{}') INTO v_list FROM jsonb_array_elements_text(coalesce(c -> 'channels', '[]'::jsonb)) x;
  IF cardinality(v_list) > 0 AND NOT (lower(t.channel) = ANY (v_list)) THEN RETURN false; END IF;

  SELECT coalesce(array_agg(lower(x)), '{}') INTO v_list FROM jsonb_array_elements_text(coalesce(c -> 'group_ids', '[]'::jsonb)) x;
  IF cardinality(v_list) > 0 AND (t.group_id IS NULL OR NOT (t.group_id::text = ANY (v_list))) THEN RETURN false; END IF;

  SELECT coalesce(array_agg(lower(btrim(x))), '{}') INTO v_list FROM jsonb_array_elements_text(coalesce(c -> 'tags', '[]'::jsonb)) x;
  IF cardinality(v_list) > 0 AND NOT EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE lower(tg) = ANY (v_list)) THEN RETURN false; END IF;

  SELECT coalesce(array_agg(lower(btrim(x))), '{}') INTO v_emails FROM jsonb_array_elements_text(coalesce(c -> 'requester_emails', '[]'::jsonb)) x;
  SELECT coalesce(array_agg(lower(btrim(x))), '{}') INTO v_domains FROM jsonb_array_elements_text(coalesce(c -> 'requester_domains', '[]'::jsonb)) x;
  IF cardinality(v_emails) > 0 OR cardinality(v_domains) > 0 THEN
    SELECT lower(btrim(v.email)) INTO v_email FROM public.visitors v WHERE v.id = t.requester_id;
    IF coalesce(v_email, '') = '' THEN RETURN false; END IF;
    IF NOT (v_email = ANY (v_emails) OR split_part(v_email, '@', 2) = ANY (v_domains)) THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_sla_policy_matches(public.sla_policies, public.tickets) FROM PUBLIC, anon, authenticated;

-- The first active policy, in order, that matches.
CREATE OR REPLACE FUNCTION public.fn_sla_pick_policy(t public.tickets)
RETURNS public.sla_policies
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.sla_policies;
BEGIN
  FOR p IN SELECT * FROM public.sla_policies
            WHERE workspace_id = t.workspace_id AND is_active
            ORDER BY position, created_at, id LOOP
    IF public.fn_sla_policy_matches(p, t) THEN
      RETURN p;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_sla_pick_policy(public.tickets) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Events and alerts
-- ----------------------------------------------------------------------------

-- Returns whether a new event was stored (the unique index makes a repeat a
-- no-op, so a retry or a second sync never double counts).
CREATE OR REPLACE FUNCTION public.fn_sla_log(
  tm public.ticket_sla_timers, t public.tickets, p_event TEXT, p_at TIMESTAMPTZ, p_late BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  INSERT INTO public.sla_events (
    workspace_id, ticket_id, timer_id, policy_id, policy_name, metric, event, priority,
    assignee_id, group_id, target_minutes, started_at, due_at, occurred_at, late)
  VALUES (
    tm.workspace_id, t.id, tm.id, tm.policy_id,
    coalesce((SELECT sp.name FROM public.sla_policies sp WHERE sp.id = tm.policy_id), ''),
    tm.metric, p_event, t.priority, t.assignee_id, t.group_id, tm.target_minutes,
    tm.started_at, tm.due_at, p_at, p_late)
  ON CONFLICT (timer_id, started_at, event) WHERE superseded_at IS NULL DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- Emails the assignee and the group's members (as the policy says) through the
-- same outbox the email rules use, so sending, retries and backoff are shared.
-- Light agents are skipped: they cannot act on a ticket.
CREATE OR REPLACE FUNCTION public.fn_sla_notify(tm public.ticket_sla_timers, t public.tickets, p_kind TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.sla_policies;
  r RECORD;
  v_label TEXT;
  v_subject TEXT;
  v_body TEXT;
BEGIN
  SELECT * INTO p FROM public.sla_policies WHERE id = tm.policy_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_label := CASE tm.metric WHEN 'first_reply' THEN 'First reply time' WHEN 'next_reply' THEN 'Next reply time' ELSE 'Resolution time' END;
  IF p_kind = 'breach' THEN
    v_subject := format('[SLA breached] #%s: %s', t.number, v_label);
    v_body := format('%s for ticket #%s "%s" has been breached.', v_label, t.number, t.subject);
  ELSE
    v_subject := format('[SLA warning] #%s: %s is due soon', t.number, v_label);
    v_body := format('%s for ticket #%s "%s" is due at %s UTC.', v_label, t.number, t.subject, to_char(tm.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'));
  END IF;
  v_body := v_body || format(E'\n\nPolicy: %s\nPriority: %s\nTarget: %s minutes%s',
    p.name, t.priority, tm.target_minutes, CASE WHEN tm.business_hours THEN ' of business time' ELSE '' END);

  FOR r IN
    SELECT DISTINCT a.id, a.email
      FROM public.agents a
     WHERE a.workspace_id = t.workspace_id
       AND coalesce(a.is_active, true)
       AND coalesce(a.email, '') <> ''
       AND ((p.notify_assignee AND a.id = t.assignee_id)
         OR (p.notify_group AND t.group_id IS NOT NULL AND a.role <> 'light_agent'
             AND EXISTS (SELECT 1 FROM public.ticket_group_members m WHERE m.group_id = t.group_id AND m.agent_id = a.id)))
  LOOP
    INSERT INTO public.automation_outbox (workspace_id, ticket_id, rule_id, kind, payload)
    VALUES (t.workspace_id, t.id, NULL, 'email_agent',
            jsonb_build_object('to', r.email, 'subject', v_subject, 'body', v_body));
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_sla_log(public.ticket_sla_timers, public.tickets, TEXT, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_sla_notify(public.ticket_sla_timers, public.tickets, TEXT) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 8. The cache on tickets
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_sla_write_cache(p_ticket_id UUID, p_policy_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_running BOOLEAN;
  v_paused BOOLEAN;
  v_met BOOLEAN;
  v_due TIMESTAMPTZ;
  v_metric TEXT;
  v_warn TIMESTAMPTZ;
  v_breached TIMESTAMPTZ;
  v_state TEXT;
BEGIN
  SELECT coalesce(bool_or(status = 'running'), false),
         coalesce(bool_or(status = 'paused'), false),
         coalesce(bool_or(status = 'met'), false),
         min(due_at) FILTER (WHERE status = 'running'),
         min(breached_at) FILTER (WHERE status IN ('running', 'paused'))
    INTO v_running, v_paused, v_met, v_due, v_breached
    FROM public.ticket_sla_timers WHERE ticket_id = p_ticket_id;
  SELECT x.metric, x.warn_at INTO v_metric, v_warn FROM public.ticket_sla_timers x
   WHERE x.ticket_id = p_ticket_id AND x.status = 'running' AND x.due_at IS NOT NULL
   ORDER BY x.due_at LIMIT 1;
  v_state := CASE WHEN v_running THEN 'running' WHEN v_paused THEN 'paused' WHEN v_met THEN 'met' END;

  PERFORM set_config('zentry.sla_internal', 'on', true);
  UPDATE public.tickets tk
     SET sla_policy_id = p_policy_id, sla_state = v_state, sla_next_due_at = v_due,
         sla_next_metric = v_metric, sla_next_warn_at = v_warn, sla_breached_at = v_breached
   WHERE tk.id = p_ticket_id
     AND (tk.sla_policy_id IS DISTINCT FROM p_policy_id OR tk.sla_state IS DISTINCT FROM v_state
       OR tk.sla_next_due_at IS DISTINCT FROM v_due OR tk.sla_next_metric IS DISTINCT FROM v_metric
       OR tk.sla_next_warn_at IS DISTINCT FROM v_warn
       OR tk.sla_breached_at IS DISTINCT FROM v_breached);
  PERFORM set_config('zentry.sla_internal', '', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_sla_write_cache(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 9. fn_sla_sync: make a ticket's timers match its current state
-- ----------------------------------------------------------------------------

-- Idempotent and total: it derives what the timers should be from the ticket
-- (status, priority, reply timestamps) and the matching policy, then repairs
-- the timer rows to fit. Every event that can change an SLA (create, reply,
-- status/priority/group/tag change, policy or calendar edit, cron tick) just
-- calls this. p_fresh: timers that do not exist yet start counting now, not
-- at ticket creation (used when an admin saves a policy, so existing open
-- tickets are not flooded with instant breaches).
CREATE OR REPLACE FUNCTION public.fn_sla_sync(p_ticket_id UUID, p_fresh BOOLEAN DEFAULT false)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.tickets;
  p public.sla_policies;
  tm public.ticket_sla_timers;
  m TEXT;
  v_now TIMESTAMPTZ := public.fn_sla_now();
  v_target INTEGER;
  v_want BOOLEAN;
  v_exists BOOLEAN;
  v_met_at TIMESTAMPTZ;
  v_late BOOLEAN;
  v_start TIMESTAMPTZ;
  v_due TIMESTAMPTZ;
  v_warn TIMESTAMPTZ;
  v_alert INTEGER;
  v_paused BOOLEAN;
  v_breached TIMESTAMPTZ;
  v_warned TIMESTAMPTZ;
  v_new_breach TEXT[] := '{}';
BEGIN
  SELECT * INTO t FROM public.tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF t.merged_into_id IS NOT NULL THEN
    UPDATE public.ticket_sla_timers
       SET status = 'cancelled', due_at = NULL, warn_at = NULL, updated_at = v_now
     WHERE ticket_id = t.id AND status IN ('running', 'paused');
    PERFORM public.fn_sla_write_cache(t.id, NULL);
    RETURN;
  END IF;

  -- A closed ticket keeps no live timers, so it needs no policy.
  IF t.status <> 'closed' THEN
    p := public.fn_sla_pick_policy(t);
  END IF;

  FOREACH m IN ARRAY ARRAY['first_reply', 'next_reply', 'resolution'] LOOP
    SELECT * INTO tm FROM public.ticket_sla_timers WHERE ticket_id = t.id AND metric = m FOR UPDATE;
    v_exists := FOUND;

    -- A. Settle a timer whose awaited event has happened. A breach that fell
    --    due before that event is recorded first, under the due time that
    --    was in force then.
    IF v_exists AND tm.status IN ('running', 'paused') THEN
      v_met_at := CASE m
        WHEN 'first_reply' THEN t.first_agent_reply_at
        WHEN 'next_reply' THEN CASE WHEN t.last_agent_reply_at >= tm.started_at THEN t.last_agent_reply_at END
        ELSE CASE WHEN t.status IN ('solved', 'closed') THEN coalesce(t.solved_at, t.closed_at, v_now) END
      END;
      IF tm.status = 'running' AND tm.breached_at IS NULL AND tm.due_at IS NOT NULL
         AND tm.due_at <= v_now AND (v_met_at IS NULL OR tm.due_at < v_met_at) THEN
        UPDATE public.ticket_sla_timers SET breached_at = tm.due_at, updated_at = v_now WHERE id = tm.id RETURNING * INTO tm;
        IF public.fn_sla_log(tm, t, 'breached', tm.due_at, false) THEN
          PERFORM public.fn_sla_notify(tm, t, 'breach');
          v_new_breach := v_new_breach || m;
        END IF;
      END IF;
      IF v_met_at IS NOT NULL THEN
        v_late := tm.breached_at IS NOT NULL OR (tm.due_at IS NOT NULL AND v_met_at > tm.due_at);
        UPDATE public.ticket_sla_timers
           SET status = 'met', met_at = v_met_at, warn_at = NULL, updated_at = v_now
         WHERE id = tm.id RETURNING * INTO tm;
        PERFORM public.fn_sla_log(tm, t, 'met', v_met_at, v_late);
      END IF;
    END IF;

    -- B. What should exist now?
    v_target := CASE WHEN p.id IS NULL THEN NULL ELSE nullif(p.targets -> t.priority ->> m, '')::int END;
    v_want := v_target IS NOT NULL AND CASE m
      WHEN 'first_reply' THEN t.first_agent_reply_at IS NULL AND t.status NOT IN ('solved', 'closed')
      WHEN 'next_reply' THEN t.first_agent_reply_at IS NOT NULL AND t.last_customer_reply_at IS NOT NULL
        AND t.last_customer_reply_at > coalesce(t.last_agent_reply_at, '-infinity'::timestamptz)
        AND t.status NOT IN ('solved', 'closed')
      ELSE t.status NOT IN ('solved', 'closed')
    END;

    IF NOT v_want THEN
      IF v_exists AND tm.status IN ('running', 'paused') THEN
        UPDATE public.ticket_sla_timers
           SET status = 'cancelled', due_at = NULL, warn_at = NULL, updated_at = v_now
         WHERE id = tm.id;
      END IF;
      CONTINUE;
    END IF;

    -- C. Create or re-arm.
    IF NOT v_exists THEN
      v_start := CASE m WHEN 'next_reply' THEN t.last_customer_reply_at ELSE t.created_at END;
      IF p_fresh THEN v_start := greatest(v_start, v_now); END IF;
      INSERT INTO public.ticket_sla_timers (workspace_id, ticket_id, policy_id, metric, status, target_minutes, business_hours, started_at, updated_at)
      VALUES (t.workspace_id, t.id, p.id, m, 'running', v_target, p.business_hours, v_start, v_now)
      RETURNING * INTO tm;
    ELSIF tm.status IN ('met', 'cancelled') THEN
      IF tm.status = 'met' AND m = 'resolution' THEN
        -- Reopened: the earlier "met" no longer stands.
        UPDATE public.sla_events SET superseded_at = v_now
         WHERE timer_id = tm.id AND event = 'met' AND superseded_at IS NULL;
      END IF;
      v_start := CASE m WHEN 'next_reply' THEN t.last_customer_reply_at ELSE tm.started_at END;
      IF p_fresh AND tm.status = 'cancelled' THEN v_start := greatest(v_start, v_now); END IF;
      UPDATE public.ticket_sla_timers
         SET status = 'running', started_at = v_start, met_at = NULL,
             breached_at = CASE WHEN m = 'next_reply' THEN NULL ELSE breached_at END,
             warned_at = CASE WHEN m = 'next_reply' THEN NULL ELSE warned_at END,
             updated_at = v_now
       WHERE id = tm.id RETURNING * INTO tm;
    END IF;

    -- D. Recompute from scratch: new target, new calendar, pauses included.
    v_paused := t.status IN ('pending', 'on_hold');
    SELECT w.due_at INTO v_due
      FROM public.fn_sla_walk(t.workspace_id, t.id, tm.started_at, p.business_hours, v_target::numeric * 60, NULL) w;
    v_alert := least(p.alert_before_minutes, v_target / 2);
    v_warn := NULL;
    IF v_alert > 0 THEN
      SELECT w.due_at INTO v_warn
        FROM public.fn_sla_walk(t.workspace_id, t.id, tm.started_at, p.business_hours, (v_target - v_alert)::numeric * 60, NULL) w;
    END IF;
    v_breached := tm.breached_at;
    v_warned := tm.warned_at;

    -- A lower priority or a looser policy can move the due time past a breach
    -- that was already recorded: under the new target it did not happen.
    IF v_breached IS NOT NULL AND v_due IS NOT NULL AND v_due > v_now THEN
      UPDATE public.sla_events SET superseded_at = v_now
       WHERE timer_id = tm.id AND event = 'breached' AND started_at = tm.started_at AND superseded_at IS NULL;
      v_breached := NULL;
    END IF;
    IF v_warned IS NOT NULL AND (v_warn IS NULL OR v_warn > v_now) THEN
      v_warned := NULL;
    END IF;

    UPDATE public.ticket_sla_timers
       SET policy_id = p.id, target_minutes = v_target, business_hours = p.business_hours,
           status = CASE WHEN v_paused THEN 'paused' ELSE 'running' END,
           due_at = v_due, warn_at = v_warn, warned_at = v_warned, breached_at = v_breached, updated_at = v_now
     WHERE id = tm.id RETURNING * INTO tm;

    IF tm.breached_at IS NULL AND v_due IS NOT NULL AND v_due <= v_now THEN
      UPDATE public.ticket_sla_timers SET breached_at = v_due WHERE id = tm.id RETURNING * INTO tm;
      IF public.fn_sla_log(tm, t, 'breached', v_due, false) THEN
        PERFORM public.fn_sla_notify(tm, t, 'breach');
        v_new_breach := v_new_breach || m;
      END IF;
    END IF;
  END LOOP;

  PERFORM public.fn_sla_write_cache(t.id, CASE WHEN t.status = 'closed' THEN t.sla_policy_id ELSE p.id END);

  -- Rules last, so they see the finished state.
  IF cardinality(v_new_breach) > 0 THEN
    BEGIN
      PERFORM public.fn_run_ticket_triggers(t.id, ARRAY['sla_breach'], NULL, 'sla');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[SLA] triggers failed for ticket %: %', t.id, SQLERRM;
    END;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_sla_sync(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 10. Triggers: keep the pause ledger and the timers current
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_trg_sla_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := public.fn_sla_now();
  v_was BOOLEAN := false;
  v_is BOOLEAN := NEW.status IN ('pending', 'on_hold', 'solved');
BEGIN
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      v_was := OLD.status IN ('pending', 'on_hold', 'solved');
    END IF;
    IF v_is AND NOT v_was THEN
      INSERT INTO public.ticket_sla_pauses (workspace_id, ticket_id, paused_at, reason)
      VALUES (NEW.workspace_id, NEW.id, v_now, NEW.status);
    ELSIF v_was AND NOT v_is THEN
      UPDATE public.ticket_sla_pauses SET resumed_at = v_now
       WHERE ticket_id = NEW.id AND resumed_at IS NULL;
    END IF;
    PERFORM public.fn_sla_sync(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- Never let SLA bookkeeping block a customer's message or an agent's edit.
    RAISE WARNING '[SLA] sync failed for ticket %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sla_ticket ON public.tickets;
CREATE TRIGGER trg_sla_ticket
  AFTER INSERT OR UPDATE OF status, priority, group_id, tags, channel, requester_id,
    first_agent_reply_at, last_agent_reply_at, last_customer_reply_at, solved_at
  ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_trg_sla_ticket();

-- ----------------------------------------------------------------------------
-- 11. Cron tick, and re-applying after a policy or calendar change
-- ----------------------------------------------------------------------------

-- Records breaches that happened since the last run and sends the "due soon"
-- warnings. Called every few minutes by /api/cron/sla. Breaches are stamped
-- with when they happened (the due time), not when this noticed them.
CREATE OR REPLACE FUNCTION public.fn_sla_tick(p_workspace_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := public.fn_sla_now();
  r RECORD;
  tm public.ticket_sla_timers;
  t public.tickets;
  v_count INTEGER := 0;
BEGIN
  FOR r IN SELECT DISTINCT x.ticket_id FROM public.ticket_sla_timers x
            WHERE x.status = 'running' AND x.breached_at IS NULL AND x.due_at <= v_now
              AND (p_workspace_id IS NULL OR x.workspace_id = p_workspace_id)
            LIMIT 2000 LOOP
    BEGIN
      PERFORM public.fn_sla_sync(r.ticket_id);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[SLA] tick failed for ticket %: %', r.ticket_id, SQLERRM;
    END;
  END LOOP;

  FOR tm IN SELECT * FROM public.ticket_sla_timers x
             WHERE x.status = 'running' AND x.warned_at IS NULL AND x.breached_at IS NULL
               AND x.warn_at <= v_now AND x.due_at > v_now
               AND (p_workspace_id IS NULL OR x.workspace_id = p_workspace_id)
             LIMIT 2000 FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      SELECT * INTO t FROM public.tickets WHERE id = tm.ticket_id;
      UPDATE public.ticket_sla_timers SET warned_at = v_now WHERE id = tm.id RETURNING * INTO tm;
      IF public.fn_sla_log(tm, t, 'warning', v_now, false) THEN
        PERFORM public.fn_sla_notify(tm, t, 'warning');
        PERFORM public.fn_run_ticket_triggers(t.id, ARRAY['sla_warning'], NULL, 'sla');
        v_count := v_count + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[SLA] warning failed for timer %: %', tm.id, SQLERRM;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_sla_tick(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sla_tick(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_sla_assert_admin(p_workspace_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(auth.role(), '') <> 'service_role'
     AND NOT public.fn_role_can(p_workspace_id, 'manage_settings') THEN
    RAISE EXCEPTION 'Forbidden: your role cannot change SLA settings.' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_sla_assert_admin(UUID) FROM PUBLIC, anon, authenticated;

-- After a policy, the order of policies, holidays or business hours change:
-- re-evaluate every open ticket of the workspace.
CREATE OR REPLACE FUNCTION public.fn_sla_reapply_workspace(p_workspace_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_count INTEGER := 0;
BEGIN
  PERFORM public.fn_sla_assert_admin(p_workspace_id);
  FOR r IN SELECT tk.id FROM public.tickets tk
            WHERE tk.workspace_id = p_workspace_id AND tk.status <> 'closed' AND tk.merged_into_id IS NULL
            ORDER BY tk.updated_at DESC LIMIT 5000 LOOP
    BEGIN
      PERFORM public.fn_sla_sync(r.id, true);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[SLA] reapply failed for ticket %: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_sla_reapply_workspace(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_sla_reapply_workspace(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_sla_reorder_policies(p_workspace_id UUID, p_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_sla_assert_admin(p_workspace_id);
  UPDATE public.sla_policies sp
     SET position = o.ord::int
    FROM unnest(p_ids) WITH ORDINALITY AS o(id, ord)
   WHERE sp.id = o.id AND sp.workspace_id = p_workspace_id;
  PERFORM public.fn_sla_reapply_workspace(p_workspace_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_sla_reorder_policies(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_sla_reorder_policies(UUID, UUID[]) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 12. Rule conditions: "SLA breached" and "Hours until breach"
-- ----------------------------------------------------------------------------

-- Both are available to triggers and automations. The "What just happened"
-- list gains sla_warning and sla_breach, which fire when the cron (or a
-- reply) records the event, so a trigger can react at the moment of breach.
CREATE OR REPLACE FUNCTION public.fn_validate_conditions(p_conditions JSONB, p_kind TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  c JSONB;
  v_field TEXT;
  v_op TEXT;
  v_val JSONB;
BEGIN
  IF p_conditions IS NULL OR jsonb_typeof(p_conditions) <> 'array' THEN
    RAISE EXCEPTION 'Conditions must be a list.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_conditions) NOT BETWEEN 1 AND 15 THEN
    RAISE EXCEPTION 'Add between 1 and 15 conditions.' USING ERRCODE = '22023';
  END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(p_conditions) LOOP
    v_field := c->>'field';
    v_op := c->>'op';
    v_val := c->'value';

    IF v_field IN ('status', 'priority', 'type', 'channel') THEN
      IF v_op NOT IN ('is', 'is_not', 'in', 'not_in') THEN
        RAISE EXCEPTION '% accepts is, is not, is one of or is none of.', v_field USING ERRCODE = '22023';
      END IF;
    ELSIF v_field IN ('group_id', 'assignee_id') THEN
      IF v_op NOT IN ('is', 'is_not', 'is_empty', 'is_not_empty') THEN
        RAISE EXCEPTION '% accepts is, is not, is empty or is not empty.', v_field USING ERRCODE = '22023';
      END IF;
    ELSIF v_field IN ('subject', 'message', 'requester_email', 'requester_name') THEN
      IF v_op NOT IN ('contains', 'not_contains', 'is', 'is_not', 'is_empty', 'is_not_empty') THEN
        RAISE EXCEPTION '% accepts contains, does not contain, is, is not, is empty or is not empty.', v_field USING ERRCODE = '22023';
      END IF;
    ELSIF v_field = 'tags' THEN
      IF v_op NOT IN ('contains', 'not_contains', 'contains_all', 'is_empty', 'is_not_empty') THEN
        RAISE EXCEPTION 'Tags accept has any of, has none of, has all of, is empty or is not empty.' USING ERRCODE = '22023';
      END IF;
    ELSIF v_field = 'changed' THEN
      IF p_kind <> 'trigger' THEN
        RAISE EXCEPTION '"What changed" is only for triggers; automations run on a schedule.' USING ERRCODE = '22023';
      END IF;
      IF v_op <> 'is' OR NOT (v_val #>> '{}') IN ('created', 'status', 'priority', 'assignee', 'group', 'tags', 'subject', 'type', 'message', 'reply', 'sla_breach', 'sla_warning') THEN
        RAISE EXCEPTION 'Choose what changed: created, status, priority, assignee, group, tags, subject, type, a customer message, an agent reply, an SLA warning or an SLA breach.' USING ERRCODE = '22023';
      END IF;
    ELSIF v_field = 'sla_breached' THEN
      IF v_op <> 'is' OR (v_val #>> '{}') NOT IN ('yes', 'no') THEN
        RAISE EXCEPTION 'SLA breached accepts "is" with yes or no.' USING ERRCODE = '22023';
      END IF;
    ELSIF v_field = 'hours_until_breach' THEN
      IF v_op NOT IN ('gte', 'lte') OR jsonb_typeof(v_val) <> 'number' OR (v_val #>> '{}')::numeric < -8760 OR (v_val #>> '{}')::numeric > 8760 THEN
        RAISE EXCEPTION 'Hours until breach needs "at least" or "at most" and a number of hours between -8760 and 8760.' USING ERRCODE = '22023';
      END IF;
    ELSIF v_field IN ('hours_since_created', 'hours_since_updated', 'hours_since_status_change',
                      'hours_since_customer_reply', 'hours_since_agent_reply', 'hours_since_solved') THEN
      IF p_kind <> 'automation' THEN
        RAISE EXCEPTION 'Time conditions are only for automations.' USING ERRCODE = '22023';
      END IF;
      IF v_op NOT IN ('gte', 'lte') OR jsonb_typeof(v_val) <> 'number' OR (v_val #>> '{}')::numeric < 0 OR (v_val #>> '{}')::numeric > 8760 THEN
        RAISE EXCEPTION 'Time conditions need "at least" or "at most" and a number of hours between 0 and 8760.' USING ERRCODE = '22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unknown condition: %.', coalesce(v_field, '(missing)') USING ERRCODE = '22023';
    END IF;

    IF v_field NOT IN ('hours_until_breach', 'hours_since_created', 'hours_since_updated', 'hours_since_status_change',
                       'hours_since_customer_reply', 'hours_since_agent_reply', 'hours_since_solved')
       AND v_op NOT IN ('is_empty', 'is_not_empty')
       AND (v_val IS NULL OR jsonb_typeof(v_val) NOT IN ('string', 'array') OR v_val = '""'::jsonb OR v_val = '[]'::jsonb) THEN
      RAISE EXCEPTION 'The condition on % needs a value.', v_field USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_rule_condition_holds(
  p_cond JSONB, p_ticket public.tickets, p_message TEXT, p_changed TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_field TEXT := p_cond->>'field';
  v_op TEXT := p_cond->>'op';
  v_val JSONB := p_cond->'value';
  v_actual TEXT;
  v_list TEXT[];
  v_hours NUMERIC;
  v_ts TIMESTAMPTZ;
  v_text TEXT;
  v_word TEXT;
  v_hit BOOLEAN;
BEGIN
  -- Values may be a string, or a list for "is one of" / tags.
  IF v_val IS NOT NULL AND jsonb_typeof(v_val) = 'array' THEN
    SELECT coalesce(array_agg(lower(trim(x))), '{}') INTO v_list FROM jsonb_array_elements_text(v_val) x;
  ELSIF v_val IS NOT NULL AND jsonb_typeof(v_val) = 'string' THEN
    SELECT coalesce(array_agg(lower(trim(x))) FILTER (WHERE trim(x) <> ''), '{}') INTO v_list
      FROM unnest(string_to_array(v_val #>> '{}', ',')) x;
  ELSE
    v_list := '{}';
  END IF;

  IF v_field = 'changed' THEN
    RETURN p_changed IS NULL OR lower(v_val #>> '{}') = ANY (p_changed);
  END IF;

  IF v_field LIKE 'hours\_since\_%' THEN
    v_ts := CASE v_field
      WHEN 'hours_since_created' THEN p_ticket.created_at
      WHEN 'hours_since_updated' THEN p_ticket.updated_at
      WHEN 'hours_since_status_change' THEN p_ticket.status_changed_at
      WHEN 'hours_since_customer_reply' THEN p_ticket.last_customer_reply_at
      WHEN 'hours_since_agent_reply' THEN p_ticket.last_agent_reply_at
      WHEN 'hours_since_solved' THEN p_ticket.solved_at
    END;
    IF v_ts IS NULL THEN RETURN false; END IF;
    v_hours := extract(epoch FROM (public.fn_sla_now() - v_ts)) / 3600.0;
    RETURN CASE v_op WHEN 'gte' THEN v_hours >= (v_val #>> '{}')::numeric ELSE v_hours <= (v_val #>> '{}')::numeric END;
  END IF;

  -- Live, from the timers, so neither depends on the cron having run.
  IF v_field = 'sla_breached' THEN
    v_hit := EXISTS (SELECT 1 FROM public.ticket_sla_timers x
                      WHERE x.ticket_id = p_ticket.id AND x.status IN ('running', 'paused')
                        AND (x.breached_at IS NOT NULL OR (x.status = 'running' AND x.due_at <= public.fn_sla_now())));
    RETURN CASE WHEN (v_val #>> '{}') = 'yes' THEN v_hit ELSE NOT v_hit END;
  END IF;

  -- Negative once breached, so "at most 2" also catches tickets already late.
  IF v_field = 'hours_until_breach' THEN
    SELECT min(x.due_at) INTO v_ts FROM public.ticket_sla_timers x
     WHERE x.ticket_id = p_ticket.id AND x.status = 'running' AND x.due_at IS NOT NULL;
    IF v_ts IS NULL THEN RETURN false; END IF;
    v_hours := extract(epoch FROM (v_ts - public.fn_sla_now())) / 3600.0;
    RETURN CASE v_op WHEN 'gte' THEN v_hours >= (v_val #>> '{}')::numeric ELSE v_hours <= (v_val #>> '{}')::numeric END;
  END IF;

  IF v_field = 'tags' THEN
    RETURN CASE v_op
      WHEN 'contains' THEN EXISTS (SELECT 1 FROM unnest(p_ticket.tags) t WHERE lower(t) = ANY (v_list))
      WHEN 'not_contains' THEN NOT EXISTS (SELECT 1 FROM unnest(p_ticket.tags) t WHERE lower(t) = ANY (v_list))
      WHEN 'contains_all' THEN (SELECT bool_and(l = ANY (ARRAY(SELECT lower(t) FROM unnest(p_ticket.tags) t))) FROM unnest(v_list) l)
      WHEN 'is_empty' THEN coalesce(array_length(p_ticket.tags, 1), 0) = 0
      ELSE coalesce(array_length(p_ticket.tags, 1), 0) > 0
    END;
  END IF;

  v_actual := CASE v_field
    WHEN 'status' THEN p_ticket.status
    WHEN 'priority' THEN p_ticket.priority
    WHEN 'type' THEN p_ticket.type
    WHEN 'channel' THEN p_ticket.channel
    WHEN 'group_id' THEN p_ticket.group_id::text
    WHEN 'assignee_id' THEN p_ticket.assignee_id::text
    WHEN 'subject' THEN p_ticket.subject
    WHEN 'message' THEN coalesce(p_message, public.fn_latest_customer_message(p_ticket.id))
    WHEN 'requester_email' THEN (SELECT email FROM public.visitors WHERE id = p_ticket.requester_id)
    WHEN 'requester_name' THEN (SELECT name FROM public.visitors WHERE id = p_ticket.requester_id)
  END;

  IF v_op = 'is_empty' THEN RETURN coalesce(v_actual, '') = ''; END IF;
  IF v_op = 'is_not_empty' THEN RETURN coalesce(v_actual, '') <> ''; END IF;

  v_text := lower(coalesce(v_actual, ''));
  IF v_op IN ('is', 'in') THEN RETURN v_actual IS NOT NULL AND v_text = ANY (v_list); END IF;
  IF v_op IN ('is_not', 'not_in') THEN RETURN v_actual IS NULL OR NOT (v_text = ANY (v_list)); END IF;

  -- contains / not_contains: any listed keyword appears in the text.
  v_hit := false;
  FOREACH v_word IN ARRAY v_list LOOP
    IF v_word <> '' AND position(v_word IN v_text) > 0 THEN v_hit := true; EXIT; END IF;
  END LOOP;
  RETURN CASE v_op WHEN 'contains' THEN v_hit ELSE NOT v_hit END;
END;
$$;
