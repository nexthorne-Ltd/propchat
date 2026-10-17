-- ============================================================================
-- Macros, triggers and automations for tickets.
--
-- Problem: agents repeat the same reply-and-change-fields work by hand, and
-- nothing reacts to a ticket on its own. This adds Zendesk-style productivity
-- tools on top of the ticketing rules in 20261009110000_ticketing.sql:
--
--   * macros: a reply template plus field changes, personal or shared.
--   * triggers: rules that run instantly when a ticket is created or updated
--     (and when a customer or agent message arrives).
--   * automations: time-based rules, run hourly by /api/cron/run-automations.
--   * automation_rule_runs: the log of which rule fired on which ticket.
--   * automation_outbox: emails and webhooks a rule asked for. The database
--     cannot send them, so they queue here and the app sends them.
--
-- The rules live in the database for the same reason the ticketing rules do:
-- they must hold for every writer (widget, bot, inbox, channels, API).
--
-- Loop guard (a rule's own change can fire other rules, and those can fire the
-- first again). Four layers, all in fn_fire_rule:
--   1. a rule fires at most once per ticket within one cascade of rule-driven
--      changes (the list resets when the outermost rule finishes);
--   2. rule-driven changes may chain at most 5 levels deep;
--   3. a rule fires at most 5 times per ticket in 10 minutes (covers loops
--      that cross transactions, such as an email that provokes a reply);
--   4. an automation does not fire again on a ticket until something changed
--      on it since the last time it fired.
-- Each skip is logged as 'skipped_loop' so admins can see and fix the rule.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.macros (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- NULL = shared with the whole workspace; otherwise the agent it belongs to.
  owner_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 100),
  content      TEXT NOT NULL DEFAULT '' CHECK (char_length(content) <= 5000),
  -- Array of field actions, see fn_validate_actions.
  actions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  position     INTEGER NOT NULL DEFAULT 0,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT macros_content_or_actions CHECK (content <> '' OR jsonb_array_length(actions) > 0)
);
CREATE INDEX IF NOT EXISTS macros_workspace_idx ON public.macros (workspace_id, position, title);

CREATE TABLE IF NOT EXISTS public.automation_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('trigger', 'automation')),
  name         TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
  description  TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  -- Rules run in ascending position; ties by creation time.
  position     INTEGER NOT NULL DEFAULT 0,
  match_mode   TEXT NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
  conditions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_rules_workspace_idx ON public.automation_rules (workspace_id, kind, position);

CREATE TABLE IF NOT EXISTS public.automation_rule_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  rule_id        UUID REFERENCES public.automation_rules(id) ON DELETE SET NULL,
  rule_name      TEXT NOT NULL,
  kind           TEXT NOT NULL,
  ticket_id      UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  event          TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('fired', 'failed', 'skipped_loop')),
  summary        JSONB NOT NULL DEFAULT '[]'::jsonb,
  error          TEXT,
  -- The ticket's updated_at right after the rule ran; automations compare it
  -- to decide whether anything changed since (loop guard 4).
  ticket_version TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_runs_ticket_idx ON public.automation_rule_runs (ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_workspace_idx ON public.automation_rule_runs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_rule_ticket_idx ON public.automation_rule_runs (rule_id, ticket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.automation_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id       UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  rule_id         UUID REFERENCES public.automation_rules(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('email_requester', 'email_agent', 'webhook')),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS automation_outbox_due_idx ON public.automation_outbox (next_attempt_at) WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- 2. Row level security
-- ----------------------------------------------------------------------------

ALTER TABLE public.macros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_rule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_outbox ENABLE ROW LEVEL SECURITY;

-- Macros: shared ones are visible to the workspace, personal ones only to
-- their owner. Shared macros are managed by owners/admins; an agent who can
-- reply manages their own personal ones.
DROP POLICY IF EXISTS macros_select ON public.macros;
CREATE POLICY macros_select ON public.macros FOR SELECT TO authenticated
  USING (public.fn_workspace_role(workspace_id) IS NOT NULL AND (owner_id IS NULL OR owner_id = auth.uid()));

DROP POLICY IF EXISTS macros_insert ON public.macros;
CREATE POLICY macros_insert ON public.macros FOR INSERT TO authenticated
  WITH CHECK (
    (owner_id IS NULL AND public.fn_role_can(workspace_id, 'manage_settings'))
    OR (owner_id = auth.uid() AND public.fn_role_can(workspace_id, 'reply'))
  );

DROP POLICY IF EXISTS macros_update ON public.macros;
CREATE POLICY macros_update ON public.macros FOR UPDATE TO authenticated
  USING (
    (owner_id IS NULL AND public.fn_role_can(workspace_id, 'manage_settings'))
    OR (owner_id = auth.uid() AND public.fn_role_can(workspace_id, 'reply'))
  )
  WITH CHECK (
    (owner_id IS NULL AND public.fn_role_can(workspace_id, 'manage_settings'))
    OR (owner_id = auth.uid() AND public.fn_role_can(workspace_id, 'reply'))
  );

DROP POLICY IF EXISTS macros_delete ON public.macros;
CREATE POLICY macros_delete ON public.macros FOR DELETE TO authenticated
  USING (
    (owner_id IS NULL AND public.fn_role_can(workspace_id, 'manage_settings'))
    OR (owner_id = auth.uid() AND public.fn_role_can(workspace_id, 'reply'))
  );

-- Rules: owners and admins only, for reading as well (webhook secrets live in
-- the actions).
DROP POLICY IF EXISTS automation_rules_all ON public.automation_rules;
CREATE POLICY automation_rules_all ON public.automation_rules FOR ALL TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'))
  WITH CHECK (public.fn_role_can(workspace_id, 'manage_settings'));

-- The log: anyone who can view tickets can see what fired on them. Written
-- only by the engine below (no INSERT/UPDATE/DELETE policy).
DROP POLICY IF EXISTS automation_runs_select ON public.automation_rule_runs;
CREATE POLICY automation_runs_select ON public.automation_rule_runs FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'view'));

-- The outbox has no policy at all: service role only.

REVOKE ALL ON public.automation_outbox FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.automation_rule_runs FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.automation_rule_runs FROM authenticated;
GRANT SELECT ON public.automation_rule_runs TO authenticated;
REVOKE ALL ON public.macros, public.automation_rules FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.macros, public.automation_rules TO authenticated;
GRANT ALL ON public.macros, public.automation_rules, public.automation_rule_runs, public.automation_outbox TO service_role;

-- ----------------------------------------------------------------------------
-- 3. Validation (so every writer gets the same, readable errors)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_validate_actions(p_actions JSONB, p_allow_outbound BOOLEAN, p_is_macro BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  a JSONB;
  v_type TEXT;
  v_val JSONB;
  v_tag JSONB;
BEGIN
  IF p_actions IS NULL OR jsonb_typeof(p_actions) <> 'array' THEN
    RAISE EXCEPTION 'Actions must be a list.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_actions) > 10 THEN
    RAISE EXCEPTION 'Use at most 10 actions.' USING ERRCODE = '22023';
  END IF;

  FOR a IN SELECT * FROM jsonb_array_elements(p_actions) LOOP
    v_type := a->>'type';
    v_val := a->'value';
    IF v_type IN ('set_status', 'set_priority', 'set_type') THEN
      IF v_type = 'set_status' AND NOT (v_val #>> '{}') IN ('open', 'pending', 'on_hold', 'solved', 'closed') THEN
        RAISE EXCEPTION 'Status must be open, pending, on hold, solved or closed.' USING ERRCODE = '22023';
      ELSIF v_type = 'set_priority' AND NOT (v_val #>> '{}') IN ('low', 'normal', 'high', 'urgent') THEN
        RAISE EXCEPTION 'Priority must be low, normal, high or urgent.' USING ERRCODE = '22023';
      ELSIF v_type = 'set_type' AND NOT (v_val #>> '{}') IN ('question', 'incident', 'problem', 'task') THEN
        RAISE EXCEPTION 'Type must be question, incident, problem or task.' USING ERRCODE = '22023';
      END IF;
    ELSIF v_type = 'set_group' THEN
      IF (v_val #>> '{}') <> 'none' AND NOT (v_val #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Choose a group, or "none".' USING ERRCODE = '22023';
      END IF;
    ELSIF v_type = 'set_assignee' THEN
      IF (v_val #>> '{}') = 'me' THEN
        IF NOT p_is_macro THEN
          RAISE EXCEPTION '"Me" only makes sense in a macro; choose a person for a rule.' USING ERRCODE = '22023';
        END IF;
      ELSIF (v_val #>> '{}') <> 'none' AND NOT (v_val #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Choose an assignee, "me" or "none".' USING ERRCODE = '22023';
      END IF;
    ELSIF v_type IN ('add_tags', 'remove_tags') THEN
      IF v_val IS NULL OR jsonb_typeof(v_val) <> 'array' OR jsonb_array_length(v_val) NOT BETWEEN 1 AND 10 THEN
        RAISE EXCEPTION 'Give 1 to 10 tags.' USING ERRCODE = '22023';
      END IF;
      FOR v_tag IN SELECT * FROM jsonb_array_elements(v_val) LOOP
        IF jsonb_typeof(v_tag) <> 'string' OR char_length(trim(v_tag #>> '{}')) NOT BETWEEN 1 AND 40 THEN
          RAISE EXCEPTION 'Tags must be 1 to 40 characters.' USING ERRCODE = '22023';
        END IF;
      END LOOP;
    ELSIF v_type IN ('email_requester', 'email_agent') AND p_allow_outbound THEN
      IF char_length(trim(coalesce(a->>'subject', ''))) NOT BETWEEN 1 AND 200
         OR char_length(trim(coalesce(a->>'body', ''))) NOT BETWEEN 1 AND 5000 THEN
        RAISE EXCEPTION 'An email action needs a subject (up to 200 characters) and a message (up to 5000).' USING ERRCODE = '22023';
      END IF;
    ELSIF v_type = 'webhook' AND p_allow_outbound THEN
      IF NOT coalesce(a->>'url', '') ~* '^https://[^\s/]+' OR char_length(a->>'url') > 500 THEN
        RAISE EXCEPTION 'A webhook needs a full https:// address.' USING ERRCODE = '22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unknown or not allowed action: %.', coalesce(v_type, '(missing)') USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$$;

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
      IF v_op <> 'is' OR NOT (v_val #>> '{}') IN ('created', 'status', 'priority', 'assignee', 'group', 'tags', 'subject', 'type', 'message', 'reply') THEN
        RAISE EXCEPTION 'Choose what changed: created, status, priority, assignee, group, tags, subject, type, a customer message or an agent reply.' USING ERRCODE = '22023';
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

    IF v_field NOT IN ('hours_since_created', 'hours_since_updated', 'hours_since_status_change',
                       'hours_since_customer_reply', 'hours_since_agent_reply', 'hours_since_solved')
       AND v_op NOT IN ('is_empty', 'is_not_empty')
       AND (v_val IS NULL OR jsonb_typeof(v_val) NOT IN ('string', 'array') OR v_val = '""'::jsonb OR v_val = '[]'::jsonb) THEN
      RAISE EXCEPTION 'The condition on % needs a value.', v_field USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_automation_rule_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.fn_validate_conditions(NEW.conditions, NEW.kind);
  PERFORM public.fn_validate_actions(NEW.actions, true, false);
  IF jsonb_array_length(NEW.actions) = 0 THEN
    RAISE EXCEPTION 'Add at least one action.' USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_automation_rule_before_write ON public.automation_rules;
CREATE TRIGGER trg_automation_rule_before_write
  BEFORE INSERT OR UPDATE ON public.automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.fn_automation_rule_before_write();

CREATE OR REPLACE FUNCTION public.fn_macro_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.fn_validate_actions(NEW.actions, false, true);
  NEW.title := trim(NEW.title);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_macro_before_write ON public.macros;
CREATE TRIGGER trg_macro_before_write
  BEFORE INSERT OR UPDATE ON public.macros
  FOR EACH ROW EXECUTE FUNCTION public.fn_macro_before_write();

-- ----------------------------------------------------------------------------
-- 4. Placeholders: {{ticket.id}}, {{ticket.requester.name}}, {{agent.name}} ...
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_render_placeholders(p_template TEXT, p_ticket public.tickets, p_agent_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_text TEXT := coalesce(p_template, '');
  v_req_name TEXT := '';
  v_req_email TEXT := '';
  v_agent TEXT := '';
  v_assignee TEXT := '';
  v_ws TEXT := '';
  v_pair TEXT[];
  v_map TEXT[][];
BEGIN
  IF p_ticket.requester_id IS NOT NULL THEN
    SELECT coalesce(name, ''), coalesce(email, '') INTO v_req_name, v_req_email
      FROM public.visitors WHERE id = p_ticket.requester_id AND workspace_id = p_ticket.workspace_id;
  END IF;
  IF p_agent_id IS NOT NULL THEN
    SELECT coalesce(name, '') INTO v_agent FROM public.agents WHERE id = p_agent_id AND workspace_id = p_ticket.workspace_id;
  END IF;
  IF p_ticket.assignee_id IS NOT NULL THEN
    SELECT coalesce(name, '') INTO v_assignee FROM public.agents WHERE id = p_ticket.assignee_id;
  END IF;
  SELECT coalesce(name, '') INTO v_ws FROM public.workspaces WHERE id = p_ticket.workspace_id;

  -- Anonymous visitors have no name; "there" keeps "Hi {{ticket.requester.name}}" readable.
  IF trim(v_req_name) = '' THEN v_req_name := 'there'; END IF;

  v_map := ARRAY[
    ['ticket.id', p_ticket.number::text],
    ['ticket.subject', coalesce(p_ticket.subject, '')],
    ['ticket.status', replace(p_ticket.status, '_', ' ')],
    ['ticket.priority', p_ticket.priority],
    ['ticket.requester.name', v_req_name],
    ['ticket.requester.first_name', split_part(v_req_name, ' ', 1)],
    ['ticket.requester.email', v_req_email],
    ['ticket.assignee.name', v_assignee],
    ['agent.name', coalesce(nullif(v_agent, ''), v_assignee)],
    ['agent.first_name', split_part(coalesce(nullif(v_agent, ''), v_assignee), ' ', 1)],
    ['workspace.name', v_ws]
  ];
  FOREACH v_pair SLICE 1 IN ARRAY v_map LOOP
    -- Backslashes and & are special in a regexp replacement: escape the value.
    v_text := regexp_replace(
      v_text,
      '\{\{\s*' || replace(v_pair[1], '.', '\.') || '\s*\}\}',
      replace(replace(v_pair[2], '\', '\\'), '&', '\&'),
      'g'
    );
  END LOOP;
  RETURN v_text;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_render_placeholders(TEXT, public.tickets, UUID) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. Conditions
-- ----------------------------------------------------------------------------

-- Latest customer message on a ticket, for "message contains" outside a message event.
CREATE OR REPLACE FUNCTION public.fn_latest_customer_message(p_ticket_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT content FROM public.messages
   WHERE ticket_id = p_ticket_id AND sender_type = 'visitor' AND coalesce(is_internal, false) = false
   ORDER BY created_at DESC LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_latest_customer_message(UUID) FROM PUBLIC, anon, authenticated;

-- Does one condition hold for `p_ticket`? `p_changed` lists what just changed
-- (NULL means "assume everything", used by the rule tester).
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
    v_hours := extract(epoch FROM (now() - v_ts)) / 3600.0;
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

REVOKE EXECUTE ON FUNCTION public.fn_rule_condition_holds(JSONB, public.tickets, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_rule_matches(
  p_conditions JSONB, p_match TEXT, p_ticket public.tickets, p_message TEXT, p_changed TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c JSONB;
  v_any BOOLEAN := false;
BEGIN
  IF jsonb_array_length(p_conditions) = 0 THEN RETURN false; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(p_conditions) LOOP
    IF public.fn_rule_condition_holds(c, p_ticket, p_message, p_changed) THEN
      v_any := true;
      IF p_match = 'any' THEN RETURN true; END IF;
    ELSIF p_match = 'all' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN p_match = 'all' OR v_any;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_rule_matches(JSONB, TEXT, public.tickets, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. Field actions (shared by rules and macros)
-- ----------------------------------------------------------------------------

-- Applies set_* / add_tags / remove_tags in one UPDATE. Returns whether
-- anything changed. `p_me` resolves {"type":"set_assignee","value":"me"}.
CREATE OR REPLACE FUNCTION public.fn_apply_field_actions(p_ticket_id UUID, p_actions JSONB, p_me UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.tickets;
  a JSONB;
  v_status TEXT;
  v_priority TEXT;
  v_type TEXT;
  v_group UUID;
  v_assignee UUID;
  v_tags TEXT[];
  v_val TEXT;
  v_list TEXT[];
BEGIN
  SELECT * INTO t FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_status := t.status; v_priority := t.priority; v_type := t.type;
  v_group := t.group_id; v_assignee := t.assignee_id; v_tags := t.tags;

  FOR a IN SELECT * FROM jsonb_array_elements(p_actions) LOOP
    v_val := a->'value' #>> '{}';
    CASE a->>'type'
      WHEN 'set_status' THEN v_status := v_val;
      WHEN 'set_priority' THEN v_priority := v_val;
      WHEN 'set_type' THEN v_type := v_val;
      WHEN 'set_group' THEN v_group := CASE WHEN v_val = 'none' THEN NULL ELSE v_val::uuid END;
      WHEN 'set_assignee' THEN
        v_assignee := CASE WHEN v_val = 'none' THEN NULL WHEN v_val = 'me' THEN p_me ELSE v_val::uuid END;
      WHEN 'add_tags' THEN
        SELECT array_agg(DISTINCT x ORDER BY x) INTO v_tags
          FROM unnest(v_tags || ARRAY(SELECT lower(trim(y)) FROM jsonb_array_elements_text(a->'value') y)) x;
      WHEN 'remove_tags' THEN
        SELECT coalesce(array_agg(x ORDER BY x), '{}') INTO v_tags
          FROM unnest(v_tags) x
         WHERE NOT (lower(x) = ANY (ARRAY(SELECT lower(trim(y)) FROM jsonb_array_elements_text(a->'value') y)));
      ELSE NULL;
    END CASE;
  END LOOP;
  v_tags := coalesce(v_tags, '{}');

  IF v_status IS NOT DISTINCT FROM t.status AND v_priority IS NOT DISTINCT FROM t.priority
     AND v_type IS NOT DISTINCT FROM t.type AND v_group IS NOT DISTINCT FROM t.group_id
     AND v_assignee IS NOT DISTINCT FROM t.assignee_id AND v_tags IS NOT DISTINCT FROM t.tags THEN
    RETURN false;
  END IF;

  UPDATE public.tickets
     SET status = v_status, priority = v_priority, type = v_type,
         group_id = v_group, assignee_id = v_assignee, tags = v_tags
   WHERE id = p_ticket_id;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_apply_field_actions(UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Firing a rule (with the loop guard)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_log_rule_run(
  r public.automation_rules, p_ticket_id UUID, p_event TEXT, p_outcome TEXT, p_summary JSONB, p_error TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.automation_rule_runs (workspace_id, rule_id, rule_name, kind, ticket_id, event, outcome, summary, error, ticket_version)
  VALUES (r.workspace_id, r.id, r.name, r.kind, p_ticket_id, p_event, p_outcome, coalesce(p_summary, '[]'::jsonb), p_error,
          (SELECT updated_at FROM public.tickets WHERE id = p_ticket_id));
$$;

REVOKE EXECUTE ON FUNCTION public.fn_log_rule_run(public.automation_rules, UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- What the log shows for an action: its kind and value, never secrets or bodies.
CREATE OR REPLACE FUNCTION public.fn_actions_summary(p_actions JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'type', x->>'type',
    'value', CASE
      WHEN x->>'type' IN ('email_requester', 'email_agent') THEN to_jsonb(x->>'subject')
      WHEN x->>'type' = 'webhook' THEN to_jsonb(x->>'url')
      ELSE x->'value' END)), '[]'::jsonb)
  FROM jsonb_array_elements(p_actions) x;
$$;

CREATE OR REPLACE FUNCTION public.fn_fire_rule(r public.automation_rules, p_ticket_id UUID, p_event TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.tickets;
  a JSONB;
  v_depth INT := coalesce(nullif(current_setting('zentry.automation_depth', true), '')::int, 0);
  v_key TEXT := r.id::text || ':' || p_ticket_id::text || ',';
  v_fired TEXT := coalesce(current_setting('zentry.automation_fired', true), '');
  v_field_actions JSONB;
  v_changed BOOLEAN := false;
  v_outbound BOOLEAN := false;
  v_prev TEXT;
  v_email TEXT;
BEGIN
  -- Guard 1: once per ticket per transaction. Guard 2: bounded chain depth.
  IF position(v_key IN v_fired) > 0 OR v_depth >= 5 THEN
    PERFORM public.fn_log_rule_run(r, p_ticket_id, p_event, 'skipped_loop', '[]'::jsonb,
      CASE WHEN v_depth >= 5 THEN 'Rules triggered each other more than 5 levels deep.'
           ELSE 'This rule already ran on this ticket as part of the same change.' END);
    RETURN;
  END IF;
  -- Guard 3: at most 5 firings per rule and ticket in 10 minutes.
  IF (SELECT count(*) FROM public.automation_rule_runs
       WHERE rule_id = r.id AND ticket_id = p_ticket_id AND outcome = 'fired'
         AND created_at > now() - interval '10 minutes') >= 5 THEN
    IF NOT EXISTS (SELECT 1 FROM public.automation_rule_runs
                    WHERE rule_id = r.id AND ticket_id = p_ticket_id AND outcome = 'skipped_loop'
                      AND created_at > now() - interval '10 minutes') THEN
      PERFORM public.fn_log_rule_run(r, p_ticket_id, p_event, 'skipped_loop', '[]'::jsonb,
        'Fired 5 times on this ticket in 10 minutes, so it was paused for this ticket. Check whether it keeps re-triggering itself.');
    END IF;
    RETURN;
  END IF;

  PERFORM set_config('zentry.automation_fired', v_fired || v_key, true);
  PERFORM set_config('zentry.automation_depth', (v_depth + 1)::text, true);

  BEGIN
    v_prev := public.fn_ticket_set_actor('system', NULL);

    SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_field_actions
      FROM jsonb_array_elements(r.actions) x
     WHERE x->>'type' IN ('set_status', 'set_priority', 'set_type', 'set_group', 'set_assignee', 'add_tags', 'remove_tags');
    IF jsonb_array_length(v_field_actions) > 0 THEN
      v_changed := public.fn_apply_field_actions(p_ticket_id, v_field_actions, NULL);
    END IF;

    SELECT * INTO t FROM public.tickets WHERE id = p_ticket_id;
    FOR a IN SELECT * FROM jsonb_array_elements(r.actions) LOOP
      IF a->>'type' = 'email_requester' THEN
        SELECT email INTO v_email FROM public.visitors WHERE id = t.requester_id;
        IF coalesce(v_email, '') <> '' THEN
          INSERT INTO public.automation_outbox (workspace_id, ticket_id, rule_id, kind, payload)
          VALUES (t.workspace_id, t.id, r.id, 'email_requester', jsonb_build_object(
            'to', v_email,
            'subject', public.fn_render_placeholders(a->>'subject', t, t.assignee_id),
            'body', public.fn_render_placeholders(a->>'body', t, t.assignee_id)));
          v_outbound := true;
        END IF;
      ELSIF a->>'type' = 'email_agent' THEN
        SELECT email INTO v_email FROM public.agents WHERE id = t.assignee_id AND coalesce(is_active, true);
        IF coalesce(v_email, '') <> '' THEN
          INSERT INTO public.automation_outbox (workspace_id, ticket_id, rule_id, kind, payload)
          VALUES (t.workspace_id, t.id, r.id, 'email_agent', jsonb_build_object(
            'to', v_email,
            'subject', public.fn_render_placeholders(a->>'subject', t, t.assignee_id),
            'body', public.fn_render_placeholders(a->>'body', t, t.assignee_id)));
          v_outbound := true;
        END IF;
      ELSIF a->>'type' = 'webhook' THEN
        INSERT INTO public.automation_outbox (workspace_id, ticket_id, rule_id, kind, payload)
        VALUES (t.workspace_id, t.id, r.id, 'webhook', jsonb_build_object(
          'url', a->>'url',
          'secret', a->>'secret',
          'event', p_event,
          'rule', jsonb_build_object('id', r.id, 'name', r.name),
          'ticket', jsonb_build_object(
            'id', t.id, 'number', t.number, 'subject', t.subject, 'status', t.status, 'priority', t.priority,
            'type', t.type, 'channel', t.channel, 'tags', to_jsonb(t.tags),
            'assignee_id', t.assignee_id, 'group_id', t.group_id, 'requester_id', t.requester_id,
            'created_at', t.created_at, 'updated_at', t.updated_at)));
        v_outbound := true;
      END IF;
    END LOOP;

    PERFORM public.fn_ticket_restore_actor(v_prev);
    -- A rule that changed nothing (already satisfied) is not worth a log line.
    IF v_changed OR v_outbound THEN
      PERFORM public.fn_log_rule_run(r, p_ticket_id, p_event, 'fired', public.fn_actions_summary(r.actions), NULL);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ticket_restore_actor(v_prev);
    PERFORM public.fn_log_rule_run(r, p_ticket_id, p_event, 'failed', public.fn_actions_summary(r.actions), SQLERRM);
  END;

  PERFORM set_config('zentry.automation_depth', v_depth::text, true);
  -- The once-per-ticket list only needs to span one cascade: when the
  -- outermost rule finishes, the next change starts afresh.
  IF v_depth = 0 THEN
    PERFORM set_config('zentry.automation_fired', '', true);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_fire_rule(public.automation_rules, UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 8. Triggers: run on ticket create/update and on messages
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_run_ticket_triggers(p_ticket_id UUID, p_changed TEXT[], p_message TEXT, p_event TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.tickets;
  r public.automation_rules;
BEGIN
  IF coalesce(nullif(current_setting('zentry.automation_depth', true), '')::int, 0) >= 5 THEN
    RETURN;
  END IF;
  SELECT * INTO t FROM public.tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN RETURN; END IF;

  FOR r IN SELECT * FROM public.automation_rules
            WHERE workspace_id = t.workspace_id AND kind = 'trigger' AND is_active
            ORDER BY position, created_at LOOP
    -- Re-read: an earlier rule may have changed the ticket.
    SELECT * INTO t FROM public.tickets WHERE id = p_ticket_id;
    IF t.status = 'closed' OR t.merged_into_id IS NOT NULL THEN EXIT; END IF;
    IF public.fn_rule_matches(r.conditions, r.match_mode, t, p_message, p_changed) THEN
      PERFORM public.fn_fire_rule(r, p_ticket_id, p_event);
    END IF;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_run_ticket_triggers(UUID, TEXT[], TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_trg_automation_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed TEXT[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.fn_run_ticket_triggers(NEW.id, ARRAY['created'], NULL, 'created');
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN v_changed := array_append(v_changed, 'status'); END IF;
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN v_changed := array_append(v_changed, 'priority'); END IF;
  IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN v_changed := array_append(v_changed, 'assignee'); END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN v_changed := array_append(v_changed, 'group'); END IF;
  IF NEW.tags IS DISTINCT FROM OLD.tags THEN v_changed := array_append(v_changed, 'tags'); END IF;
  IF NEW.subject IS DISTINCT FROM OLD.subject THEN v_changed := array_append(v_changed, 'subject'); END IF;
  IF NEW.type IS DISTINCT FROM OLD.type THEN v_changed := array_append(v_changed, 'type'); END IF;
  IF array_length(v_changed, 1) IS NULL THEN RETURN NEW; END IF;
  PERFORM public.fn_run_ticket_triggers(NEW.id, v_changed, NULL, 'updated');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_automation_ticket ON public.tickets;
CREATE TRIGGER trg_automation_ticket
  AFTER INSERT OR UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_trg_automation_ticket();

-- Named to sort after trg_message_ticket_rules, so the ticket's status rules
-- (reopen on customer reply, assign on first reply) have already run.
CREATE OR REPLACE FUNCTION public.fn_trg_automation_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ticket_id IS NULL OR coalesce(NEW.is_internal, false) THEN
    RETURN NEW;
  END IF;
  IF NEW.sender_type = 'visitor' THEN
    PERFORM public.fn_run_ticket_triggers(NEW.ticket_id, ARRAY['message'], NEW.content, 'message');
  ELSIF NEW.sender_type = 'agent' THEN
    PERFORM public.fn_run_ticket_triggers(NEW.ticket_id, ARRAY['reply'], NULL, 'message');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_zz_automation_message ON public.messages;
CREATE TRIGGER trg_zz_automation_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_trg_automation_message();

-- ----------------------------------------------------------------------------
-- 9. Automations: time-based, run hourly by the cron route
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_run_automations(p_workspace_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.automation_rules;
  t public.tickets;
  v_count INTEGER := 0;
  v_before INTEGER;
BEGIN
  FOR r IN SELECT * FROM public.automation_rules
            WHERE kind = 'automation' AND is_active AND (p_workspace_id IS NULL OR workspace_id = p_workspace_id)
            ORDER BY workspace_id, position, created_at LOOP
    FOR t IN SELECT * FROM public.tickets
              WHERE workspace_id = r.workspace_id AND status <> 'closed' AND merged_into_id IS NULL
              ORDER BY updated_at LIMIT 1000 LOOP
      -- An earlier rule may have changed this ticket; judge it as it is now.
      SELECT * INTO t FROM public.tickets WHERE id = t.id;
      CONTINUE WHEN t.status = 'closed';
      CONTINUE WHEN NOT public.fn_rule_matches(r.conditions, r.match_mode, t, NULL, '{}');
      -- Guard 4: nothing changed since this rule last fired on this ticket.
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.automation_rule_runs
         WHERE rule_id = r.id AND ticket_id = t.id AND outcome = 'fired' AND ticket_version >= t.updated_at);

      SELECT count(*) INTO v_before FROM public.automation_rule_runs WHERE rule_id = r.id AND outcome = 'fired';
      PERFORM public.fn_fire_rule(r, t.id, 'hourly');
      v_count := v_count + (SELECT count(*) FROM public.automation_rule_runs WHERE rule_id = r.id AND outcome = 'fired') - v_before;
    END LOOP;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_run_automations(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_run_automations(UUID) TO service_role;

-- ----------------------------------------------------------------------------
-- 10. Macros: render a reply and apply field changes as the signed-in agent
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_render_macro(p_macro_id UUID, p_ticket_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.tickets;
  m public.macros;
BEGIN
  SELECT * INTO t FROM public.tickets WHERE id = p_ticket_id;
  IF NOT FOUND OR NOT public.fn_role_can(t.workspace_id, 'add_note') THEN
    RAISE EXCEPTION 'Ticket not found.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO m FROM public.macros
   WHERE id = p_macro_id AND workspace_id = t.workspace_id AND is_active AND (owner_id IS NULL OR owner_id = auth.uid());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Macro not found.' USING ERRCODE = '42501';
  END IF;
  RETURN public.fn_render_placeholders(m.content, t, auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_apply_macro(p_macro_id UUID, p_ticket_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.tickets;
  m public.macros;
  v_changed BOOLEAN := false;
BEGIN
  SELECT * INTO t FROM public.tickets WHERE id = p_ticket_id;
  IF NOT FOUND OR NOT public.fn_role_can(t.workspace_id, 'edit_ticket') THEN
    RAISE EXCEPTION 'You cannot change this ticket.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO m FROM public.macros
   WHERE id = p_macro_id AND workspace_id = t.workspace_id AND is_active AND (owner_id IS NULL OR owner_id = auth.uid());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Macro not found.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_array_length(m.actions) > 0 THEN
    -- Written as the agent (auth.uid() stays set), so the ticket's audit log
    -- credits them and the role rules on tickets apply.
    v_changed := public.fn_apply_field_actions(t.id, m.actions, auth.uid());
  END IF;
  RETURN jsonb_build_object('changed', v_changed, 'actions', public.fn_actions_summary(m.actions));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_render_macro(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_apply_macro(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_render_macro(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_apply_macro(UUID, UUID) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 11. Testing a rule against a real ticket, without changing anything
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_test_rule(
  p_workspace_id UUID, p_kind TEXT, p_match TEXT, p_conditions JSONB, p_actions JSONB, p_ticket_number INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.tickets;
  c JSONB;
  v_results JSONB := '[]'::jsonb;
  a JSONB;
  v_previews JSONB := '[]'::jsonb;
  v_ok BOOLEAN;
BEGIN
  IF NOT public.fn_role_can(p_workspace_id, 'manage_settings') THEN
    RAISE EXCEPTION 'Only owners and admins can test rules.' USING ERRCODE = '42501';
  END IF;
  PERFORM public.fn_validate_conditions(p_conditions, p_kind);
  PERFORM public.fn_validate_actions(p_actions, true, false);

  SELECT * INTO t FROM public.tickets WHERE workspace_id = p_workspace_id AND number = p_ticket_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no ticket #% in this workspace.', p_ticket_number USING ERRCODE = 'P0002';
  END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(p_conditions) LOOP
    -- p_changed NULL: "what changed" conditions are assumed true, since a
    -- stored ticket has no event; everything else is judged on its real state.
    v_ok := public.fn_rule_condition_holds(c, t, NULL, NULL);
    v_results := v_results || jsonb_build_array(jsonb_build_object('condition', c, 'holds', v_ok,
      'assumed', c->>'field' = 'changed'));
  END LOOP;

  FOR a IN SELECT * FROM jsonb_array_elements(p_actions) LOOP
    IF a->>'type' IN ('email_requester', 'email_agent') THEN
      v_previews := v_previews || jsonb_build_array(jsonb_build_object(
        'type', a->>'type',
        'subject', public.fn_render_placeholders(a->>'subject', t, t.assignee_id),
        'body', public.fn_render_placeholders(a->>'body', t, t.assignee_id)));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ticket', jsonb_build_object('number', t.number, 'subject', t.subject, 'status', t.status),
    'matches', public.fn_rule_matches(p_conditions, p_match, t, NULL, NULL),
    'conditions', v_results,
    'actions', public.fn_actions_summary(p_actions),
    'email_previews', v_previews);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_test_rule(UUID, TEXT, TEXT, JSONB, JSONB, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_test_rule(UUID, TEXT, TEXT, JSONB, JSONB, INTEGER) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 12. Reordering (one call, so positions never end up half-updated)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_reorder_rules(p_workspace_id UUID, p_kind TEXT, p_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.fn_role_can(p_workspace_id, 'manage_settings') THEN
    RAISE EXCEPTION 'Only owners and admins can reorder rules.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.automation_rules r
     SET position = o.ord::int
    FROM unnest(p_ids) WITH ORDINALITY AS o(id, ord)
   WHERE r.id = o.id AND r.workspace_id = p_workspace_id AND r.kind = p_kind;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_reorder_rules(UUID, TEXT, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_reorder_rules(UUID, TEXT, UUID[]) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 13. Default rules and macros
-- ----------------------------------------------------------------------------

-- Seeds recommended rules for a workspace that has none. Rules that email
-- customers or agents start switched off: they need SMTP and a decision.
CREATE OR REPLACE FUNCTION public.fn_seed_default_automation(p_workspace_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.automation_rules WHERE workspace_id = p_workspace_id) THEN
    INSERT INTO public.automation_rules (workspace_id, kind, name, description, is_active, position, match_mode, conditions, actions) VALUES
    (p_workspace_id, 'trigger', 'Raise priority for urgent wording',
     'When a customer writes “urgent”, “asap” or “outage”, mark the ticket urgent and tag it.', true, 1, 'all',
     '[{"field":"changed","op":"is","value":"message"},
       {"field":"message","op":"contains","value":"urgent, asap, emergency, outage, down for everyone"},
       {"field":"priority","op":"in","value":["low","normal","high"]}]',
     '[{"type":"set_priority","value":"urgent"},{"type":"add_tags","value":["urgent"]}]'),
    (p_workspace_id, 'trigger', 'Tag billing questions',
     'Adds the “billing” tag when a customer mentions an invoice, refund or payment.', true, 2, 'all',
     '[{"field":"changed","op":"is","value":"message"},
       {"field":"message","op":"contains","value":"invoice, refund, payment, charged, billing, subscription"},
       {"field":"tags","op":"not_contains","value":["billing"]}]',
     '[{"type":"add_tags","value":["billing"]}]'),
    (p_workspace_id, 'trigger', 'Tell the assignee when the customer replies',
     'Emails the assigned agent when the customer writes back. Needs SMTP; switched off until you enable it.', false, 3, 'all',
     '[{"field":"changed","op":"is","value":"message"},{"field":"assignee_id","op":"is_not_empty"}]',
     '[{"type":"email_agent","subject":"New reply on #{{ticket.id}}: {{ticket.subject}}","body":"{{ticket.requester.name}} replied on ticket #{{ticket.id}}.\n\nOpen your inbox to answer."}]'),
    (p_workspace_id, 'trigger', 'Confirm to the customer when solved',
     'Emails the requester when a ticket is marked solved. Needs SMTP; switched off until you enable it.', false, 4, 'all',
     '[{"field":"changed","op":"is","value":"status"},{"field":"status","op":"is","value":"solved"},{"field":"requester_email","op":"is_not_empty"}]',
     '[{"type":"email_requester","subject":"Your request #{{ticket.id}} was solved","body":"Hi {{ticket.requester.name}},\n\nWe marked request #{{ticket.id}} as solved. If it is not, just reply to reopen it.\n\n{{workspace.name}}"}]'),
    (p_workspace_id, 'automation', 'Raise priority when unassigned for an hour',
     'A new or open ticket nobody has picked up after an hour becomes high priority.', true, 1, 'all',
     '[{"field":"assignee_id","op":"is_empty"},{"field":"status","op":"in","value":["new","open"]},
       {"field":"priority","op":"in","value":["low","normal"]},{"field":"hours_since_created","op":"gte","value":1}]',
     '[{"type":"set_priority","value":"high"},{"type":"add_tags","value":["escalated"]}]'),
    (p_workspace_id, 'automation', 'Remind the customer after 3 days pending',
     'Emails the requester once when a ticket has waited for them for 3 days. Needs SMTP; switched off until you enable it.', false, 2, 'all',
     '[{"field":"status","op":"is","value":"pending"},{"field":"hours_since_status_change","op":"gte","value":72},
       {"field":"tags","op":"not_contains","value":["reminded"]},{"field":"requester_email","op":"is_not_empty"}]',
     '[{"type":"email_requester","subject":"Still need help with #{{ticket.id}}?","body":"Hi {{ticket.requester.name}},\n\nWe are waiting for your reply on request #{{ticket.id}}. Reply to this email and we will pick it up.\n\n{{workspace.name}}"},{"type":"add_tags","value":["reminded"]}]');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.macros WHERE workspace_id = p_workspace_id AND owner_id IS NULL) THEN
    INSERT INTO public.macros (workspace_id, owner_id, title, content, actions, position) VALUES
    (p_workspace_id, NULL, 'Thanks, solved',
     E'Hi {{ticket.requester.name}},\n\nThanks for getting in touch. I have marked request #{{ticket.id}} as solved. Reply here if you need anything else.\n\n{{agent.name}}',
     '[{"type":"set_status","value":"solved"}]', 1),
    (p_workspace_id, NULL, 'Need more information',
     E'Hi {{ticket.requester.name}},\n\nThanks for your message. Could you share a few more details so I can look into it?\n\n{{agent.name}}',
     '[{"type":"set_status","value":"pending"}]', 2),
    (p_workspace_id, NULL, 'Escalating to a specialist',
     E'Hi {{ticket.requester.name}},\n\nI am passing request #{{ticket.id}} to a colleague who can help further. You will hear back soon.\n\n{{agent.name}}',
     '[{"type":"set_priority","value":"high"},{"type":"add_tags","value":["escalated"]}]', 3);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_seed_default_automation(UUID) FROM PUBLIC, anon, authenticated;

-- Admins of a workspace created before this migration can add the defaults
-- from the empty state. Does nothing if they already have rules.
CREATE OR REPLACE FUNCTION public.fn_install_default_automation(p_workspace_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.fn_role_can(p_workspace_id, 'manage_settings') THEN
    RAISE EXCEPTION 'Only owners and admins can add the recommended rules.' USING ERRCODE = '42501';
  END IF;
  PERFORM public.fn_seed_default_automation(p_workspace_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_install_default_automation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_install_default_automation(UUID) TO authenticated, service_role;

-- New workspaces start with the defaults. Existing ones are left alone: this
-- migration must not switch on rules in a live workspace unasked.
CREATE OR REPLACE FUNCTION public.fn_trg_seed_workspace_automation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_seed_default_automation(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_workspace_automation ON public.workspaces;
CREATE TRIGGER trg_seed_workspace_automation
  AFTER INSERT ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.fn_trg_seed_workspace_automation();
