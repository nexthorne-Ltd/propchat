-- ============================================================================
-- Ticketing: every conversation is worked as a ticket
--
-- Conversations were a chat transport with a status of open/closed/snoozed.
-- Support teams need what Zendesk gives them: a numbered ticket per request
-- with a subject, a type, a group, a requester, a lifecycle with rules, saved
-- views, and a record of who changed what.
--
-- Model
--   tickets            the unit of work. Numbered per workspace from #1001.
--   messages.ticket_id the thread of a ticket. A conversation (the chat the
--                      widget is attached to) can carry several tickets over
--                      time: a reply to a closed ticket starts a follow-up
--                      ticket on the same conversation, so the visitor's chat
--                      keeps working and the closed ticket stays untouched.
--   conversations.current_ticket_id  where the next message goes.
--   ticket_events      append-only audit log, written by triggers only.
--   ticket_groups      teams a ticket can be routed to.
--   ticket_views       saved inbox views (filters + sort), personal or shared.
--
-- Status rules live in triggers, so they hold whoever writes: the widget (as
-- anon), the bot (service role), the old inbox and the new ticket screens:
--   new      -> open     when an agent replies publicly or the ticket is assigned
--   pending/solved -> open  when the customer replies
--   solved   -> closed   after 4 days (fn_close_solved_tickets, run by cron)
--   closed               read-only; a new message starts a follow-up ticket
--   pending              set by an agent when waiting on the customer
--
-- The old inbox and the bot keep using conversations.status / priority /
-- assigned_agent_id / tags. Those are kept in step with the conversation's
-- current ticket in both directions, guarded so a sync never echoes back.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ticket_groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_groups_workspace_name
  ON public.ticket_groups (workspace_id, lower(name));

-- One row per workspace, locked while a number is taken, so two tickets
-- created at the same moment can never share a number.
CREATE TABLE IF NOT EXISTS public.ticket_counters (
  workspace_id UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  last_number  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public.tickets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  number                INTEGER NOT NULL,
  conversation_id       UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  subject               TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new', 'open', 'pending', 'on_hold', 'solved', 'closed')),
  priority              TEXT NOT NULL DEFAULT 'normal'
                          CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  type                  TEXT NOT NULL DEFAULT 'question'
                          CHECK (type IN ('question', 'incident', 'problem', 'task')),
  assignee_id           UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  group_id              UUID REFERENCES public.ticket_groups(id) ON DELETE SET NULL,
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  requester_id          UUID REFERENCES public.visitors(id) ON DELETE SET NULL,
  channel               TEXT NOT NULL DEFAULT 'chat' CHECK (channel IN ('chat', 'email', 'web_form')),
  follow_up_of_id       UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  merged_into_id        UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_changed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  solved_at             TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  first_agent_reply_at  TIMESTAMPTZ,
  last_agent_reply_at   TIMESTAMPTZ,
  last_customer_reply_at TIMESTAMPTZ,
  -- Sort keys: text sorts "urgent" before "high", which is not what anyone means.
  status_rank   SMALLINT GENERATED ALWAYS AS (
    CASE status WHEN 'new' THEN 1 WHEN 'open' THEN 2 WHEN 'pending' THEN 3
                WHEN 'on_hold' THEN 4 WHEN 'solved' THEN 5 ELSE 6 END) STORED,
  priority_rank SMALLINT GENERATED ALWAYS AS (
    CASE priority WHEN 'low' THEN 1 WHEN 'normal' THEN 2 WHEN 'high' THEN 3 ELSE 4 END) STORED,
  CONSTRAINT tickets_workspace_number UNIQUE (workspace_id, number)
);

CREATE INDEX IF NOT EXISTS tickets_workspace_status_updated ON public.tickets (workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS tickets_workspace_assignee ON public.tickets (workspace_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS tickets_workspace_group ON public.tickets (workspace_id, group_id);
CREATE INDEX IF NOT EXISTS tickets_requester ON public.tickets (requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_conversation ON public.tickets (conversation_id);
CREATE INDEX IF NOT EXISTS tickets_tags ON public.tickets USING gin (tags);
CREATE INDEX IF NOT EXISTS tickets_solved_due ON public.tickets (solved_at) WHERE status = 'solved';
CREATE INDEX IF NOT EXISTS tickets_follow_up_of ON public.tickets (follow_up_of_id) WHERE follow_up_of_id IS NOT NULL;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS current_ticket_id UUID REFERENCES public.tickets(id) ON DELETE SET NULL;
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES public.tickets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_ticket_created ON public.messages (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS public.ticket_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id    UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- agent: actor_id is an agent; customer: actor_id is the visitor;
  -- system: cron, migration or server automation; bot: the AI assistant.
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('agent', 'customer', 'system', 'bot')),
  actor_id     UUID,
  -- created | updated | public_reply | internal_note | merged | follow_up_created
  action       TEXT NOT NULL,
  field        TEXT,
  old_value    TEXT,
  new_value    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS ticket_events_ticket ON public.ticket_events (ticket_id, id);

CREATE TABLE IF NOT EXISTS public.ticket_views (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- NULL: shared with the whole workspace. Otherwise personal to this agent.
  owner_id     UUID REFERENCES public.agents(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  filters      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  sort         JSONB NOT NULL DEFAULT '{"field": "updated_at", "direction": "desc"}'::jsonb
                 CHECK (jsonb_typeof(sort) = 'object'),
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_views_workspace ON public.ticket_views (workspace_id, position);

-- ----------------------------------------------------------------------------
-- 2. Access helpers
--
-- Deliberately not fn_is_workspace_member / is_current_user_super_admin: the
-- latter is true for every caller (docs/AUDIT.md H-2), and tickets must not
-- inherit that. These read the super-admin flag itself.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ticket_member(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.agents a
             WHERE a.id = auth.uid() AND (a.workspace_id = p_workspace_id OR a.is_super_admin))
    OR EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.owner_id = auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION public.fn_ticket_admin(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.agents a
             WHERE a.id = auth.uid()
               AND ((a.workspace_id = p_workspace_id AND a.role IN ('owner', 'admin')) OR a.is_super_admin))
    OR EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.owner_id = auth.uid())
  );
$$;

REVOKE EXECUTE ON FUNCTION public.fn_ticket_member(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_ticket_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ticket_member(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ticket_admin(UUID) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Who is acting
--
-- Trigger code that changes a ticket on someone's behalf (a customer message
-- reopening it, a cron closing it) says so through transaction-local settings;
-- otherwise the signed-in agent is the actor, an anonymous caller is the
-- customer, and anything else is the system.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ticket_actor(OUT actor_type TEXT, OUT actor_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  actor_type := nullif(current_setting('zentry.actor_type', true), '');
  IF actor_type IS NOT NULL THEN
    actor_id := nullif(current_setting('zentry.actor_id', true), '')::uuid;
    RETURN;
  END IF;
  IF auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.agents WHERE id = auth.uid()) THEN
    actor_type := 'agent';
    actor_id := auth.uid();
  ELSIF coalesce(auth.role(), '') = 'anon' THEN
    actor_type := 'customer';
  ELSE
    actor_type := 'system';
  END IF;
END;
$$;

-- Runs `p_sql`-free updates under a named actor: callers set, act, restore.
CREATE OR REPLACE FUNCTION public.fn_ticket_set_actor(p_type TEXT, p_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev TEXT := coalesce(current_setting('zentry.actor_type', true), '') || '|' ||
                 coalesce(current_setting('zentry.actor_id', true), '');
BEGIN
  PERFORM set_config('zentry.actor_type', coalesce(p_type, ''), true);
  PERFORM set_config('zentry.actor_id', coalesce(p_id::text, ''), true);
  RETURN v_prev;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ticket_restore_actor(p_prev TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('zentry.actor_type', split_part(coalesce(p_prev, '|'), '|', 1), true);
  PERFORM set_config('zentry.actor_id', split_part(coalesce(p_prev, '|'), '|', 2), true);
END;
$$;

-- Internal: only trigger and definer code may name an actor or write the log.
-- Callable over the API, fn_ticket_log would let anyone forge audit entries.
REVOKE EXECUTE ON FUNCTION public.fn_ticket_actor() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ticket_set_actor(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ticket_restore_actor(TEXT) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Ticket lifecycle triggers
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ticket_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.ticket_counters AS c (workspace_id, last_number)
  VALUES (NEW.workspace_id, 1001)
  ON CONFLICT (workspace_id) DO UPDATE SET last_number = c.last_number + 1
  RETURNING last_number INTO NEW.number;

  IF NEW.status = 'new' AND NEW.assignee_id IS NOT NULL THEN
    NEW.status := 'open';
  END IF;
  NEW.subject := left(trim(coalesce(NEW.subject, '')), 250);
  NEW.tags := coalesce(NEW.tags, '{}');
  NEW.status_changed_at := coalesce(NEW.status_changed_at, now());
  IF NEW.status = 'solved' THEN NEW.solved_at := coalesce(NEW.solved_at, now()); END IF;
  IF NEW.status = 'closed' THEN
    NEW.solved_at := coalesce(NEW.solved_at, now());
    NEW.closed_at := coalesce(NEW.closed_at, now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_before_insert ON public.tickets;
CREATE TRIGGER trg_ticket_before_insert
  BEFORE INSERT ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ticket_before_insert();

CREATE OR REPLACE FUNCTION public.fn_ticket_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_internal BOOLEAN := coalesce(current_setting('zentry.ticket_internal', true), '') = 'on';
BEGIN
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
    NEW.status_changed_at := now();
    IF NEW.status = 'solved' THEN
      NEW.solved_at := now();
    ELSIF NEW.status = 'closed' THEN
      NEW.solved_at := coalesce(OLD.solved_at, now());
      NEW.closed_at := now();
    ELSE
      -- Reopened: it is no longer "recently solved".
      NEW.solved_at := NULL;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_before_update ON public.tickets;
CREATE TRIGGER trg_ticket_before_update
  BEFORE UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ticket_before_update();

CREATE OR REPLACE FUNCTION public.fn_ticket_before_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'closed' AND coalesce(current_setting('zentry.ticket_internal', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Ticket #% is closed and read-only.', OLD.number USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_before_delete ON public.tickets;
CREATE TRIGGER trg_ticket_before_delete
  BEFORE DELETE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ticket_before_delete();

-- ----------------------------------------------------------------------------
-- 5. Audit log
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ticket_log(
  p_ticket public.tickets, p_action TEXT, p_field TEXT, p_old TEXT, p_new TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor RECORD;
BEGIN
  SELECT * INTO v_actor FROM public.fn_ticket_actor();
  INSERT INTO public.ticket_events (ticket_id, workspace_id, actor_type, actor_id, action, field, old_value, new_value)
  VALUES (p_ticket.id, p_ticket.workspace_id, v_actor.actor_type, v_actor.actor_id, p_action, p_field, p_old, p_new);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_ticket_log(public.tickets, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ticket_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.fn_ticket_log(NEW, 'created', 'status', NULL, NEW.status);
    RETURN NEW;
  END IF;

  IF NEW.subject IS DISTINCT FROM OLD.subject THEN
    PERFORM public.fn_ticket_log(NEW, 'updated', 'subject', OLD.subject, NEW.subject);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.fn_ticket_log(NEW, 'updated', 'status', OLD.status, NEW.status);
  END IF;
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    PERFORM public.fn_ticket_log(NEW, 'updated', 'priority', OLD.priority, NEW.priority);
  END IF;
  IF NEW.type IS DISTINCT FROM OLD.type THEN
    PERFORM public.fn_ticket_log(NEW, 'updated', 'type', OLD.type, NEW.type);
  END IF;
  IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
    PERFORM public.fn_ticket_log(NEW, 'updated', 'assignee_id', OLD.assignee_id::text, NEW.assignee_id::text);
  END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    PERFORM public.fn_ticket_log(NEW, 'updated', 'group_id', OLD.group_id::text, NEW.group_id::text);
  END IF;
  IF NEW.tags IS DISTINCT FROM OLD.tags THEN
    PERFORM public.fn_ticket_log(NEW, 'updated', 'tags', array_to_string(OLD.tags, ', '), array_to_string(NEW.tags, ', '));
  END IF;
  IF NEW.requester_id IS DISTINCT FROM OLD.requester_id THEN
    PERFORM public.fn_ticket_log(NEW, 'updated', 'requester_id', OLD.requester_id::text, NEW.requester_id::text);
  END IF;
  IF NEW.channel IS DISTINCT FROM OLD.channel THEN
    PERFORM public.fn_ticket_log(NEW, 'updated', 'channel', OLD.channel, NEW.channel);
  END IF;
  IF NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    PERFORM public.fn_ticket_log(NEW, 'merged', 'merged_into_id', OLD.merged_into_id::text, NEW.merged_into_id::text);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_audit ON public.tickets;
CREATE TRIGGER trg_ticket_audit
  AFTER INSERT OR UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ticket_audit();

-- ----------------------------------------------------------------------------
-- 6. Keeping conversations and their current ticket in step
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ticket_status_to_conversation(p_status TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_status
    WHEN 'pending' THEN 'pending'
    WHEN 'solved' THEN 'closed'
    WHEN 'closed' THEN 'closed'
    ELSE 'open'
  END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ticket_sync_to_conversation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF coalesce(current_setting('zentry.ticket_syncing', true), '') = 'on' OR NEW.conversation_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.priority IS NOT DISTINCT FROM OLD.priority
     AND NEW.assignee_id IS NOT DISTINCT FROM OLD.assignee_id
     AND NEW.tags IS NOT DISTINCT FROM OLD.tags THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('zentry.ticket_syncing', 'on', true);
  UPDATE public.conversations c
     SET status = public.fn_ticket_status_to_conversation(NEW.status),
         priority = NEW.priority,
         assigned_agent_id = NEW.assignee_id,
         tags = NEW.tags,
         updated_at = now()
   WHERE c.id = NEW.conversation_id
     AND c.current_ticket_id = NEW.id
     AND c.workspace_id = NEW.workspace_id;
  PERFORM set_config('zentry.ticket_syncing', '', true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_sync_to_conversation ON public.tickets;
CREATE TRIGGER trg_ticket_sync_to_conversation
  AFTER UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ticket_sync_to_conversation();

-- The old inbox, the bot's handover and the auto-assign route still write to
-- conversations. Their changes become ticket changes.
CREATE OR REPLACE FUNCTION public.fn_conversation_sync_to_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets;
  v_status TEXT;
BEGIN
  IF coalesce(current_setting('zentry.ticket_syncing', true), '') = 'on' OR NEW.current_ticket_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_ticket FROM public.tickets WHERE id = NEW.current_ticket_id;
  IF NOT FOUND OR v_ticket.status = 'closed' THEN
    RETURN NEW;
  END IF;

  v_status := v_ticket.status;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_status := CASE NEW.status
      WHEN 'closed' THEN 'solved'
      WHEN 'pending' THEN 'pending'
      WHEN 'snoozed' THEN 'on_hold'
      -- "open" reopens a waiting ticket; a new one stays new until picked up.
      ELSE CASE WHEN v_ticket.status IN ('pending', 'on_hold', 'solved') THEN 'open' ELSE v_ticket.status END
    END;
  END IF;

  PERFORM set_config('zentry.ticket_syncing', 'on', true);
  UPDATE public.tickets
     SET status = v_status,
         priority = CASE WHEN NEW.priority IS DISTINCT FROM OLD.priority THEN NEW.priority ELSE priority END,
         assignee_id = CASE WHEN NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
                            THEN NEW.assigned_agent_id ELSE assignee_id END,
         tags = CASE WHEN NEW.tags IS DISTINCT FROM OLD.tags THEN coalesce(NEW.tags, '{}') ELSE tags END
   WHERE id = v_ticket.id;
  PERFORM set_config('zentry.ticket_syncing', '', true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_sync_to_ticket ON public.conversations;
CREATE TRIGGER trg_conversation_sync_to_ticket
  AFTER UPDATE OF status, priority, assigned_agent_id, tags ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.fn_conversation_sync_to_ticket();

-- ----------------------------------------------------------------------------
-- 7. Creating tickets
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_open_ticket_for_conversation(
  p_conversation_id UUID,
  p_follow_up_of public.tickets DEFAULT NULL
)
RETURNS public.tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations;
  v_ticket public.tickets;
  v_channel TEXT;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conversation_id;
  IF NOT FOUND OR v_conv.workspace_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_follow_up_of.id IS NOT NULL THEN
    INSERT INTO public.tickets (workspace_id, conversation_id, subject, priority, type, group_id, tags,
                                requester_id, channel, follow_up_of_id)
    VALUES (v_conv.workspace_id, v_conv.id, p_follow_up_of.subject, p_follow_up_of.priority,
            p_follow_up_of.type, p_follow_up_of.group_id, p_follow_up_of.tags,
            p_follow_up_of.requester_id, p_follow_up_of.channel, p_follow_up_of.id)
    RETURNING * INTO v_ticket;
    PERFORM public.fn_ticket_log(v_ticket, 'follow_up_created', 'follow_up_of_id', NULL, '#' || p_follow_up_of.number);
  ELSE
    v_channel := coalesce(v_conv.channel_metadata ->> 'ticket_channel', 'chat');
    IF v_channel NOT IN ('chat', 'email', 'web_form') THEN v_channel := 'chat'; END IF;
    INSERT INTO public.tickets (workspace_id, conversation_id, subject, priority, type, assignee_id, tags,
                                requester_id, channel)
    VALUES (v_conv.workspace_id, v_conv.id, coalesce(v_conv.channel_metadata ->> 'ticket_subject', ''),
            coalesce(v_conv.priority, 'normal'),
            CASE WHEN v_conv.channel_metadata ->> 'ticket_type' IN ('question', 'incident', 'problem', 'task')
                 THEN v_conv.channel_metadata ->> 'ticket_type' ELSE 'question' END,
            v_conv.assigned_agent_id, coalesce(v_conv.tags, '{}'), v_conv.visitor_id, v_channel)
    RETURNING * INTO v_ticket;
  END IF;

  PERFORM set_config('zentry.ticket_syncing', 'on', true);
  UPDATE public.conversations
     SET current_ticket_id = v_ticket.id,
         assigned_agent_id = v_ticket.assignee_id,
         priority = v_ticket.priority,
         tags = v_ticket.tags
   WHERE id = v_conv.id;
  PERFORM set_config('zentry.ticket_syncing', '', true);
  RETURN v_ticket;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_open_ticket_for_conversation(UUID, public.tickets) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_conversation_create_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev TEXT;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.current_ticket_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- The widget creates conversations anonymously: that is the customer.
  IF auth.uid() IS NULL AND coalesce(auth.role(), '') = 'anon' THEN
    v_prev := public.fn_ticket_set_actor('customer', NEW.visitor_id);
    PERFORM public.fn_open_ticket_for_conversation(NEW.id);
    PERFORM public.fn_ticket_restore_actor(v_prev);
  ELSE
    PERFORM public.fn_open_ticket_for_conversation(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_create_ticket ON public.conversations;
CREATE TRIGGER trg_conversation_create_ticket
  AFTER INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.fn_conversation_create_ticket();

-- ----------------------------------------------------------------------------
-- 8. Messages: which ticket, and what they change
-- ----------------------------------------------------------------------------

-- Before a message is stored: attach it to the right ticket. A closed ticket
-- never receives it; a merged ticket hands it to the ticket it went into.
CREATE OR REPLACE FUNCTION public.fn_message_assign_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations;
  v_ticket public.tickets;
  v_follow public.tickets;
  v_hops INT := 0;
  v_prev TEXT;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND OR v_conv.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.ticket_id IS NOT NULL THEN
    SELECT * INTO v_ticket FROM public.tickets
     WHERE id = NEW.ticket_id AND workspace_id = v_conv.workspace_id;
  END IF;
  IF v_ticket.id IS NULL AND v_conv.current_ticket_id IS NOT NULL THEN
    SELECT * INTO v_ticket FROM public.tickets WHERE id = v_conv.current_ticket_id;
  END IF;
  IF v_ticket.id IS NULL THEN
    v_ticket := public.fn_open_ticket_for_conversation(v_conv.id);
  END IF;

  WHILE v_ticket.merged_into_id IS NOT NULL AND v_hops < 10 LOOP
    SELECT * INTO v_ticket FROM public.tickets WHERE id = v_ticket.merged_into_id;
    v_hops := v_hops + 1;
  END LOOP;

  IF v_ticket.status = 'closed' THEN
    SELECT * INTO v_follow FROM public.tickets
     WHERE follow_up_of_id = v_ticket.id AND status <> 'closed'
     ORDER BY created_at DESC LIMIT 1;
    IF v_follow.id IS NULL THEN
      IF NEW.sender_type = 'visitor' THEN
        v_prev := public.fn_ticket_set_actor('customer', v_conv.visitor_id);
      END IF;
      v_follow := public.fn_open_ticket_for_conversation(v_conv.id, v_ticket);
      IF NEW.sender_type = 'visitor' THEN
        PERFORM public.fn_ticket_restore_actor(v_prev);
      END IF;
    END IF;
    v_ticket := v_follow;
  END IF;

  NEW.ticket_id := v_ticket.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_message_assign_ticket ON public.messages;
CREATE TRIGGER trg_message_assign_ticket
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_message_assign_ticket();

-- After a message is stored: the status rules.
CREATE OR REPLACE FUNCTION public.fn_message_apply_ticket_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets;
  v_prev TEXT;
  v_internal BOOLEAN := coalesce(NEW.is_internal, false);
  v_first_line TEXT;
BEGIN
  IF NEW.ticket_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_ticket FROM public.tickets WHERE id = NEW.ticket_id FOR UPDATE;
  IF NOT FOUND OR v_ticket.status = 'closed' THEN
    RETURN NEW;
  END IF;

  IF NEW.sender_type = 'visitor' AND NOT v_internal THEN
    v_prev := public.fn_ticket_set_actor('customer', v_ticket.requester_id);
    v_first_line := left(trim(split_part(coalesce(NEW.content, ''), E'\n', 1)), 120);
    UPDATE public.tickets
       SET last_customer_reply_at = NEW.created_at,
           status = CASE WHEN status IN ('pending', 'solved') THEN 'open' ELSE status END,
           subject = CASE WHEN subject = '' AND v_first_line <> '' THEN v_first_line ELSE subject END
     WHERE id = v_ticket.id;
    PERFORM public.fn_ticket_restore_actor(v_prev);

  ELSIF NEW.sender_type = 'agent' AND NEW.sender_id IS NOT NULL THEN
    v_prev := public.fn_ticket_set_actor('agent', NEW.sender_id);
    IF v_internal THEN
      UPDATE public.tickets SET updated_at = now() WHERE id = v_ticket.id;
      PERFORM public.fn_ticket_log(v_ticket, 'internal_note', NULL, NULL, left(NEW.content, 300));
    ELSE
      UPDATE public.tickets
         SET last_agent_reply_at = NEW.created_at,
             first_agent_reply_at = coalesce(first_agent_reply_at, NEW.created_at),
             assignee_id = coalesce(assignee_id, NEW.sender_id),
             status = CASE WHEN status = 'new' THEN 'open' ELSE status END
       WHERE id = v_ticket.id;
      PERFORM public.fn_ticket_log(v_ticket, 'public_reply', NULL, NULL, left(NEW.content, 300));
    END IF;
    PERFORM public.fn_ticket_restore_actor(v_prev);

  ELSE
    -- Bot replies, system lines and notes: activity, not a status change.
    v_prev := public.fn_ticket_set_actor(CASE WHEN NEW.sender_type = 'ai' THEN 'bot' ELSE 'system' END, NULL);
    UPDATE public.tickets SET updated_at = now() WHERE id = v_ticket.id;
    PERFORM public.fn_ticket_restore_actor(v_prev);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_message_ticket_rules ON public.messages;
CREATE TRIGGER trg_message_ticket_rules
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_message_apply_ticket_rules();

-- ----------------------------------------------------------------------------
-- 9. Backfill: one ticket per existing conversation, numbered by age
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_backfill_tickets()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_count INTEGER := 0;
  v_ticket public.tickets;
  v_status TEXT;
  v_subject TEXT;
BEGIN
  PERFORM public.fn_ticket_set_actor('system', NULL);
  FOR r IN
    SELECT c.* FROM public.conversations c
     WHERE c.workspace_id IS NOT NULL AND c.current_ticket_id IS NULL
       AND EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = c.workspace_id)
     ORDER BY c.created_at, c.id
  LOOP
    v_status := CASE r.status
      WHEN 'pending' THEN 'pending'
      WHEN 'snoozed' THEN 'on_hold'
      WHEN 'closed' THEN
        CASE WHEN coalesce(r.closed_at, r.updated_at) < now() - interval '4 days' THEN 'closed' ELSE 'solved' END
      ELSE CASE WHEN r.assigned_agent_id IS NOT NULL
                  OR EXISTS (SELECT 1 FROM public.messages m
                              WHERE m.conversation_id = r.id AND m.sender_type = 'agent'
                                AND coalesce(m.is_internal, false) = false)
                THEN 'open' ELSE 'new' END
    END;
    SELECT left(trim(split_part(m.content, E'\n', 1)), 120) INTO v_subject
      FROM public.messages m
     WHERE m.conversation_id = r.id AND m.sender_type = 'visitor' AND coalesce(m.is_internal, false) = false
     ORDER BY m.created_at LIMIT 1;

    INSERT INTO public.tickets (workspace_id, conversation_id, subject, status, priority, assignee_id, tags,
                                requester_id, channel, created_at, updated_at, status_changed_at,
                                solved_at, closed_at)
    VALUES (r.workspace_id, r.id, coalesce(v_subject, ''), v_status, coalesce(r.priority, 'normal'),
            r.assigned_agent_id, coalesce(r.tags, '{}'), r.visitor_id, 'chat', r.created_at, r.updated_at,
            r.updated_at,
            CASE WHEN v_status IN ('solved', 'closed') THEN coalesce(r.closed_at, r.updated_at) END,
            CASE WHEN v_status = 'closed' THEN coalesce(r.closed_at, r.updated_at) END)
    RETURNING * INTO v_ticket;

    PERFORM set_config('zentry.ticket_syncing', 'on', true);
    UPDATE public.conversations SET current_ticket_id = v_ticket.id WHERE id = r.id;
    PERFORM set_config('zentry.ticket_syncing', '', true);
    UPDATE public.messages SET ticket_id = v_ticket.id WHERE conversation_id = r.id AND ticket_id IS NULL;
    v_count := v_count + 1;
  END LOOP;
  PERFORM public.fn_ticket_restore_actor('|');
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_backfill_tickets() FROM PUBLIC, anon, authenticated;

-- Conversations created before this migration. Messages of closed tickets are
-- linked before the read-only guard below exists.
SELECT public.fn_backfill_tickets();

-- ----------------------------------------------------------------------------
-- 10. Closed tickets keep their thread as it was
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_message_guard_closed_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.ticket_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.tickets WHERE id = OLD.ticket_id AND status = 'closed') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE'
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.attachment_url IS DISTINCT FROM OLD.attachment_url
     OR NEW.is_internal IS DISTINCT FROM OLD.is_internal
     OR NEW.sender_type IS DISTINCT FROM OLD.sender_type
     OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
    RAISE EXCEPTION 'This message belongs to a closed ticket and cannot be changed.' USING ERRCODE = '55000';
  END IF;
  -- Read and delivery receipts still update.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_message_guard_closed_ticket ON public.messages;
CREATE TRIGGER trg_message_guard_closed_ticket
  BEFORE UPDATE OR DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_message_guard_closed_ticket();

-- ----------------------------------------------------------------------------
-- 11. Operations
-- ----------------------------------------------------------------------------

-- Solved tickets close after p_after (4 days). Run by /api/cron/close-solved-tickets.
CREATE OR REPLACE FUNCTION public.fn_close_solved_tickets(p_after INTERVAL DEFAULT interval '4 days')
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
  v_prev TEXT := public.fn_ticket_set_actor('system', NULL);
BEGIN
  UPDATE public.tickets SET status = 'closed'
   WHERE status = 'solved' AND solved_at <= now() - p_after;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM public.fn_ticket_restore_actor(v_prev);
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_close_solved_tickets(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_solved_tickets(INTERVAL) TO service_role;

-- Merges sources into target: their threads move to the target, each gets an
-- internal note, and each source is closed with merged_into_id set. Later
-- messages on a source conversation follow merged_into_id to the target.
CREATE OR REPLACE FUNCTION public.fn_merge_tickets(p_target_id UUID, p_source_ids UUID[])
RETURNS public.tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target public.tickets;
  v_source public.tickets;
  v_prev TEXT;
BEGIN
  SELECT * INTO v_target FROM public.tickets WHERE id = p_target_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_ticket_member(v_target.workspace_id) THEN
    RAISE EXCEPTION 'Ticket not found.' USING ERRCODE = '42501';
  END IF;
  IF v_target.status = 'closed' THEN
    RAISE EXCEPTION 'Ticket #% is closed and cannot receive a merge.', v_target.number USING ERRCODE = '55000';
  END IF;
  IF coalesce(array_length(p_source_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Choose at least one ticket to merge.' USING ERRCODE = '22023';
  END IF;

  v_prev := public.fn_ticket_set_actor('agent', auth.uid());
  PERFORM set_config('zentry.ticket_internal', 'on', true);

  FOR v_source IN
    SELECT * FROM public.tickets WHERE id = ANY (p_source_ids) AND id <> p_target_id ORDER BY number FOR UPDATE
  LOOP
    IF v_source.workspace_id <> v_target.workspace_id THEN
      RAISE EXCEPTION 'Tickets from different workspaces cannot be merged.' USING ERRCODE = '42501';
    END IF;
    IF v_source.status = 'closed' THEN
      RAISE EXCEPTION 'Ticket #% is closed and cannot be merged.', v_source.number USING ERRCODE = '55000';
    END IF;

    UPDATE public.messages SET ticket_id = v_target.id WHERE ticket_id = v_source.id;

    INSERT INTO public.messages (conversation_id, ticket_id, sender_type, sender_id, content, is_internal, metadata)
    VALUES (v_source.conversation_id, v_source.id, 'system', auth.uid(),
            format('Merged into ticket #%s.', v_target.number), true, jsonb_build_object('ticket_merge', true));
    INSERT INTO public.messages (conversation_id, ticket_id, sender_type, sender_id, content, is_internal, metadata)
    VALUES (v_target.conversation_id, v_target.id, 'system', auth.uid(),
            format('Ticket #%s was merged into this ticket: %s', v_source.number, v_source.subject), true,
            jsonb_build_object('ticket_merge', true));

    UPDATE public.tickets
       SET merged_into_id = v_target.id, status = 'closed'
     WHERE id = v_source.id;

    UPDATE public.tickets
       SET tags = (SELECT coalesce(array_agg(DISTINCT t), '{}') FROM unnest(tags || v_source.tags) AS t)
     WHERE id = v_target.id;
  END LOOP;

  PERFORM set_config('zentry.ticket_internal', '', true);
  PERFORM public.fn_ticket_restore_actor(v_prev);
  SELECT * INTO v_target FROM public.tickets WHERE id = p_target_id;
  RETURN v_target;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_merge_tickets(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_merge_tickets(UUID, UUID[]) TO authenticated, service_role;

-- Finds tickets by number ("#1042" or "1042"), subject, requester name or
-- email, or any message text, within one workspace the caller belongs to.
CREATE OR REPLACE FUNCTION public.fn_search_tickets(p_workspace_id UUID, p_query TEXT, p_limit INTEGER DEFAULT 50)
RETURNS TABLE (ticket_id UUID, matched_on TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q TEXT := trim(coalesce(p_query, ''));
  v_like TEXT;
  v_number INTEGER;
BEGIN
  IF NOT public.fn_ticket_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Not a member of this workspace.' USING ERRCODE = '42501';
  END IF;
  IF v_q = '' THEN
    RETURN;
  END IF;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  IF v_q ~ '^#?\d{1,9}$' THEN
    v_number := ltrim(v_q, '#')::integer;
  END IF;

  RETURN QUERY
  WITH hits AS (
    SELECT t.id, 'number'::text AS why, 1 AS rank, t.updated_at
      FROM public.tickets t WHERE t.workspace_id = p_workspace_id AND t.number = v_number
    UNION ALL
    SELECT t.id, 'subject', 2, t.updated_at
      FROM public.tickets t WHERE t.workspace_id = p_workspace_id AND t.subject ILIKE v_like
    UNION ALL
    SELECT t.id, 'requester', 3, t.updated_at
      FROM public.tickets t JOIN public.visitors v ON v.id = t.requester_id
     WHERE t.workspace_id = p_workspace_id AND (v.name ILIKE v_like OR v.email ILIKE v_like)
    UNION ALL
    SELECT t.id, 'message', 4, t.updated_at
      FROM public.tickets t
     WHERE t.workspace_id = p_workspace_id
       AND EXISTS (SELECT 1 FROM public.messages m WHERE m.ticket_id = t.id AND m.content ILIKE v_like)
  ),
  best AS (
    SELECT DISTINCT ON (h.id) h.id, h.why, h.rank, h.updated_at FROM hits h ORDER BY h.id, h.rank
  )
  SELECT b.id, b.why FROM best b ORDER BY b.rank, b.updated_at DESC LIMIT greatest(1, least(p_limit, 200));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_search_tickets(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_search_tickets(UUID, TEXT, INTEGER) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 12. Row level security
--
-- Tickets are agent data. The anonymous role has no policy on any of these
-- tables; the widget reaches them only through the triggers above.
-- ----------------------------------------------------------------------------

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tickets_select ON public.tickets;
CREATE POLICY tickets_select ON public.tickets FOR SELECT TO authenticated
  USING (public.fn_ticket_member(workspace_id));
DROP POLICY IF EXISTS tickets_update ON public.tickets;
CREATE POLICY tickets_update ON public.tickets FOR UPDATE TO authenticated
  USING (public.fn_ticket_member(workspace_id))
  WITH CHECK (public.fn_ticket_member(workspace_id));
-- No INSERT or DELETE policy: tickets are created from conversations, and
-- never deleted by agents.

DROP POLICY IF EXISTS ticket_events_select ON public.ticket_events;
CREATE POLICY ticket_events_select ON public.ticket_events FOR SELECT TO authenticated
  USING (public.fn_ticket_member(workspace_id));
-- No write policy: only the audit triggers write events.

DROP POLICY IF EXISTS ticket_groups_select ON public.ticket_groups;
CREATE POLICY ticket_groups_select ON public.ticket_groups FOR SELECT TO authenticated
  USING (public.fn_ticket_member(workspace_id));
DROP POLICY IF EXISTS ticket_groups_write ON public.ticket_groups;
CREATE POLICY ticket_groups_write ON public.ticket_groups FOR ALL TO authenticated
  USING (public.fn_ticket_admin(workspace_id))
  WITH CHECK (public.fn_ticket_admin(workspace_id));

DROP POLICY IF EXISTS ticket_views_select ON public.ticket_views;
CREATE POLICY ticket_views_select ON public.ticket_views FOR SELECT TO authenticated
  USING (public.fn_ticket_member(workspace_id) AND (owner_id IS NULL OR owner_id = auth.uid()));
DROP POLICY IF EXISTS ticket_views_write ON public.ticket_views;
CREATE POLICY ticket_views_write ON public.ticket_views FOR ALL TO authenticated
  USING (
    public.fn_ticket_member(workspace_id)
    AND (owner_id = auth.uid() OR (owner_id IS NULL AND public.fn_ticket_admin(workspace_id)))
  )
  WITH CHECK (
    public.fn_ticket_member(workspace_id)
    AND (owner_id = auth.uid() OR (owner_id IS NULL AND public.fn_ticket_admin(workspace_id)))
  );

-- ----------------------------------------------------------------------------
-- 13. Realtime: ticket lists refresh live
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tickets'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tickets;
  END IF;
END $$;
