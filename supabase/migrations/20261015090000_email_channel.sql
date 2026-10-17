-- ============================================================================
-- Email as a support channel
-- ============================================================================
--
-- Email joins WhatsApp and Instagram on the channel framework
-- (20261011090000_channels.sql). Each workspace gets a support address on the
-- platform's inbound domain; inbound mail becomes tickets through
-- fn_email_ingest_inbound, and every public agent or bot message on an email
-- conversation is queued for the outbound worker like any other channel.
--
-- What is specific to email, and so lives here:
--
--   * Threading. A reply joins its ticket by (1) the Message-ID it answers
--     (In-Reply-To / References) matched to a message we stored, (2) the signed
--     token in the address it was sent to (acme+t1042-<hmac>@...), or (3) the
--     [#1042] in the subject, which is only believed when the sender is that
--     ticket's requester or someone already copied on it. A subject alone never
--     joins a ticket, so a stranger cannot write into one by guessing a number.
--   * Loops. Automatic mail and bounces never reach this function (the app
--     classifies them first); here a sender that mails more than 15 times in 10
--     minutes is refused as a last line of defence, and hard bounces suppress the
--     address so we stop mailing it (email_suppressions).
--   * Bookkeeping the admin can read: email_inbound_log says what happened to
--     every email, including the ones that made no ticket and why.
--   * A trigger action, notify_requester (received / replied / solved), so the
--     requester notifications are rules like any other.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Email conversations send through the outbound worker
-- ----------------------------------------------------------------------------

-- Only conversations whose channel is 'email' are affected: tickets an agent
-- logged by hand keep conversation.channel = 'web' and their SMTP replies.
CREATE OR REPLACE FUNCTION public.fn_channel_has_outbound(p_channel TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(p_channel IN ('whatsapp', 'instagram', 'email'), false);
$$;

-- Inbound replies are found by the id of the message they answer, or by the id
-- our provider assigned to it.
CREATE INDEX IF NOT EXISTS messages_email_provider_id_idx
  ON public.messages ((metadata ->> 'email_provider_id')) WHERE metadata ? 'email_provider_id';

-- ----------------------------------------------------------------------------
-- 2. What happened to each email, and addresses we must not mail
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.email_inbound_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  message_id    TEXT,
  from_email    TEXT,
  subject       TEXT,
  outcome       TEXT NOT NULL CHECK (outcome IN (
                  'ticket_created', 'ticket_updated', 'duplicate', 'ignored_auto_reply', 'ignored_bounce',
                  'ignored_loop', 'ignored_invalid', 'forwarding_verified', 'failed')),
  detail        TEXT,
  ticket_id     UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_inbound_log_ws_idx ON public.email_inbound_log (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.email_suppressions (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email        TEXT NOT NULL CHECK (email = lower(email)),
  reason       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, email)
);

ALTER TABLE public.email_inbound_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;

-- Owners and admins read the log and the suppression list; admins can lift a
-- suppression. Writes come from the webhook (service role) and the functions below.
DROP POLICY IF EXISTS email_inbound_log_select ON public.email_inbound_log;
CREATE POLICY email_inbound_log_select ON public.email_inbound_log FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'));

DROP POLICY IF EXISTS email_suppressions_select ON public.email_suppressions;
CREATE POLICY email_suppressions_select ON public.email_suppressions FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'));

DROP POLICY IF EXISTS email_suppressions_delete ON public.email_suppressions;
CREATE POLICY email_suppressions_delete ON public.email_suppressions FOR DELETE TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'));

REVOKE ALL ON public.email_inbound_log, public.email_suppressions FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.email_inbound_log FROM authenticated;
REVOKE INSERT, UPDATE ON public.email_suppressions FROM authenticated;
GRANT SELECT ON public.email_inbound_log TO authenticated;
GRANT SELECT, DELETE ON public.email_suppressions TO authenticated;
GRANT ALL ON public.email_inbound_log, public.email_suppressions TO service_role;

-- ----------------------------------------------------------------------------
-- 3. Inbound: one email in, one transaction
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_email_ingest_inbound(
  p_connection_id            UUID,
  p_from_email               TEXT,
  p_from_name                TEXT,
  p_message_id               TEXT,
  p_in_reply_to              TEXT,
  p_references               TEXT[],
  p_verified_ticket_number   INTEGER,
  p_subject_ticket_number    INTEGER,
  p_subject                  TEXT,
  p_content                  TEXT,
  p_attachments              JSONB,
  p_metadata                 JSONB,
  p_cc                       JSONB,
  p_sent_at                  TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conn public.channel_connections;
  v_email TEXT := lower(trim(coalesce(p_from_email, '')));
  v_mid TEXT := lower(trim(coalesce(p_message_id, '')));
  v_visitor UUID;
  v_conv public.conversations;
  v_conv_id UUID;
  v_matched TEXT := 'new';
  v_ids TEXT[];
  v_locals TEXT[];
  v_msg public.messages;
  v_existing UUID;
  v_prev TEXT;
  v_sent TIMESTAMPTZ := least(coalesce(p_sent_at, now()), now());
  v_cc JSONB;
  v_number INTEGER;
  v_attachment_url TEXT;
BEGIN
  IF v_email = '' OR v_mid = '' THEN
    RAISE EXCEPTION 'sender and message id are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_conn FROM public.channel_connections WHERE id = p_connection_id AND channel = 'email';
  IF NOT FOUND OR v_conn.status = 'disconnected' THEN
    RAISE EXCEPTION 'email channel connection % is not connected', p_connection_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_conn.workspace_id::text || ':email:' || v_email, 0));

  SELECT id INTO v_existing FROM public.messages WHERE channel_message_id = v_mid;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('duplicate', true, 'message_id', v_existing);
  END IF;

  -- One requester per email address: reuse a visitor the workspace already
  -- knows (a chat visitor who left their email, a ticket an agent logged).
  SELECT id INTO v_visitor FROM public.visitors
   WHERE workspace_id = v_conn.workspace_id AND lower(email) = v_email
   ORDER BY first_seen NULLS LAST LIMIT 1;
  IF v_visitor IS NULL THEN
    INSERT INTO public.visitors (workspace_id, channel, channel_user_id, name, email)
    VALUES (v_conn.workspace_id, 'email', v_email, coalesce(nullif(trim(p_from_name), ''), split_part(v_email, '@', 1)), v_email)
    RETURNING id INTO v_visitor;
  ELSIF nullif(trim(p_from_name), '') IS NOT NULL THEN
    UPDATE public.visitors SET name = trim(p_from_name)
     WHERE id = v_visitor AND (name IS NULL OR name = '' OR name = split_part(v_email, '@', 1));
  END IF;

  -- Last line of defence against a robot we failed to recognise.
  IF (SELECT count(*) FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
       WHERE c.workspace_id = v_conn.workspace_id AND c.visitor_id = v_visitor AND m.sender_type = 'visitor'
         AND m.created_at > now() - interval '10 minutes') >= 15 THEN
    RAISE EXCEPTION 'Too many emails from %: paused', v_email USING ERRCODE = '54000', HINT = 'email_rate_limited';
  END IF;

  -- 1. The message this one answers.
  v_ids := ARRAY(
    SELECT DISTINCT lower(trim(x)) FROM unnest(coalesce(p_references, '{}') || ARRAY[coalesce(p_in_reply_to, '')]) x
     WHERE trim(x) <> '');
  v_locals := ARRAY(SELECT split_part(x, '@', 1) FROM unnest(v_ids) x);
  IF array_length(v_ids, 1) > 0 THEN
    SELECT m.conversation_id INTO v_conv_id
      FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
     WHERE c.workspace_id = v_conn.workspace_id
       AND (m.channel_message_id = ANY (v_ids) OR m.metadata ->> 'email_provider_id' = ANY (v_locals))
     ORDER BY m.created_at DESC LIMIT 1;
    IF v_conv_id IS NOT NULL THEN v_matched := 'header'; END IF;
  END IF;

  -- 2. The signed token in the address (the app has already checked its signature).
  IF v_conv_id IS NULL AND p_verified_ticket_number IS NOT NULL THEN
    SELECT conversation_id INTO v_conv_id FROM public.tickets
     WHERE workspace_id = v_conn.workspace_id AND number = p_verified_ticket_number AND conversation_id IS NOT NULL;
    IF v_conv_id IS NOT NULL THEN v_matched := 'token'; END IF;
  END IF;

  -- 3. [#1042] in the subject, believed only from someone who belongs on that ticket.
  IF v_conv_id IS NULL AND p_subject_ticket_number IS NOT NULL THEN
    SELECT t.conversation_id INTO v_conv_id
      FROM public.tickets t
      LEFT JOIN public.visitors rv ON rv.id = t.requester_id
     WHERE t.workspace_id = v_conn.workspace_id AND t.number = p_subject_ticket_number AND t.conversation_id IS NOT NULL
       AND (lower(rv.email) = v_email OR EXISTS (
             SELECT 1 FROM public.conversations c2, jsonb_array_elements(coalesce(c2.channel_metadata -> 'email_cc', '[]'::jsonb)) e
              WHERE c2.id = t.conversation_id AND lower(e ->> 'email') = v_email));
    IF v_conv_id IS NOT NULL THEN v_matched := 'subject'; END IF;
  END IF;

  IF v_conv_id IS NOT NULL THEN
    SELECT * INTO v_conv FROM public.conversations WHERE id = v_conv_id AND workspace_id = v_conn.workspace_id;
  END IF;

  IF v_conv.id IS NULL THEN
    v_matched := 'new';
    v_prev := public.fn_ticket_set_actor('customer', v_visitor);
    INSERT INTO public.conversations (workspace_id, visitor_id, channel, channel_user_id, status, channel_metadata)
    VALUES (v_conn.workspace_id, v_visitor, 'email', v_email, 'open',
            jsonb_build_object('ticket_channel', 'email', 'connection_id', v_conn.id,
                               'ticket_subject', left(coalesce(nullif(trim(p_subject), ''), '(no subject)'), 250),
                               'email_cc', '[]'::jsonb))
    RETURNING * INTO v_conv;
    PERFORM public.fn_ticket_restore_actor(v_prev);
  END IF;

  -- Everyone copied on the thread, minus the requester, kept to 20: replies go to them too.
  SELECT coalesce(jsonb_agg(j), '[]'::jsonb) INTO v_cc FROM (
    SELECT DISTINCT ON (lower(e ->> 'email')) jsonb_build_object('email', lower(e ->> 'email'), 'name', coalesce(e ->> 'name', '')) AS j
      FROM jsonb_array_elements(
             coalesce(v_conv.channel_metadata -> 'email_cc', '[]'::jsonb) || coalesce(p_cc, '[]'::jsonb) ||
             CASE WHEN v_email <> lower(coalesce(v_conv.channel_user_id, ''))
                  THEN jsonb_build_array(jsonb_build_object('email', v_email, 'name', coalesce(p_from_name, ''))) ELSE '[]'::jsonb END) e
     WHERE coalesce(e ->> 'email', '') <> '' AND lower(e ->> 'email') <> lower(coalesce(v_conv.channel_user_id, ''))
       AND lower(e ->> 'email') <> lower(v_conn.external_account_id)
     ORDER BY lower(e ->> 'email')
     LIMIT 20) s;

  UPDATE public.conversations
     SET channel_last_inbound_at = greatest(coalesce(channel_last_inbound_at, v_sent), v_sent),
         channel_metadata = jsonb_set(coalesce(channel_metadata, '{}'::jsonb), '{email_cc}', v_cc)
   WHERE id = v_conv.id;

  v_attachment_url := (SELECT a ->> 'url' FROM jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) a
                        WHERE NOT coalesce((a ->> 'inline')::boolean, false) AND coalesce(a ->> 'url', '') <> '' LIMIT 1);

  INSERT INTO public.messages (conversation_id, sender_type, content, attachment_url, metadata, channel_message_id, is_internal)
  VALUES (v_conv.id, 'visitor', coalesce(p_content, ''), v_attachment_url,
          coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('channel_type', 'email', 'attachments', coalesce(p_attachments, '[]'::jsonb)),
          v_mid, false)
  RETURNING * INTO v_msg;

  UPDATE public.channel_connections SET last_inbound_at = now() WHERE id = v_conn.id;

  SELECT number INTO v_number FROM public.tickets WHERE id = v_msg.ticket_id;
  RETURN jsonb_build_object(
    'duplicate', false,
    'workspace_id', v_conn.workspace_id,
    'conversation_id', v_conv.id,
    'message_id', v_msg.id,
    'ticket_id', v_msg.ticket_id,
    'ticket_number', v_number,
    'created', v_matched = 'new',
    'matched_by', v_matched,
    'ai_mode', v_conv.ai_mode);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_email_ingest_inbound(UUID, TEXT, TEXT, TEXT, TEXT, TEXT[], INTEGER, INTEGER, TEXT, TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_email_ingest_inbound(UUID, TEXT, TEXT, TEXT, TEXT, TEXT[], INTEGER, INTEGER, TEXT, TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ) TO service_role;

-- A bounce report arrived for something we sent: mark that message failed, tell
-- the agents on the ticket, and stop mailing an address that does not exist.
CREATE OR REPLACE FUNCTION public.fn_email_record_bounce(
  p_connection_id UUID, p_original_message_id TEXT, p_recipient TEXT, p_reason TEXT, p_hard BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conn public.channel_connections;
  v_msg public.messages;
  v_conv public.conversations;
  v_orig TEXT := lower(trim(coalesce(p_original_message_id, '')));
  v_to TEXT := lower(trim(coalesce(p_recipient, '')));
BEGIN
  SELECT * INTO v_conn FROM public.channel_connections WHERE id = p_connection_id AND channel = 'email';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'email channel connection % not found', p_connection_id USING ERRCODE = 'P0002';
  END IF;

  IF v_orig <> '' THEN
    SELECT m.* INTO v_msg
      FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
     WHERE c.workspace_id = v_conn.workspace_id
       AND (m.channel_message_id = v_orig OR m.metadata ->> 'email_provider_id' = split_part(v_orig, '@', 1))
     LIMIT 1;
  END IF;

  IF v_msg.id IS NOT NULL THEN
    SELECT * INTO v_conv FROM public.conversations WHERE id = v_msg.conversation_id;
    IF v_to = '' THEN v_to := lower(coalesce(v_conv.channel_user_id, '')); END IF;
    UPDATE public.messages SET channel_status = 'failed', channel_error = left(coalesce(p_reason, 'Bounced'), 500) WHERE id = v_msg.id;
    INSERT INTO public.messages (conversation_id, sender_type, content, is_internal, metadata)
    VALUES (v_conv.id, 'system',
            'Email to ' || coalesce(nullif(v_to, ''), 'the requester') || ' bounced: ' || left(coalesce(p_reason, 'not delivered'), 300),
            true, jsonb_build_object('email_bounce', true));
  END IF;

  IF coalesce(p_hard, false) AND v_to LIKE '%@%' AND v_to <> lower(v_conn.external_account_id) THEN
    INSERT INTO public.email_suppressions (workspace_id, email, reason)
    VALUES (v_conn.workspace_id, v_to, left(coalesce(p_reason, 'Bounced'), 300))
    ON CONFLICT (workspace_id, email) DO UPDATE SET reason = EXCLUDED.reason, created_at = now();
  END IF;

  RETURN jsonb_build_object('matched', v_msg.id IS NOT NULL, 'recipient', v_to, 'workspace_id', v_conn.workspace_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_email_record_bounce(UUID, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_email_record_bounce(UUID, TEXT, TEXT, TEXT, BOOLEAN) TO service_role;

-- ----------------------------------------------------------------------------
-- 4. Requester notifications as a trigger action
-- ----------------------------------------------------------------------------

-- Same as 20261014090000_macros_triggers_automations.sql, plus the
-- notify_requester action (received / replied / solved).
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
    ELSIF v_type = 'notify_requester' AND p_allow_outbound THEN
      IF NOT (v_val #>> '{}') IN ('received', 'replied', 'solved') THEN
        RAISE EXCEPTION 'Choose which notification to send: received, replied or solved.' USING ERRCODE = '22023';
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
  v_name TEXT;
  v_reply TEXT;
  v_agent TEXT;
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
      ELSIF a->>'type' = 'notify_requester' THEN
        -- Needs the email channel. "We received your request" is only for mail
        -- that actually arrived by email: a ticket an agent logged by hand
        -- (its conversation is not an email one) is not a customer writing in.
        IF EXISTS (SELECT 1 FROM public.channel_connections WHERE workspace_id = t.workspace_id AND channel = 'email' AND status <> 'disconnected')
           AND NOT (a->>'value' = 'received' AND NOT EXISTS (
                      SELECT 1 FROM public.conversations c WHERE c.id = t.conversation_id AND c.channel = 'email')) THEN
          SELECT v.email, v.name INTO v_email, v_name FROM public.visitors v WHERE v.id = t.requester_id;
          IF coalesce(v_email, '') <> '' THEN
            SELECT m.content, coalesce(ag.name, '') INTO v_reply, v_agent
              FROM public.messages m LEFT JOIN public.agents ag ON ag.id = m.sender_id
             WHERE m.ticket_id = t.id AND m.sender_type = 'agent' AND NOT coalesce(m.is_internal, false)
             ORDER BY m.created_at DESC LIMIT 1;
            INSERT INTO public.automation_outbox (workspace_id, ticket_id, rule_id, kind, payload)
            VALUES (t.workspace_id, t.id, r.id, 'email_requester', jsonb_build_object(
              'to', v_email,
              'template', a->>'value',
              'requester_name', coalesce(v_name, ''),
              'ticket_number', t.number,
              'ticket_subject', t.subject,
              'reply', left(coalesce(v_reply, ''), 5000),
              'agent_name', coalesce(nullif(v_agent, ''), '')));
            v_outbound := true;
          END IF;
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

-- Rules for the three notifications, added when the email channel is enabled.
-- Confirmation and "solved" are for email tickets and start on; "an agent
-- replied" is for chat and web-form tickets (an email ticket's reply already
-- is the email) and starts off, since a chat visitor may be reading the reply
-- live. Existing rules with the same names are left as they are.
CREATE OR REPLACE FUNCTION public.fn_install_email_notification_rules(p_workspace_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pos INTEGER;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.fn_role_can(p_workspace_id, 'manage_settings') THEN
    RAISE EXCEPTION 'Only owners and admins can add rules.' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(max(position), 0) INTO v_pos FROM public.automation_rules WHERE workspace_id = p_workspace_id AND kind = 'trigger';

  IF NOT EXISTS (SELECT 1 FROM public.automation_rules WHERE workspace_id = p_workspace_id AND name = 'Email: confirm we received the request') THEN
    INSERT INTO public.automation_rules (workspace_id, kind, name, description, is_active, position, match_mode, conditions, actions)
    VALUES (p_workspace_id, 'trigger', 'Email: confirm we received the request',
      'Emails the requester when a new email ticket is created.', true, v_pos + 1, 'all',
      '[{"field":"changed","op":"is","value":"created"},{"field":"channel","op":"is","value":"email"},{"field":"requester_email","op":"is_not_empty"}]',
      '[{"type":"notify_requester","value":"received"}]');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.automation_rules WHERE workspace_id = p_workspace_id AND name = 'Email: tell the requester it was solved') THEN
    INSERT INTO public.automation_rules (workspace_id, kind, name, description, is_active, position, match_mode, conditions, actions)
    VALUES (p_workspace_id, 'trigger', 'Email: tell the requester it was solved',
      'Emails the requester when an email ticket is marked solved. They can reply to reopen it.', true, v_pos + 2, 'all',
      '[{"field":"changed","op":"is","value":"status"},{"field":"status","op":"is","value":"solved"},{"field":"channel","op":"is","value":"email"},{"field":"requester_email","op":"is_not_empty"}]',
      '[{"type":"notify_requester","value":"solved"}]');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.automation_rules WHERE workspace_id = p_workspace_id AND name = 'Email: send chat replies to the requester') THEN
    INSERT INTO public.automation_rules (workspace_id, kind, name, description, is_active, position, match_mode, conditions, actions)
    VALUES (p_workspace_id, 'trigger', 'Email: send chat replies to the requester',
      'Emails an agent''s reply to a chat or web-form requester who gave an email address. Switched off: enable it if visitors often leave before you answer.', false, v_pos + 3, 'all',
      '[{"field":"changed","op":"is","value":"reply"},{"field":"channel","op":"in","value":["chat","web_form"]},{"field":"requester_email","op":"is_not_empty"}]',
      '[{"type":"notify_requester","value":"replied"}]');
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_install_email_notification_rules(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_install_email_notification_rules(UUID) TO authenticated, service_role;
