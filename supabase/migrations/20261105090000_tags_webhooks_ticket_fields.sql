-- Three settings pages that said "Coming soon": Tags, Webhooks, Ticket fields.
--
-- 1. Tags. Tags live as text arrays on tickets (kept in sync with
--    conversations by the ticketing triggers), so there was no way to see
--    which tags exist or to clean them up. fn_workspace_tags lists them with
--    counts; fn_rename_tag renames (or merges, when the new name already
--    exists) and fn_delete_tag removes one. Closed tickets are read-only by
--    design (fn_ticket_before_update), so they keep the tags they closed
--    with: they are history. Rules do not fire for these bulk edits.
--
-- 2. Webhooks. A workspace registers HTTPS endpoints and picks events
--    (ticket.created, ticket.updated, ticket.solved, message.created).
--    Triggers queue one row per delivery in automation_outbox (kind
--    'webhook'), which already signs bodies with HMAC-SHA256, refuses private
--    addresses and retries with backoff (src/lib/automation/outbox.ts).
--
-- 3. Ticket fields. Workspace-defined fields (text, number, dropdown,
--    checkbox, date) shown on every ticket; values live in
--    tickets.custom_fields keyed by the field's key.

/* ── 1. Tags ────────────────────────────────────────────────────────────── */

CREATE OR REPLACE FUNCTION public.fn_workspace_tags(p_workspace_id UUID)
RETURNS TABLE (tag TEXT, tickets INT, open_tickets INT, last_used TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.fn_role_can(p_workspace_id, 'view') THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT t.tag::text,
           count(*)::int,
           count(*) FILTER (WHERE tk.status NOT IN ('solved', 'closed'))::int,
           max(tk.updated_at)
      FROM public.tickets tk
      CROSS JOIN LATERAL unnest(coalesce(tk.tags, '{}')) AS t(tag)
     WHERE tk.workspace_id = p_workspace_id
       AND btrim(t.tag) <> ''
     GROUP BY t.tag
     ORDER BY count(*) DESC, t.tag;
END;
$$;

-- Renames p_from to p_to on every ticket that is not closed. If p_to is
-- already on a ticket the two merge (no duplicates). Returns tickets changed.
CREATE OR REPLACE FUNCTION public.fn_rename_tag(p_workspace_id UUID, p_from TEXT, p_to TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_to TEXT := btrim(coalesce(p_to, ''));
  v_depth TEXT := current_setting('zentry.automation_depth', true);
  v_count INT;
BEGIN
  IF NOT public.fn_role_can(p_workspace_id, 'manage_settings') THEN
    RAISE EXCEPTION 'Forbidden: only owners and admins manage tags.' USING ERRCODE = '42501';
  END IF;
  IF v_to = '' OR char_length(v_to) > 50 THEN
    RAISE EXCEPTION 'A tag is 1 to 50 characters.' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_from, '') = v_to THEN
    RETURN 0;
  END IF;
  -- A bulk clean-up is not a change anyone made to these tickets: no rules fire.
  PERFORM set_config('zentry.automation_depth', '5', true);
  UPDATE public.tickets tk
     SET tags = ARRAY(
           -- Each tag once, in the order the ticket had them.
           SELECT s.x FROM (
             SELECT u.x, min(u.i) AS i
               FROM unnest(array_replace(tk.tags, p_from, v_to)) WITH ORDINALITY AS u(x, i)
              GROUP BY u.x
           ) s ORDER BY s.i
         )
   WHERE tk.workspace_id = p_workspace_id
     AND tk.status <> 'closed'
     AND p_from = ANY (tk.tags);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('zentry.automation_depth', coalesce(v_depth, ''), true);
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_delete_tag(p_workspace_id UUID, p_tag TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_depth TEXT := current_setting('zentry.automation_depth', true);
  v_count INT;
BEGIN
  IF NOT public.fn_role_can(p_workspace_id, 'manage_settings') THEN
    RAISE EXCEPTION 'Forbidden: only owners and admins manage tags.' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('zentry.automation_depth', '5', true);
  UPDATE public.tickets
     SET tags = array_remove(tags, p_tag)
   WHERE workspace_id = p_workspace_id
     AND status <> 'closed'
     AND p_tag = ANY (tags);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('zentry.automation_depth', coalesce(v_depth, ''), true);
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_workspace_tags(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_rename_tag(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_delete_tag(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_workspace_tags(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_rename_tag(UUID, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_delete_tag(UUID, TEXT) TO authenticated, service_role;

/* ── 2. Webhooks ────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS public.workspace_webhooks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name             TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 80),
  url              TEXT NOT NULL CHECK (url ~ '^https://' AND char_length(url) <= 2000),
  -- Shown to admins so they can verify X-Zentry-Signature on their side.
  secret           TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  events           TEXT[] NOT NULL DEFAULT ARRAY['ticket.created', 'ticket.updated', 'ticket.solved', 'message.created'],
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_delivery_at TIMESTAMPTZ,
  last_status      TEXT CHECK (last_status IN ('sent', 'failed')),
  last_error       TEXT,
  CONSTRAINT workspace_webhooks_events_known CHECK (
    events <@ ARRAY['ticket.created', 'ticket.updated', 'ticket.solved', 'message.created']
  )
);
CREATE INDEX IF NOT EXISTS idx_workspace_webhooks_workspace ON public.workspace_webhooks (workspace_id) WHERE is_active;

ALTER TABLE public.workspace_webhooks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_webhooks FROM anon;

DROP POLICY IF EXISTS workspace_webhooks_select ON public.workspace_webhooks;
CREATE POLICY workspace_webhooks_select ON public.workspace_webhooks FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'));
DROP POLICY IF EXISTS workspace_webhooks_insert ON public.workspace_webhooks;
CREATE POLICY workspace_webhooks_insert ON public.workspace_webhooks FOR INSERT TO authenticated
  WITH CHECK (public.fn_role_can(workspace_id, 'manage_settings'));
DROP POLICY IF EXISTS workspace_webhooks_update ON public.workspace_webhooks;
CREATE POLICY workspace_webhooks_update ON public.workspace_webhooks FOR UPDATE TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'))
  WITH CHECK (public.fn_role_can(workspace_id, 'manage_settings'));
DROP POLICY IF EXISTS workspace_webhooks_delete ON public.workspace_webhooks;
CREATE POLICY workspace_webhooks_delete ON public.workspace_webhooks FOR DELETE TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'));

-- The ticket as webhook consumers see it (no internal bookkeeping columns).
CREATE OR REPLACE FUNCTION public.fn_webhook_ticket_json(t public.tickets)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', t.id, 'number', t.number, 'subject', t.subject, 'status', t.status,
    'priority', t.priority, 'type', t.type, 'channel', t.channel, 'tags', t.tags,
    'assignee_id', t.assignee_id, 'group_id', t.group_id, 'requester_id', t.requester_id,
    'conversation_id', t.conversation_id, 'custom_fields', coalesce(to_jsonb(t) -> 'custom_fields', '{}'::jsonb),
    'created_at', t.created_at, 'updated_at', t.updated_at, 'solved_at', t.solved_at
  );
$$;

-- Queues one delivery per active webhook subscribed to p_event.
CREATE OR REPLACE FUNCTION public.fn_queue_webhooks(p_workspace_id UUID, p_ticket_id UUID, p_event TEXT, p_data JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.automation_outbox (workspace_id, ticket_id, kind, payload)
  SELECT p_workspace_id, p_ticket_id, 'webhook',
         jsonb_build_object(
           'webhook_id', w.id, 'url', w.url, 'secret', w.secret, 'event', p_event,
           'workspace_id', p_workspace_id, 'occurred_at', now()
         ) || p_data
    FROM public.workspace_webhooks w
   WHERE w.workspace_id = p_workspace_id AND w.is_active AND p_event = ANY (w.events);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_queue_webhooks(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ticket_webhooks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SLA timer refreshes are cache writes, not changes anyone made.
  IF coalesce(current_setting('zentry.sla_internal', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_webhooks WHERE workspace_id = NEW.workspace_id AND is_active) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.fn_queue_webhooks(NEW.workspace_id, NEW.id, 'ticket.created', jsonb_build_object('ticket', public.fn_webhook_ticket_json(NEW)));
    RETURN NULL;
  END IF;
  IF NEW.status = 'solved' AND OLD.status IS DISTINCT FROM 'solved' THEN
    PERFORM public.fn_queue_webhooks(NEW.workspace_id, NEW.id, 'ticket.solved', jsonb_build_object('ticket', public.fn_webhook_ticket_json(NEW)));
  END IF;
  IF (NEW.status, NEW.priority, NEW.assignee_id, NEW.group_id, NEW.tags, NEW.subject, NEW.type)
     IS DISTINCT FROM (OLD.status, OLD.priority, OLD.assignee_id, OLD.group_id, OLD.tags, OLD.subject, OLD.type)
     OR (to_jsonb(NEW) -> 'custom_fields') IS DISTINCT FROM (to_jsonb(OLD) -> 'custom_fields') THEN
    PERFORM public.fn_queue_webhooks(NEW.workspace_id, NEW.id, 'ticket.updated', jsonb_build_object(
      'ticket', public.fn_webhook_ticket_json(NEW),
      'previous', jsonb_build_object('status', OLD.status, 'priority', OLD.priority, 'assignee_id', OLD.assignee_id, 'tags', OLD.tags)
    ));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_webhooks ON public.tickets;
CREATE TRIGGER trg_ticket_webhooks
  AFTER INSERT OR UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ticket_webhooks();

CREATE OR REPLACE FUNCTION public.fn_message_webhooks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws UUID;
  v_ticket UUID;
BEGIN
  -- Internal notes stay inside the team.
  IF coalesce(NEW.is_internal, false) THEN
    RETURN NULL;
  END IF;
  SELECT c.workspace_id, coalesce(NEW.ticket_id, c.current_ticket_id)
    INTO v_ws, v_ticket
    FROM public.conversations c
   WHERE c.id = NEW.conversation_id;
  IF v_ws IS NULL OR v_ticket IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_webhooks WHERE workspace_id = v_ws AND is_active) THEN
    RETURN NULL;
  END IF;
  PERFORM public.fn_queue_webhooks(v_ws, v_ticket, 'message.created', jsonb_build_object(
    'message', jsonb_build_object(
      'id', NEW.id, 'conversation_id', NEW.conversation_id, 'ticket_id', v_ticket,
      'sender_type', NEW.sender_type, 'sender_id', NEW.sender_id, 'content', NEW.content,
      'attachment_url', NEW.attachment_url, 'created_at', NEW.created_at
    )
  ));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_message_webhooks ON public.messages;
CREATE TRIGGER trg_message_webhooks
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_message_webhooks();

/* ── 3. Ticket fields ───────────────────────────────────────────────────── */

ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.ticket_fields (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  key          TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label        TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
  type         TEXT NOT NULL CHECK (type IN ('text', 'number', 'dropdown', 'checkbox', 'date')),
  options      TEXT[] NOT NULL DEFAULT '{}',
  description  TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  required     BOOLEAN NOT NULL DEFAULT false,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  position     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ticket_fields_key_unique UNIQUE (workspace_id, key),
  CONSTRAINT ticket_fields_dropdown_options CHECK (type <> 'dropdown' OR cardinality(options) BETWEEN 1 AND 50)
);
CREATE INDEX IF NOT EXISTS idx_ticket_fields_workspace ON public.ticket_fields (workspace_id, position);

ALTER TABLE public.ticket_fields ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ticket_fields FROM anon;

DROP POLICY IF EXISTS ticket_fields_select ON public.ticket_fields;
CREATE POLICY ticket_fields_select ON public.ticket_fields FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'view'));
DROP POLICY IF EXISTS ticket_fields_insert ON public.ticket_fields;
CREATE POLICY ticket_fields_insert ON public.ticket_fields FOR INSERT TO authenticated
  WITH CHECK (public.fn_role_can(workspace_id, 'manage_settings'));
DROP POLICY IF EXISTS ticket_fields_update ON public.ticket_fields;
CREATE POLICY ticket_fields_update ON public.ticket_fields FOR UPDATE TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'))
  WITH CHECK (public.fn_role_can(workspace_id, 'manage_settings'));
DROP POLICY IF EXISTS ticket_fields_delete ON public.ticket_fields;
CREATE POLICY ticket_fields_delete ON public.ticket_fields FOR DELETE TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'));

/* ── 4. Pre-chat topic ──────────────────────────────────────────────────── */

-- The widget's pre-chat form can ask for a topic (Settings → Chat widget →
-- Pre-chat form; navbar_trigger_config.prechat.topics). The visitor runs as
-- anon and cannot edit tickets, so this adds the topic to the conversation's
-- ticket as a tag, after checking that the conversation is this visitor's and
-- that the topic is one the workspace offers. Triggers can then route on it.
CREATE OR REPLACE FUNCTION public.fn_set_conversation_topic(
  p_conversation_id UUID,
  p_visitor_id UUID,
  p_topic TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws UUID;
  v_ticket UUID;
  v_topics JSONB;
  v_topic TEXT := btrim(coalesce(p_topic, ''));
BEGIN
  IF v_topic = '' THEN
    RETURN false;
  END IF;
  SELECT c.workspace_id, c.current_ticket_id
    INTO v_ws, v_ticket
    FROM public.conversations c
   WHERE c.id = p_conversation_id AND c.visitor_id = p_visitor_id;
  IF v_ws IS NULL OR v_ticket IS NULL THEN
    RETURN false;
  END IF;
  SELECT w.navbar_trigger_config -> 'prechat' -> 'topics' INTO v_topics FROM public.workspaces w WHERE w.id = v_ws;
  IF v_topics IS NULL OR jsonb_typeof(v_topics) <> 'array' OR NOT (v_topics ? v_topic) THEN
    RETURN false;
  END IF;
  UPDATE public.tickets
     SET tags = CASE WHEN v_topic = ANY (tags) THEN tags ELSE array_append(coalesce(tags, '{}'), v_topic) END
   WHERE id = v_ticket AND status <> 'closed';
  RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_set_conversation_topic(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_set_conversation_topic(UUID, UUID, TEXT) TO anon, authenticated, service_role;
