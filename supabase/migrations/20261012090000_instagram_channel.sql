-- ============================================================================
-- Instagram on the channel framework
-- ============================================================================
--
-- Instagram direct messages arrive and leave through the same machinery as
-- WhatsApp (20261011090000_channels.sql): fn_channel_ingest_inbound turns a
-- DM, story reply or story mention into a ticket, and a trigger queues every
-- public reply for the outbound worker. This migration only teaches those
-- pieces the new channel name and Instagram's reply rules:
--
--   - A business may reply within 24 hours of the customer's last message.
--     There are no templates to fall back on, as there are on WhatsApp.
--   - With Meta's Human Agent feature (approved through App Review) a person
--     may reply for up to 7 days, sent with the HUMAN_AGENT tag. The bot may
--     not: automated replies stay inside 24 hours. Whether the workspace's
--     connection has the feature is stored on it (settings.human_agent), so
--     the rule is decided here for every writer, and the worker learns which
--     replies need the tag from metadata.channel_tag.
--
-- WhatsApp's rule is unchanged: the WhatsApp branch below is the same check
-- as before.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_is_ticket_channel(p_channel TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_channel IN ('chat', 'email', 'web_form', 'whatsapp', 'instagram');
$$;

CREATE OR REPLACE FUNCTION public.fn_channel_has_outbound(p_channel TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(p_channel IN ('whatsapp', 'instagram'), false);
$$;

-- How long after the customer's last message this sender may still reply on
-- Instagram: 7 days for a person when Human Agent is enabled, else 24 hours.
CREATE OR REPLACE FUNCTION public.fn_instagram_reply_window(p_workspace_id UUID, p_sender_type TEXT)
RETURNS INTERVAL
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_sender_type = 'agent' AND EXISTS (
      SELECT 1 FROM public.channel_connections
       WHERE workspace_id = p_workspace_id AND channel = 'instagram'
         AND coalesce((settings ->> 'human_agent')::boolean, false)
    ) THEN interval '7 days'
    ELSE interval '24 hours'
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_instagram_reply_window(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_instagram_reply_window(UUID, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_message_channel_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_channel TEXT;
  v_last TIMESTAMPTZ;
  v_ws UUID;
BEGIN
  IF coalesce(NEW.is_internal, false) OR NEW.sender_type NOT IN ('agent', 'ai') THEN
    RETURN NEW;
  END IF;
  SELECT channel, channel_last_inbound_at, workspace_id INTO v_channel, v_last, v_ws
    FROM public.conversations WHERE id = NEW.conversation_id;
  IF NOT public.fn_channel_has_outbound(v_channel) THEN
    RETURN NEW;
  END IF;

  IF v_channel = 'instagram' THEN
    IF v_last IS NULL OR v_last <= now() - public.fn_instagram_reply_window(v_ws, NEW.sender_type) THEN
      RAISE EXCEPTION 'Instagram no longer allows a reply here: the customer last wrote too long ago. Their next message reopens the conversation.'
        USING ERRCODE = 'check_violation', HINT = 'channel_window_closed';
    END IF;
    -- Past 24 hours only a person may reply, and Instagram needs the tag.
    IF v_last <= now() - interval '24 hours' THEN
      NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('channel_tag', 'HUMAN_AGENT');
    END IF;
  ELSIF public.fn_channel_template_required(v_channel, v_last)
     AND NOT (coalesce(NEW.metadata, '{}'::jsonb) ? 'channel_template') THEN
    RAISE EXCEPTION 'The 24-hour customer service window has closed. Send an approved template instead.'
      USING ERRCODE = 'check_violation', HINT = 'channel_window_closed';
  END IF;
  NEW.channel_status := 'queued';
  RETURN NEW;
END;
$$;
