-- ============================================================================
-- Widget visitor sessions (docs/AUDIT.md H-3, step 1 of 2)
--
-- The widget talks to Supabase with the public anon key, and the anon policies
-- on conversations, messages and visitors let that key read (and update) every
-- workspace's chats and visitors. Anyone who copies the key out of widget.js
-- can do the same.
--
-- The fix is to give each visitor a secret and route everything the widget
-- does through functions that check it:
--
--   * visitor_sessions holds a hash of a random token per visitor. The first
--     fn_widget_session call for a visitor issues it; later calls must present
--     it. The widget keeps it in localStorage next to the visitor id.
--   * fn_widget_* functions (SECURITY DEFINER) do what the widget used to do
--     with table reads and writes, each one scoped to the caller's visitor.
--   * Live updates no longer need anon SELECT on messages: triggers broadcast
--     a visitor's own message and conversation changes on a channel named by
--     an unguessable topic that only that visitor's widget is told. The widget
--     also polls, so a project with public broadcast switched off still works.
--
-- This migration only adds; old and new widgets both work with it. The old
-- anon access is removed by 20261107090000_widget_anon_lockdown.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Sessions. No policies and no grants: only the definer functions below and
-- the service role touch this table.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.visitor_sessions (
  visitor_id UUID PRIMARY KEY REFERENCES public.visitors(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  -- The realtime topic for this visitor. Random and separate from the token,
  -- so seeing a topic (it travels to the realtime server) never gives the token.
  topic TEXT NOT NULL UNIQUE DEFAULT ('zv-' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.visitor_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.visitor_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.visitor_sessions TO service_role;

CREATE INDEX IF NOT EXISTS visitor_sessions_workspace_idx ON public.visitor_sessions (workspace_id);

-- sha256 is built in (no pgcrypto, whose schema differs between Supabase and
-- a plain Postgres).
CREATE OR REPLACE FUNCTION public.fn_widget_token_hash(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
$$;

REVOKE EXECUTE ON FUNCTION public.fn_widget_token_hash(TEXT) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The check every widget function starts with. Raises rather than returning
-- false, so a function cannot forget to look at the answer.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_widget_auth(p_visitor_id UUID, p_token TEXT)
RETURNS public.visitor_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.visitor_sessions;
BEGIN
  IF p_visitor_id IS NULL OR coalesce(p_token, '') = '' THEN
    RAISE EXCEPTION 'visitor_session_invalid' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_session FROM public.visitor_sessions WHERE visitor_id = p_visitor_id;
  IF NOT FOUND OR v_session.token_hash <> public.fn_widget_token_hash(p_token) THEN
    RAISE EXCEPTION 'visitor_session_invalid' USING ERRCODE = '28000';
  END IF;
  RETURN v_session;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_widget_auth(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- The conversation, if it belongs to this visitor; raises otherwise.
CREATE OR REPLACE FUNCTION public.fn_widget_conversation(p_visitor_id UUID, p_conversation_id UUID)
RETURNS public.conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conversation_id AND visitor_id = p_visitor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_conv;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_widget_conversation(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- What the widget may see of a message: no internal flag, no sender id, and
-- only the metadata it renders (edits, translations, handover marker, welcome
-- line). Built from to_jsonb so columns older projects lack read as null.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_widget_message_json(p_message public.messages)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH m AS (SELECT to_jsonb(p_message) AS j)
  SELECT jsonb_build_object(
    'id', j -> 'id',
    'conversation_id', j -> 'conversation_id',
    'sender_type', j -> 'sender_type',
    'content', j -> 'content',
    'attachment_url', j -> 'attachment_url',
    'created_at', j -> 'created_at',
    'delivered_at', j -> 'delivered_at',
    'read_at', j -> 'read_at',
    'reply_to_message_id', j -> 'reply_to_message_id',
    'metadata', jsonb_strip_nulls(jsonb_build_object(
      'system_event', j #> '{metadata,system_event}',
      'is_edited', j #> '{metadata,is_edited}',
      'is_welcome', j #> '{metadata,is_welcome}',
      'translated_text', j #> '{metadata,translated_text}',
      'translation', CASE WHEN j #> '{metadata,translation,translated_text}' IS NULL THEN NULL
                          ELSE jsonb_build_object('translated_text', j #> '{metadata,translation,translated_text}') END
    ))
  )
  FROM m
$$;

REVOKE EXECUTE ON FUNCTION public.fn_widget_message_json(public.messages) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_widget_conversation_json(p_conv public.conversations)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', p_conv.id,
    'status', p_conv.status,
    'csat_rating', to_jsonb(p_conv) -> 'csat_rating',
    'created_at', p_conv.created_at,
    'updated_at', p_conv.updated_at
  )
$$;

REVOKE EXECUTE ON FUNCTION public.fn_widget_conversation_json(public.conversations) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- fn_widget_session: start or resume a visitor.
--
-- No token: issues one if this visitor has none yet (a new visitor, or one
-- from before sessions existed). A visitor that already has a token must
-- present it; otherwise the widget starts over with a fresh visitor id, so a
-- copied visitor id is worth nothing on its own.
-- Returns the token (only when newly issued), the realtime topic and the
-- visitor's latest conversation in this workspace.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_widget_session(
  p_workspace_id UUID,
  p_visitor_id UUID,
  p_token TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_visitor_ws UUID;
  v_found BOOLEAN;
  v_session public.visitor_sessions;
  v_new_token TEXT;
  v_conv public.conversations;
BEGIN
  IF p_workspace_id IS NULL OR p_visitor_id IS NULL THEN
    RAISE EXCEPTION 'visitor_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT workspace_id, true INTO v_visitor_ws, v_found FROM public.visitors WHERE id = p_visitor_id;
  IF v_found AND v_visitor_ws IS NOT NULL AND v_visitor_ws <> p_workspace_id THEN
    -- A visitor id belongs to one workspace.
    RAISE EXCEPTION 'visitor_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF v_found IS NULL THEN
    INSERT INTO public.visitors (id, workspace_id) VALUES (p_visitor_id, p_workspace_id)
    ON CONFLICT (id) DO NOTHING;
  ELSIF v_visitor_ws IS NULL THEN
    UPDATE public.visitors SET workspace_id = p_workspace_id WHERE id = p_visitor_id;
  END IF;

  SELECT * INTO v_session FROM public.visitor_sessions WHERE visitor_id = p_visitor_id;
  IF NOT FOUND THEN
    v_new_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO public.visitor_sessions (visitor_id, workspace_id, token_hash)
    VALUES (p_visitor_id, p_workspace_id, public.fn_widget_token_hash(v_new_token))
    ON CONFLICT (visitor_id) DO NOTHING
    RETURNING * INTO v_session;
    IF v_session.visitor_id IS NULL THEN
      -- Another tab claimed it a moment ago; that tab's token is the one.
      RAISE EXCEPTION 'visitor_session_invalid' USING ERRCODE = '28000';
    END IF;
  ELSIF coalesce(p_token, '') = '' OR v_session.token_hash <> public.fn_widget_token_hash(p_token) THEN
    RAISE EXCEPTION 'visitor_session_invalid' USING ERRCODE = '28000';
  ELSE
    UPDATE public.visitor_sessions SET last_used_at = now()
     WHERE visitor_id = p_visitor_id AND last_used_at < now() - interval '1 hour';
  END IF;

  SELECT * INTO v_conv FROM public.conversations
   WHERE visitor_id = p_visitor_id AND workspace_id = p_workspace_id
   ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'visitor_id', p_visitor_id,
    'token', v_new_token,
    'topic', v_session.topic,
    'conversation', CASE WHEN v_conv.id IS NULL THEN NULL ELSE public.fn_widget_conversation_json(v_conv) END
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- Visible messages of one of the visitor's conversations, with its status.
-- The widget calls this for history and for polling.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_widget_messages(p_visitor_id UUID, p_token TEXT, p_conversation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations;
BEGIN
  PERFORM public.fn_widget_auth(p_visitor_id, p_token);
  v_conv := public.fn_widget_conversation(p_visitor_id, p_conversation_id);
  RETURN jsonb_build_object(
    'conversation', public.fn_widget_conversation_json(v_conv),
    'messages', coalesce((
      SELECT jsonb_agg(public.fn_widget_message_json(m) ORDER BY m.created_at, m.id)
        FROM (
          SELECT * FROM public.messages
           WHERE conversation_id = v_conv.id AND is_internal IS NOT TRUE
           ORDER BY created_at DESC, id DESC
           LIMIT 300
        ) m
    ), '[]'::jsonb)
  );
END;
$$;

-- The visitor's conversations for the Home tab (same shape as the older
-- fn_get_visitor_conversations, scoped by the session).
CREATE OR REPLACE FUNCTION public.fn_widget_conversations(p_visitor_id UUID, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.visitor_sessions;
BEGIN
  v_session := public.fn_widget_auth(p_visitor_id, p_token);
  RETURN coalesce((
    SELECT jsonb_agg(row_to_json(r)::jsonb ORDER BY r.updated_at DESC)
      FROM (
        SELECT
          c.id, c.status, c.created_at, c.updated_at,
          to_jsonb(c) -> 'csat_rating' AS csat_rating,
          (SELECT jsonb_build_object('id', m.id, 'content', m.content, 'sender_type', m.sender_type,
                                     'created_at', m.created_at, 'attachment_url', m.attachment_url)
             FROM public.messages m
            WHERE m.conversation_id = c.id AND m.is_internal IS NOT TRUE
            ORDER BY m.created_at DESC LIMIT 1) AS last_message,
          (SELECT count(*) FROM public.messages m
            WHERE m.conversation_id = c.id AND m.is_internal IS NOT TRUE
              AND m.sender_type <> 'visitor' AND m.read_at IS NULL) AS unread_count
        FROM public.conversations c
        WHERE c.visitor_id = p_visitor_id
          AND (v_session.workspace_id IS NULL OR c.workspace_id = v_session.workspace_id)
        ORDER BY c.updated_at DESC
        LIMIT 20
      ) r
  ), '[]'::jsonb);
END;
$$;

-- ----------------------------------------------------------------------------
-- Get the visitor's current conversation or start one. Uses the project's
-- own fn_get_or_create_conversation when it has one (created outside the
-- migrations, so its rules are kept exactly), and otherwise inserts the same
-- row the widget's fallback used to. p_force_new skips the lookup: "Start a
-- new conversation" after one was closed.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_widget_start_conversation(
  p_visitor_id UUID,
  p_token TEXT,
  p_force_new BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.visitor_sessions;
  v_raw JSONB;
  v_id UUID;
  v_conv public.conversations;
BEGIN
  v_session := public.fn_widget_auth(p_visitor_id, p_token);

  IF NOT p_force_new AND to_regprocedure('public.fn_get_or_create_conversation(uuid,uuid)') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT to_jsonb(r) FROM public.fn_get_or_create_conversation($1, $2) r'
        INTO v_raw USING p_visitor_id, v_session.workspace_id;
      -- It may return a conversations row, jsonb or a bare id.
      v_id := coalesce(
        CASE WHEN jsonb_typeof(v_raw) = 'object' THEN v_raw ->> 'id' END,
        CASE WHEN jsonb_typeof(v_raw -> 'r') = 'object' THEN v_raw -> 'r' ->> 'id' END,
        CASE WHEN jsonb_typeof(v_raw -> 'r') = 'string' THEN v_raw ->> 'r' END,
        CASE WHEN jsonb_typeof(v_raw) = 'string' THEN v_raw #>> '{}' END
      )::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[Widget] fn_get_or_create_conversation failed: %', SQLERRM;
      v_id := NULL;
    END;
    IF v_id IS NOT NULL THEN
      SELECT * INTO v_conv FROM public.conversations WHERE id = v_id AND visitor_id = p_visitor_id;
    END IF;
  END IF;

  IF v_conv.id IS NULL AND NOT p_force_new THEN
    SELECT * INTO v_conv FROM public.conversations
     WHERE visitor_id = p_visitor_id AND workspace_id = v_session.workspace_id AND status <> 'closed'
     ORDER BY created_at DESC LIMIT 1;
  END IF;

  IF v_conv.id IS NULL THEN
    INSERT INTO public.conversations (visitor_id, workspace_id, status)
    VALUES (p_visitor_id, v_session.workspace_id, 'open')
    RETURNING * INTO v_conv;
  END IF;

  RETURN public.fn_widget_conversation_json(v_conv);
END;
$$;

-- ----------------------------------------------------------------------------
-- Send a visitor message. Reopening a closed or snoozed conversation is
-- attempted first, as the widget did, and may fail (a closed ticket is read
-- only) without stopping the message: the ticket rules then open a follow-up.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_widget_send_message(
  p_visitor_id UUID,
  p_token TEXT,
  p_conversation_id UUID,
  p_content TEXT,
  p_attachment_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations;
  v_content TEXT := btrim(coalesce(p_content, ''));
  v_url TEXT := nullif(btrim(coalesce(p_attachment_url, '')), '');
  v_msg public.messages;
BEGIN
  PERFORM public.fn_widget_auth(p_visitor_id, p_token);
  v_conv := public.fn_widget_conversation(p_visitor_id, p_conversation_id);

  IF v_content = '' AND v_url IS NULL THEN
    RAISE EXCEPTION 'message_empty' USING ERRCODE = '22023';
  END IF;
  IF length(v_content) > 10000 THEN
    RAISE EXCEPTION 'message_too_long' USING ERRCODE = '22001';
  END IF;
  IF v_url IS NOT NULL AND (length(v_url) > 2000 OR v_url !~* '^https://') THEN
    RAISE EXCEPTION 'attachment_url_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_content = '' THEN
    v_content := 'Sent a picture';
  END IF;

  IF v_conv.status <> 'open' THEN
    BEGIN
      UPDATE public.conversations
         SET status = 'open', closed_at = NULL, snoozed_until = NULL, updated_at = now()
       WHERE id = v_conv.id;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  INSERT INTO public.messages (conversation_id, sender_type, content, attachment_url, is_internal, created_at)
  VALUES (v_conv.id, 'visitor', v_content, v_url, false, clock_timestamp())
  RETURNING * INTO v_msg;

  RETURN public.fn_widget_message_json(v_msg);
END;
$$;

-- The greeting line the widget shows after the pre-chat form. Stored with no
-- sender and metadata.is_welcome, which every rule treats as "not a person"
-- (bot control, first reply, ticket status). Only on an empty conversation.
CREATE OR REPLACE FUNCTION public.fn_widget_welcome(
  p_visitor_id UUID,
  p_token TEXT,
  p_conversation_id UUID,
  p_content TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations;
  v_content TEXT := left(btrim(coalesce(p_content, '')), 500);
  v_msg public.messages;
BEGIN
  PERFORM public.fn_widget_auth(p_visitor_id, p_token);
  v_conv := public.fn_widget_conversation(p_visitor_id, p_conversation_id);
  IF v_content = '' OR EXISTS (SELECT 1 FROM public.messages WHERE conversation_id = v_conv.id) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, is_internal, metadata, created_at)
  VALUES (v_conv.id, 'agent', NULL, v_content, false, jsonb_build_object('is_welcome', true), clock_timestamp())
  RETURNING * INTO v_msg;
  RETURN public.fn_widget_message_json(v_msg);
END;
$$;

-- The greeting is not a reply, so "reply" rules must not fire on it. Same
-- function as in 20261014090000_macros_triggers_automations.sql, plus that
-- one condition.
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
  ELSIF NEW.sender_type = 'agent'
        AND NOT (NEW.sender_id IS NULL AND coalesce(NEW.metadata ->> 'is_welcome', '') = 'true') THEN
    PERFORM public.fn_run_ticket_triggers(NEW.ticket_id, ARRAY['reply'], NULL, 'message');
  END IF;
  RETURN NEW;
END;
$$;

-- Delivered / read receipts for the team's messages in one conversation.
CREATE OR REPLACE FUNCTION public.fn_widget_mark(
  p_visitor_id UUID,
  p_token TEXT,
  p_conversation_id UUID,
  p_read BOOLEAN DEFAULT true
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations;
BEGIN
  PERFORM public.fn_widget_auth(p_visitor_id, p_token);
  v_conv := public.fn_widget_conversation(p_visitor_id, p_conversation_id);
  IF p_read THEN
    PERFORM public.fn_mark_messages_read(v_conv.id, 'visitor');
    -- The older per-conversation helper, where the project has it.
    IF to_regprocedure('public.fn_mark_conversation_messages_as_read(uuid,text)') IS NOT NULL THEN
      BEGIN
        EXECUTE 'SELECT public.fn_mark_conversation_messages_as_read($1, $2)' USING v_conv.id, 'visitor';
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  ELSE
    PERFORM public.fn_mark_messages_delivered(v_conv.id, 'visitor');
  END IF;
END;
$$;

-- Pre-chat topic → ticket tag (rules in fn_set_conversation_topic).
CREATE OR REPLACE FUNCTION public.fn_widget_set_topic(
  p_visitor_id UUID,
  p_token TEXT,
  p_conversation_id UUID,
  p_topic TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_widget_auth(p_visitor_id, p_token);
  RETURN public.fn_set_conversation_topic(p_conversation_id, p_visitor_id, p_topic);
END;
$$;

-- ----------------------------------------------------------------------------
-- The visitor's own name, email and page. Calls the project's
-- fn_upsert_visitor when it exists (created outside the migrations), so
-- whatever else it does still happens; otherwise updates the row directly.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_widget_update_visitor(
  p_visitor_id UUID,
  p_token TEXT,
  p_name TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL,
  p_current_url TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_location TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.visitor_sessions;
  v_name TEXT := nullif(left(btrim(coalesce(p_name, '')), 120), '');
  v_email TEXT := nullif(left(btrim(coalesce(p_email, '')), 254), '');
  v_url TEXT := nullif(left(coalesce(p_current_url, ''), 2000), '');
  v_ua TEXT := nullif(left(coalesce(p_user_agent, ''), 500), '');
  v_location TEXT := nullif(left(btrim(coalesce(p_location, '')), 200), '');
  v_done BOOLEAN := false;
BEGIN
  v_session := public.fn_widget_auth(p_visitor_id, p_token);
  IF v_email IS NOT NULL AND v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'email_invalid' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_upsert_visitor' AND pronamespace = 'public'::regnamespace) THEN
    BEGIN
      EXECUTE 'SELECT 1 FROM (SELECT public.fn_upsert_visitor(p_id => $1, p_name => $2, p_email => $3, p_current_url => $4,'
              ' p_user_agent => $5, p_ip_address => NULL, p_location => $6, p_workspace_id => $7)) x'
        USING p_visitor_id, v_name, v_email, v_url, v_ua, v_location, v_session.workspace_id;
      v_done := true;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[Widget] fn_upsert_visitor failed: %', SQLERRM;
    END;
  END IF;

  IF NOT v_done THEN
    UPDATE public.visitors
       SET name = coalesce(v_name, name),
           email = coalesce(v_email, email),
           current_page_url = coalesce(v_url, current_page_url),
           location = coalesce(v_location, location),
           last_seen_at = now()
     WHERE id = p_visitor_id;
  END IF;
END;
$$;

-- Team avatars and presence for the widget header (no emails).
CREATE OR REPLACE FUNCTION public.fn_widget_agents(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'avatar_url', a.avatar_url, 'status', a.status)), '[]'::jsonb)
    FROM public.agents a
   WHERE a.workspace_id = p_workspace_id
     AND coalesce((to_jsonb(a) ->> 'is_active')::boolean, true)
$$;

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.fn_widget_session(uuid, uuid, text)',
    'public.fn_widget_messages(uuid, text, uuid)',
    'public.fn_widget_conversations(uuid, text)',
    'public.fn_widget_start_conversation(uuid, text, boolean)',
    'public.fn_widget_send_message(uuid, text, uuid, text, text)',
    'public.fn_widget_welcome(uuid, text, uuid, text)',
    'public.fn_widget_mark(uuid, text, uuid, boolean)',
    'public.fn_widget_set_topic(uuid, text, uuid, text)',
    'public.fn_widget_update_visitor(uuid, text, text, text, text, text, text)',
    'public.fn_widget_agents(uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated, service_role', f);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Live updates. A visitor's own message and conversation changes go out as a
-- broadcast on their session topic. realtime.send exists on every hosted
-- Supabase project; anywhere it does not (or it fails), the change is simply
-- not pushed and the widget's polling picks it up. A broadcast can never
-- block or undo the write that caused it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_widget_broadcast(p_conversation_id UUID, p_event TEXT, p_payload JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_topic TEXT;
BEGIN
  SELECT s.topic INTO v_topic
    FROM public.conversations c
    JOIN public.visitor_sessions s ON s.visitor_id = c.visitor_id
   WHERE c.id = p_conversation_id;
  IF v_topic IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    EXECUTE 'SELECT realtime.send($1, $2, $3, false)' USING p_payload, p_event, v_topic;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_widget_broadcast(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_widget_broadcast_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.messages;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP = 'UPDATE' AND NEW.is_internal IS TRUE AND OLD.is_internal IS NOT TRUE THEN
    -- Turned into a note: take it off the visitor's screen.
    PERFORM public.fn_widget_broadcast(v_row.conversation_id, 'message', jsonb_build_object('op', 'DELETE', 'message', jsonb_build_object('id', v_row.id)));
    RETURN NULL;
  END IF;
  IF v_row.is_internal IS TRUE THEN
    RETURN NULL;
  END IF;
  PERFORM public.fn_widget_broadcast(
    v_row.conversation_id,
    'message',
    jsonb_build_object('op', TG_OP, 'message', CASE WHEN TG_OP = 'DELETE' THEN jsonb_build_object('id', v_row.id) ELSE public.fn_widget_message_json(v_row) END)
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_widget_broadcast_message ON public.messages;
CREATE TRIGGER trg_widget_broadcast_message
  AFTER INSERT OR UPDATE OR DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_widget_broadcast_message();

CREATE OR REPLACE FUNCTION public.fn_widget_broadcast_conversation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND (to_jsonb(NEW) -> 'csat_rating') IS NOT DISTINCT FROM (to_jsonb(OLD) -> 'csat_rating') THEN
    RETURN NULL;
  END IF;
  PERFORM public.fn_widget_broadcast(NEW.id, 'conversation', jsonb_build_object('op', TG_OP, 'conversation', public.fn_widget_conversation_json(NEW)));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_widget_broadcast_conversation ON public.conversations;
CREATE TRIGGER trg_widget_broadcast_conversation
  AFTER INSERT OR UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.fn_widget_broadcast_conversation();

REVOKE EXECUTE ON FUNCTION public.fn_widget_broadcast_message() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_widget_broadcast_conversation() FROM PUBLIC, anon, authenticated;
