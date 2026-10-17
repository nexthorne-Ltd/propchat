-- ============================================================================
-- Channels: one framework for every messaging channel, starting with WhatsApp
-- ============================================================================
--
-- Until now outside channels were bolted on: the Meta webhook dropped every
-- WhatsApp message into the *first* workspace in the table, tokens sat in
-- plain text in workspace_integrations, webhooks were not signed, retries
-- created duplicate messages, and an outbound send that failed was lost.
--
-- This migration gives every channel the same database contract:
--
--   channel_connections     One row per workspace and channel: status, the
--                           external account it is bound to (WhatsApp phone
--                           number id), the last error. Members can read it;
--                           only admins change it.
--   channel_secrets         The connection's credentials, encrypted by the
--                           app (AES-256-GCM) before they arrive here. No
--                           policy at all: only the service role reads it.
--   channel_outbound_queue  Every public agent or bot message on a channel
--                           conversation is queued here by a trigger, so it
--                           goes out whichever screen or job wrote it, and is
--                           retried with backoff until it is sent or fails
--                           for good.
--   fn_channel_ingest_inbound   Turns one inbound message into a visitor,
--                           conversation, ticket and message in a single
--                           transaction. A provider message id that was seen
--                           before is reported as a duplicate, so webhook
--                           retries never create a second message.
--   fn_channel_record_status    Delivery and read receipts.
--
-- Channel rules that must hold for every writer (the old inbox writes
-- straight to Supabase) live in triggers: outside WhatsApp's 24-hour customer
-- service window only an approved template may be sent.
--
-- Adding a channel later: allow it in fn_is_ticket_channel and
-- fn_channel_has_outbound, add its window rule to fn_channel_template_required,
-- and register an adapter in src/lib/channels/registry.ts.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tickets know which channel they came from
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_is_ticket_channel(p_channel TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_channel IN ('chat', 'email', 'web_form', 'whatsapp');
$$;

ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_channel_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_channel_check CHECK (public.fn_is_ticket_channel(channel));

-- The ticket channel for a conversation: an explicit ticket_channel (email,
-- web form) wins, then the conversation's own channel; the widget is 'chat'.
CREATE OR REPLACE FUNCTION public.fn_ticket_channel_for(p_conv public.conversations)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v TEXT := coalesce(nullif(p_conv.channel_metadata ->> 'ticket_channel', ''), p_conv.channel, 'chat');
BEGIN
  IF v = 'web' OR NOT public.fn_is_ticket_channel(v) THEN
    RETURN 'chat';
  END IF;
  RETURN v;
END;
$$;

-- Same as the ticketing migration, except the channel comes from
-- fn_ticket_channel_for, so a WhatsApp conversation opens a WhatsApp ticket.
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
    INSERT INTO public.tickets (workspace_id, conversation_id, subject, priority, type, assignee_id, tags,
                                requester_id, channel)
    VALUES (v_conv.workspace_id, v_conv.id, coalesce(v_conv.channel_metadata ->> 'ticket_subject', ''),
            coalesce(v_conv.priority, 'normal'),
            CASE WHEN v_conv.channel_metadata ->> 'ticket_type' IN ('question', 'incident', 'problem', 'task')
                 THEN v_conv.channel_metadata ->> 'ticket_type' ELSE 'question' END,
            v_conv.assigned_agent_id, coalesce(v_conv.tags, '{}'), v_conv.visitor_id,
            public.fn_ticket_channel_for(v_conv))
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

-- ----------------------------------------------------------------------------
-- 2. Columns on existing tables
-- ----------------------------------------------------------------------------

-- When the customer last wrote on this channel: WhatsApp's 24-hour window
-- is measured from it.
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS channel_last_inbound_at TIMESTAMPTZ;

-- The provider's id for the message (WhatsApp "wamid"), both directions, and
-- how far an outbound message got.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS channel_message_id TEXT,
  ADD COLUMN IF NOT EXISTS channel_status TEXT,
  ADD COLUMN IF NOT EXISTS channel_error TEXT;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_channel_status_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_channel_status_check
  CHECK (channel_status IS NULL OR channel_status IN ('queued', 'sent', 'delivered', 'read', 'failed'));

-- One message per provider id: this is what makes webhook retries harmless.
CREATE UNIQUE INDEX IF NOT EXISTS messages_channel_message_id_key
  ON public.messages (channel_message_id) WHERE channel_message_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. Connections and their secrets
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.channel_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  channel               TEXT NOT NULL CHECK (channel ~ '^[a-z][a-z_]{1,31}$'),
  status                TEXT NOT NULL DEFAULT 'disconnected'
                        CHECK (status IN ('connected', 'needs_attention', 'disconnected')),
  setup_method          TEXT CHECK (setup_method IN ('embedded_signup', 'manual')),
  -- What the team sees: "+1 555 0100 · Acme Support".
  display_name          TEXT,
  -- The provider account inbound webhooks are routed by (WhatsApp phone number id).
  external_account_id   TEXT,
  -- The business account it belongs to (WhatsApp Business Account id).
  external_business_id  TEXT,
  -- Non-secret details: verified name, quality rating, webhook mode.
  settings              JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error            TEXT,
  last_error_at         TIMESTAMPTZ,
  last_inbound_at       TIMESTAMPTZ,
  last_outbound_at      TIMESTAMPTZ,
  connected_at          TIMESTAMPTZ,
  connected_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel)
);

-- A phone number can feed only one workspace, or inbound routing is ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_account_key
  ON public.channel_connections (channel, external_account_id)
  WHERE external_account_id IS NOT NULL AND status <> 'disconnected';

CREATE TABLE IF NOT EXISTS public.channel_secrets (
  connection_id  UUID PRIMARY KEY REFERENCES public.channel_connections(id) ON DELETE CASCADE,
  workspace_id   UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- "v1:<iv>:<tag>:<ciphertext>", AES-256-GCM with CHANNEL_ENCRYPTION_KEY.
  ciphertext     TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.fn_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_channel_connections_touch ON public.channel_connections;
CREATE TRIGGER trg_channel_connections_touch
  BEFORE UPDATE ON public.channel_connections
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

ALTER TABLE public.channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_secrets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_connections_select ON public.channel_connections;
CREATE POLICY channel_connections_select ON public.channel_connections FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT public.current_user_workspace_ids()));
DROP POLICY IF EXISTS channel_connections_insert ON public.channel_connections;
CREATE POLICY channel_connections_insert ON public.channel_connections FOR INSERT TO authenticated
  WITH CHECK (public.fn_role_can(workspace_id, 'manage_settings'));
DROP POLICY IF EXISTS channel_connections_update ON public.channel_connections;
CREATE POLICY channel_connections_update ON public.channel_connections FOR UPDATE TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'))
  WITH CHECK (public.fn_role_can(workspace_id, 'manage_settings'));
DROP POLICY IF EXISTS channel_connections_delete ON public.channel_connections;
CREATE POLICY channel_connections_delete ON public.channel_connections FOR DELETE TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'));

-- channel_secrets: deliberately no policies. Even ciphertext stays server-side.
REVOKE ALL ON public.channel_secrets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.channel_connections FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_connections TO authenticated;
GRANT ALL ON public.channel_connections, public.channel_secrets TO service_role;

-- ----------------------------------------------------------------------------
-- 4. Outbound queue
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.channel_outbound_queue (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id      UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id           UUID NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  channel              TEXT NOT NULL,
  -- queued → sending → sent; or back to queued with a later next_attempt_at;
  -- or failed once the error is permanent or the attempts run out.
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 5,
  next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A worker that dies mid-send leaves the row 'sending'; after this it is claimable again.
  locked_until         TIMESTAMPTZ,
  last_error           TEXT,
  provider_message_id  TEXT,
  sent_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_outbound_queue_due_idx
  ON public.channel_outbound_queue (next_attempt_at) WHERE status IN ('queued', 'sending');

DROP TRIGGER IF EXISTS trg_channel_outbound_queue_touch ON public.channel_outbound_queue;
CREATE TRIGGER trg_channel_outbound_queue_touch
  BEFORE UPDATE ON public.channel_outbound_queue
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

ALTER TABLE public.channel_outbound_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_outbound_queue_select ON public.channel_outbound_queue;
CREATE POLICY channel_outbound_queue_select ON public.channel_outbound_queue FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT public.current_user_workspace_ids()));
-- Rows are written only by the trigger below and the service-role worker.
REVOKE ALL ON public.channel_outbound_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.channel_outbound_queue TO authenticated;
GRANT ALL ON public.channel_outbound_queue TO service_role;

-- ----------------------------------------------------------------------------
-- 5. Channel rules on messages
-- ----------------------------------------------------------------------------

-- Channels whose replies leave through an adapter (the widget reads its
-- messages over Realtime instead).
CREATE OR REPLACE FUNCTION public.fn_channel_has_outbound(p_channel TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(p_channel IN ('whatsapp'), false);
$$;

-- True when only a pre-approved template may be sent right now. WhatsApp
-- allows free-form messages for 24 hours after the customer's last message.
CREATE OR REPLACE FUNCTION public.fn_channel_template_required(p_channel TEXT, p_last_inbound TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE p_channel
    WHEN 'whatsapp' THEN p_last_inbound IS NULL OR p_last_inbound <= now() - interval '24 hours'
    ELSE false
  END;
$$;

-- Before a public agent or bot message is stored on a channel conversation:
-- refuse free text outside the window, and mark it queued.
CREATE OR REPLACE FUNCTION public.fn_message_channel_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_channel TEXT;
  v_last TIMESTAMPTZ;
BEGIN
  IF coalesce(NEW.is_internal, false) OR NEW.sender_type NOT IN ('agent', 'ai') THEN
    RETURN NEW;
  END IF;
  SELECT channel, channel_last_inbound_at INTO v_channel, v_last
    FROM public.conversations WHERE id = NEW.conversation_id;
  IF NOT public.fn_channel_has_outbound(v_channel) THEN
    RETURN NEW;
  END IF;
  IF public.fn_channel_template_required(v_channel, v_last)
     AND NOT (coalesce(NEW.metadata, '{}'::jsonb) ? 'channel_template') THEN
    RAISE EXCEPTION 'The 24-hour customer service window has closed. Send an approved template instead.'
      USING ERRCODE = 'check_violation', HINT = 'channel_window_closed';
  END IF;
  NEW.channel_status := 'queued';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_message_channel_guard ON public.messages;
CREATE TRIGGER trg_message_channel_guard
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_message_channel_guard();

CREATE OR REPLACE FUNCTION public.fn_message_enqueue_channel_send()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations;
BEGIN
  IF NEW.channel_status IS DISTINCT FROM 'queued' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_conv FROM public.conversations WHERE id = NEW.conversation_id;
  IF v_conv.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.channel_outbound_queue (workspace_id, conversation_id, message_id, channel)
  VALUES (v_conv.workspace_id, v_conv.id, NEW.id, v_conv.channel)
  ON CONFLICT (message_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_message_enqueue_channel_send ON public.messages;
CREATE TRIGGER trg_message_enqueue_channel_send
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_message_enqueue_channel_send();

-- ----------------------------------------------------------------------------
-- 6. Inbound: one message in, one transaction
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_channel_ingest_inbound(
  p_connection_id   UUID,
  p_sender_id       TEXT,
  p_sender_name     TEXT,
  p_external_id     TEXT,
  p_content         TEXT,
  p_attachment_url  TEXT DEFAULT NULL,
  p_metadata        JSONB DEFAULT '{}'::jsonb,
  p_sent_at         TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conn public.channel_connections;
  v_visitor UUID;
  v_conv public.conversations;
  v_msg public.messages;
  v_existing UUID;
  v_prev TEXT;
  v_sent TIMESTAMPTZ := least(coalesce(p_sent_at, now()), now());
BEGIN
  IF coalesce(p_sender_id, '') = '' OR coalesce(p_external_id, '') = '' THEN
    RAISE EXCEPTION 'sender and message id are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_conn FROM public.channel_connections WHERE id = p_connection_id;
  IF NOT FOUND OR v_conn.status = 'disconnected' THEN
    RAISE EXCEPTION 'channel connection % is not connected', p_connection_id USING ERRCODE = 'P0002';
  END IF;

  -- Two webhooks for the same sender arrive in parallel more often than one
  -- would think (retries, bursts): serialise per sender so they share one
  -- visitor and one conversation.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_conn.workspace_id::text || ':' || v_conn.channel || ':' || p_sender_id, 0));

  SELECT id INTO v_existing FROM public.messages WHERE channel_message_id = p_external_id;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('duplicate', true, 'message_id', v_existing);
  END IF;

  SELECT id INTO v_visitor FROM public.visitors
   WHERE workspace_id = v_conn.workspace_id AND channel = v_conn.channel AND channel_user_id = p_sender_id
   ORDER BY first_seen NULLS LAST LIMIT 1;
  IF v_visitor IS NULL THEN
    INSERT INTO public.visitors (workspace_id, channel, channel_user_id, name)
    VALUES (v_conn.workspace_id, v_conn.channel, p_sender_id, coalesce(nullif(trim(p_sender_name), ''), p_sender_id))
    RETURNING id INTO v_visitor;
  ELSIF nullif(trim(p_sender_name), '') IS NOT NULL THEN
    UPDATE public.visitors SET name = trim(p_sender_name)
     WHERE id = v_visitor AND (name IS NULL OR name = p_sender_id);
  END IF;

  -- The customer's latest conversation on this channel. A closed one is
  -- reused too: the ticket rules turn the new message into a follow-up.
  SELECT * INTO v_conv FROM public.conversations
   WHERE workspace_id = v_conn.workspace_id AND visitor_id = v_visitor AND channel = v_conn.channel
     AND merged_into IS NULL
   ORDER BY created_at DESC LIMIT 1;
  IF v_conv.id IS NULL THEN
    v_prev := public.fn_ticket_set_actor('customer', v_visitor);
    INSERT INTO public.conversations (workspace_id, visitor_id, channel, channel_user_id, status, channel_metadata)
    VALUES (v_conn.workspace_id, v_visitor, v_conn.channel, p_sender_id, 'open',
            jsonb_build_object('ticket_channel', v_conn.channel, 'connection_id', v_conn.id))
    RETURNING * INTO v_conv;
    PERFORM public.fn_ticket_restore_actor(v_prev);
  END IF;

  UPDATE public.conversations
     SET channel_last_inbound_at = greatest(coalesce(channel_last_inbound_at, v_sent), v_sent),
         channel_user_id = p_sender_id
   WHERE id = v_conv.id;

  INSERT INTO public.messages (conversation_id, sender_type, content, attachment_url, metadata, channel_message_id, is_internal)
  VALUES (v_conv.id, 'visitor', coalesce(p_content, ''), p_attachment_url, coalesce(p_metadata, '{}'::jsonb), p_external_id, false)
  RETURNING * INTO v_msg;

  UPDATE public.channel_connections
     SET last_inbound_at = now()
   WHERE id = v_conn.id;

  RETURN jsonb_build_object(
    'duplicate', false,
    'workspace_id', v_conn.workspace_id,
    'conversation_id', v_conv.id,
    'message_id', v_msg.id,
    'ticket_id', v_msg.ticket_id,
    'ai_mode', v_conv.ai_mode
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Receipts
-- ----------------------------------------------------------------------------

-- Statuses only move forward (sent → delivered → read); a late "delivered"
-- after "read" changes nothing. "failed" wins over anything but "read".
CREATE OR REPLACE FUNCTION public.fn_channel_record_status(
  p_channel_message_id TEXT,
  p_status             TEXT,
  p_at                 TIMESTAMPTZ DEFAULT now(),
  p_error              TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_msg public.messages;
  v_rank_old INT;
  v_rank_new INT;
BEGIN
  IF p_status NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    RETURN false;
  END IF;
  SELECT * INTO v_msg FROM public.messages WHERE channel_message_id = p_channel_message_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  v_rank_old := CASE v_msg.channel_status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2
                                          WHEN 'failed' THEN 3 WHEN 'read' THEN 4 ELSE 0 END;
  v_rank_new := CASE p_status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'failed' THEN 3 WHEN 'read' THEN 4 END;
  IF v_rank_new <= v_rank_old THEN
    RETURN false;
  END IF;
  UPDATE public.messages
     SET channel_status = p_status,
         channel_error = CASE WHEN p_status = 'failed' THEN left(coalesce(p_error, 'The provider could not deliver this message.'), 500) ELSE channel_error END,
         delivered_at = CASE WHEN p_status IN ('delivered', 'read') THEN coalesce(delivered_at, p_at) ELSE delivered_at END,
         read_at = CASE WHEN p_status = 'read' THEN coalesce(read_at, p_at) ELSE read_at END
   WHERE id = v_msg.id;
  RETURN true;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. The worker's side of the queue
-- ----------------------------------------------------------------------------

-- Claims due rows (optionally one message's) for this worker. SKIP LOCKED
-- lets the cron and an immediate send run side by side without sending twice.
CREATE OR REPLACE FUNCTION public.fn_claim_channel_outbound(p_limit INTEGER DEFAULT 20, p_message_id UUID DEFAULT NULL)
RETURNS SETOF public.channel_outbound_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.channel_outbound_queue q
     SET status = 'sending', attempts = q.attempts + 1, locked_until = now() + interval '2 minutes'
   WHERE q.id IN (
     SELECT id FROM public.channel_outbound_queue
      WHERE (p_message_id IS NULL OR message_id = p_message_id)
        AND ((status = 'queued' AND next_attempt_at <= now())
             OR (status = 'sending' AND locked_until < now()))
      ORDER BY created_at
      LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING q.*;
END;
$$;

-- Records the outcome of one attempt. Retryable failures back off
-- 30s, 2m, 8m, 32m; the last attempt or a permanent error fails the message.
CREATE OR REPLACE FUNCTION public.fn_complete_channel_outbound(
  p_id                  UUID,
  p_ok                  BOOLEAN,
  p_provider_message_id TEXT DEFAULT NULL,
  p_error               TEXT DEFAULT NULL,
  p_retryable           BOOLEAN DEFAULT true
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q public.channel_outbound_queue;
  v_status TEXT;
BEGIN
  SELECT * INTO v_q FROM public.channel_outbound_queue WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_ok THEN
    UPDATE public.channel_outbound_queue
       SET status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id,
           last_error = NULL, locked_until = NULL
     WHERE id = p_id;
    UPDATE public.messages
       SET channel_message_id = coalesce(p_provider_message_id, channel_message_id),
           channel_status = CASE WHEN channel_status IN ('delivered', 'read') THEN channel_status ELSE 'sent' END,
           channel_error = NULL
     WHERE id = v_q.message_id;
    UPDATE public.channel_connections
       SET last_outbound_at = now()
     WHERE workspace_id = v_q.workspace_id AND channel = v_q.channel;
    RETURN 'sent';
  END IF;

  v_status := CASE WHEN p_retryable AND v_q.attempts < v_q.max_attempts THEN 'queued' ELSE 'failed' END;
  UPDATE public.channel_outbound_queue
     SET status = v_status,
         last_error = left(p_error, 1000),
         locked_until = NULL,
         next_attempt_at = CASE WHEN v_status = 'queued'
                                THEN now() + (interval '30 seconds' * power(4, greatest(v_q.attempts - 1, 0)))
                                ELSE next_attempt_at END
   WHERE id = p_id;
  IF v_status = 'failed' THEN
    UPDATE public.messages
       SET channel_status = 'failed', channel_error = left(coalesce(p_error, 'Could not send.'), 500)
     WHERE id = v_q.message_id;
  END IF;
  RETURN v_status;
END;
$$;

-- Lets an admin retry a message that failed for good (after fixing the token).
CREATE OR REPLACE FUNCTION public.fn_retry_channel_message(p_message_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q public.channel_outbound_queue;
BEGIN
  SELECT * INTO v_q FROM public.channel_outbound_queue WHERE message_id = p_message_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nothing to retry.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.fn_role_can(v_q.workspace_id, 'reply') THEN
    RAISE EXCEPTION 'Forbidden: you cannot reply in this workspace.' USING ERRCODE = '42501';
  END IF;
  IF v_q.status <> 'failed' THEN
    RETURN;
  END IF;
  UPDATE public.channel_outbound_queue
     SET status = 'queued', attempts = 0, next_attempt_at = now(), last_error = NULL
   WHERE id = v_q.id;
  UPDATE public.messages SET channel_status = 'queued', channel_error = NULL WHERE id = p_message_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_channel_ingest_inbound(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_channel_record_status(TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_claim_channel_outbound(INTEGER, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_complete_channel_outbound(UUID, BOOLEAN, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_retry_channel_message(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_channel_ingest_inbound(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_channel_record_status(TEXT, TEXT, TIMESTAMPTZ, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_claim_channel_outbound(INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_complete_channel_outbound(UUID, BOOLEAN, TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_retry_channel_message(UUID) TO authenticated, service_role;

-- Agents see receipts and failures appear on their messages live.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND tablename = 'channel_connections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.channel_connections;
  END IF;
END $$;
