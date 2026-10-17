-- ============================================================================
-- Customer satisfaction (CSAT) and Reporting Events
-- Migration: 20261018090000_csat_and_reports.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CSAT columns on tickets
-- ----------------------------------------------------------------------------

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS csat_rating TEXT,
  ADD COLUMN IF NOT EXISTS csat_comment TEXT,
  ADD COLUMN IF NOT EXISTS csat_rated_at TIMESTAMPTZ;

ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_csat_rating_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_csat_rating_check
  CHECK (csat_rating IS NULL OR csat_rating IN ('good', 'bad'));

CREATE INDEX IF NOT EXISTS idx_tickets_csat_rating
  ON public.tickets (workspace_id, csat_rating)
  WHERE csat_rating IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. CSAT settings on workspaces
-- ----------------------------------------------------------------------------

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS csat_settings JSONB NOT NULL
  DEFAULT '{"enabled": true, "ask_chat": true, "ask_email": true, "survey_prompt": "How would you rate your support experience?"}'::jsonb;

-- ----------------------------------------------------------------------------
-- 3. Reporting Events table (for fast event-driven metrics without scanning tickets)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.reporting_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id        UUID REFERENCES public.tickets(id) ON DELETE CASCADE,
  -- Event types that represent lifecycle milestones:
  -- ticket_created, ticket_solved, ticket_reopened, first_reply, csat_rated, bot_resolved, bot_handover
  event_type       TEXT NOT NULL CHECK (event_type IN (
    'ticket_created',
    'ticket_solved',
    'ticket_reopened',
    'first_reply',
    'csat_rated',
    'bot_resolved',
    'bot_handover'
  )),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  agent_id         UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  group_id         UUID REFERENCES public.ticket_groups(id) ON DELETE SET NULL,
  channel          TEXT,
  priority         TEXT,
  tags             TEXT[] NOT NULL DEFAULT '{}',
  duration_seconds INTEGER,
  csat_rating      TEXT CHECK (csat_rating IS NULL OR csat_rating IN ('good', 'bad')),
  csat_comment     TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_reporting_events_ws_time
  ON public.reporting_events (workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_reporting_events_ws_type_time
  ON public.reporting_events (workspace_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_reporting_events_ticket
  ON public.reporting_events (ticket_id);

CREATE INDEX IF NOT EXISTS idx_reporting_events_agent
  ON public.reporting_events (workspace_id, agent_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_reporting_events_group
  ON public.reporting_events (workspace_id, group_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_reporting_events_channel
  ON public.reporting_events (workspace_id, channel, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- 4. Row Level Security for reporting_events
-- ----------------------------------------------------------------------------

ALTER TABLE public.reporting_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reporting_events_select ON public.reporting_events;
CREATE POLICY reporting_events_select ON public.reporting_events FOR SELECT TO authenticated
  USING (public.fn_ticket_member(workspace_id));

-- Revoke direct writes from client roles (only triggers and service role write)
REVOKE INSERT, UPDATE, DELETE ON public.reporting_events FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. Trigger functions to emit reporting events
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ticket_emit_reporting_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res_secs INTEGER;
  v_frt_secs INTEGER;
  v_has_human_reply BOOLEAN;
  v_has_bot_msg BOOLEAN;
BEGIN
  -- 1. Ticket created event
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.reporting_events (
      workspace_id, ticket_id, event_type, occurred_at,
      agent_id, group_id, channel, priority, tags
    ) VALUES (
      NEW.workspace_id, NEW.id, 'ticket_created', NEW.created_at,
      NEW.assignee_id, NEW.group_id, NEW.channel, NEW.priority, NEW.tags
    );
    RETURN NEW;
  END IF;

  -- 2. First reply event
  IF OLD.first_agent_reply_at IS NULL AND NEW.first_agent_reply_at IS NOT NULL THEN
    v_frt_secs := GREATEST(0, extract(epoch FROM (NEW.first_agent_reply_at - NEW.created_at))::int);
    INSERT INTO public.reporting_events (
      workspace_id, ticket_id, event_type, occurred_at,
      agent_id, group_id, channel, priority, tags, duration_seconds
    ) VALUES (
      NEW.workspace_id, NEW.id, 'first_reply', NEW.first_agent_reply_at,
      NEW.assignee_id, NEW.group_id, NEW.channel, NEW.priority, NEW.tags, v_frt_secs
    );
  END IF;

  -- 3. Solved / Reopened events
  IF NEW.status = 'solved' AND (OLD.status IS DISTINCT FROM 'solved') THEN
    v_res_secs := GREATEST(0, extract(epoch FROM (coalesce(NEW.solved_at, now()) - NEW.created_at))::int);
    INSERT INTO public.reporting_events (
      workspace_id, ticket_id, event_type, occurred_at,
      agent_id, group_id, channel, priority, tags, duration_seconds
    ) VALUES (
      NEW.workspace_id, NEW.id, 'ticket_solved', coalesce(NEW.solved_at, now()),
      NEW.assignee_id, NEW.group_id, NEW.channel, NEW.priority, NEW.tags, v_res_secs
    );

    -- Check if this was solved by AI Bot (no human agent reply ever sent, and bot replied)
    IF NEW.first_agent_reply_at IS NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.messages
        WHERE ticket_id = NEW.id AND sender_type = 'ai'
      ) INTO v_has_bot_msg;

      IF v_has_bot_msg THEN
        INSERT INTO public.reporting_events (
          workspace_id, ticket_id, event_type, occurred_at,
          agent_id, group_id, channel, priority, tags
        ) VALUES (
          NEW.workspace_id, NEW.id, 'bot_resolved', coalesce(NEW.solved_at, now()),
          NEW.assignee_id, NEW.group_id, NEW.channel, NEW.priority, NEW.tags
        );
      END IF;
    END IF;

  ELSIF OLD.status = 'solved' AND NEW.status = 'open' THEN
    INSERT INTO public.reporting_events (
      workspace_id, ticket_id, event_type, occurred_at,
      agent_id, group_id, channel, priority, tags
    ) VALUES (
      NEW.workspace_id, NEW.id, 'ticket_reopened', coalesce(NEW.status_changed_at, now()),
      NEW.assignee_id, NEW.group_id, NEW.channel, NEW.priority, NEW.tags
    );
  END IF;

  -- 4. CSAT rated event
  IF NEW.csat_rating IS NOT NULL AND (OLD.csat_rating IS DISTINCT FROM NEW.csat_rating OR OLD.csat_comment IS DISTINCT FROM NEW.csat_comment) THEN
    INSERT INTO public.reporting_events (
      workspace_id, ticket_id, event_type, occurred_at,
      agent_id, group_id, channel, priority, tags,
      csat_rating, csat_comment
    ) VALUES (
      NEW.workspace_id, NEW.id, 'csat_rated', coalesce(NEW.csat_rated_at, now()),
      NEW.assignee_id, NEW.group_id, NEW.channel, NEW.priority, NEW.tags,
      NEW.csat_rating, NEW.csat_comment
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_reporting ON public.tickets;
CREATE TRIGGER trg_ticket_reporting
  AFTER INSERT OR UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ticket_emit_reporting_events();

-- Trigger on messages to capture bot handover
CREATE OR REPLACE FUNCTION public.fn_message_emit_reporting_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets;
BEGIN
  -- Detect AI handover note or event
  IF NEW.sender_type = 'ai' AND NEW.ticket_id IS NOT NULL THEN
    IF (NEW.metadata->>'is_handover')::boolean = true OR NEW.metadata->>'reason' IS NOT NULL THEN
      SELECT * INTO v_ticket FROM public.tickets WHERE id = NEW.ticket_id;
      IF FOUND THEN
        INSERT INTO public.reporting_events (
          workspace_id, ticket_id, event_type, occurred_at,
          agent_id, group_id, channel, priority, tags,
          metadata
        ) VALUES (
          v_ticket.workspace_id, v_ticket.id, 'bot_handover', NEW.created_at,
          v_ticket.assignee_id, v_ticket.group_id, v_ticket.channel, v_ticket.priority, v_ticket.tags,
          jsonb_build_object('reason', NEW.metadata->>'reason')
        );
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_message_reporting ON public.messages;
CREATE TRIGGER trg_message_reporting
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_message_emit_reporting_events();

-- ----------------------------------------------------------------------------
-- 5b. Allow CSAT updates on closed tickets in fn_ticket_before_update
-- ----------------------------------------------------------------------------

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
    -- Allow recording CSAT ratings and comments on closed tickets without reopening
    IF (to_jsonb(NEW) - 'csat_rating' - 'csat_comment' - 'csat_rated_at' - 'updated_at')
       = (to_jsonb(OLD) - 'csat_rating' - 'csat_comment' - 'csat_rated_at' - 'updated_at') THEN
      RETURN NEW;
    END IF;
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

-- ----------------------------------------------------------------------------
-- 6. Backfill reporting events for existing tickets
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  -- Backfill ticket_created
  INSERT INTO public.reporting_events (
    workspace_id, ticket_id, event_type, occurred_at,
    agent_id, group_id, channel, priority, tags
  )
  SELECT
    t.workspace_id, t.id, 'ticket_created', t.created_at,
    t.assignee_id, t.group_id, t.channel, t.priority, t.tags
  FROM public.tickets t
  WHERE NOT EXISTS (
    SELECT 1 FROM public.reporting_events re
    WHERE re.ticket_id = t.id AND re.event_type = 'ticket_created'
  );

  -- Backfill first_reply
  INSERT INTO public.reporting_events (
    workspace_id, ticket_id, event_type, occurred_at,
    agent_id, group_id, channel, priority, tags, duration_seconds
  )
  SELECT
    t.workspace_id, t.id, 'first_reply', t.first_agent_reply_at,
    t.assignee_id, t.group_id, t.channel, t.priority, t.tags,
    GREATEST(0, extract(epoch FROM (t.first_agent_reply_at - t.created_at))::int)
  FROM public.tickets t
  WHERE t.first_agent_reply_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.reporting_events re
    WHERE re.ticket_id = t.id AND re.event_type = 'first_reply'
  );

  -- Backfill ticket_solved
  INSERT INTO public.reporting_events (
    workspace_id, ticket_id, event_type, occurred_at,
    agent_id, group_id, channel, priority, tags, duration_seconds
  )
  SELECT
    t.workspace_id, t.id, 'ticket_solved', coalesce(t.solved_at, t.closed_at, t.updated_at),
    t.assignee_id, t.group_id, t.channel, t.priority, t.tags,
    GREATEST(0, extract(epoch FROM (coalesce(t.solved_at, t.closed_at, t.updated_at) - t.created_at))::int)
  FROM public.tickets t
  WHERE t.status IN ('solved', 'closed')
  AND NOT EXISTS (
    SELECT 1 FROM public.reporting_events re
    WHERE re.ticket_id = t.id AND re.event_type = 'ticket_solved'
  );

  -- Backfill csat_rated from conversations if conversations had csat ratings
  INSERT INTO public.reporting_events (
    workspace_id, ticket_id, event_type, occurred_at,
    agent_id, group_id, channel, priority, tags,
    csat_rating, csat_comment
  )
  SELECT
    t.workspace_id, t.id, 'csat_rated', coalesce(c.updated_at, t.updated_at),
    t.assignee_id, t.group_id, t.channel, t.priority, t.tags,
    CASE WHEN c.csat_rating >= 4 THEN 'good' ELSE 'bad' END,
    c.csat_feedback
  FROM public.tickets t
  JOIN public.conversations c ON c.id = t.conversation_id
  WHERE c.csat_rating IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.reporting_events re
    WHERE re.ticket_id = t.id AND re.event_type = 'csat_rated'
  );

  -- Also sync conversation csat into tickets table if not already set
  UPDATE public.tickets t
  SET csat_rating = CASE WHEN c.csat_rating >= 4 THEN 'good' ELSE 'bad' END,
      csat_comment = c.csat_feedback,
      csat_rated_at = coalesce(c.updated_at, t.updated_at)
  FROM public.conversations c
  WHERE t.conversation_id = c.id
    AND c.csat_rating IS NOT NULL
    AND t.csat_rating IS NULL
    AND t.status <> 'closed';

END $$;
