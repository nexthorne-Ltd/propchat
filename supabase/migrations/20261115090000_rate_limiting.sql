-- ============================================================================
-- Migration: 20261115090000_rate_limiting.sql
-- Description: Rate limiting primitives and enforcement for widget sessions & messages.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Rate limit storage and evaluation functions
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
  bucket TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits INT NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_hits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rate_limit_hits TO service_role;

CREATE OR REPLACE FUNCTION public.fn_rate_limit(
  p_bucket TEXT,
  p_max INT,
  p_window_seconds INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_hits INT;
BEGIN
  IF p_bucket IS NULL OR p_max IS NULL OR p_window_seconds IS NULL OR p_window_seconds <= 0 THEN
    RETURN true;
  END IF;

  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  INSERT INTO public.rate_limit_hits (bucket, window_start, hits)
  VALUES (p_bucket, v_window_start, 1)
  ON CONFLICT (bucket, window_start)
  DO UPDATE SET hits = public.rate_limit_hits.hits + 1
  RETURNING hits INTO v_hits;

  RETURN v_hits <= p_max;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_rate_limit(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rate_limit(TEXT, INT, INT) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_rate_limit_cleanup()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM public.rate_limit_hits
   WHERE window_start < now() - interval '1 day';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_rate_limit_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rate_limit_cleanup() TO service_role;

-- ----------------------------------------------------------------------------
-- 2. Widget functions with rate limiting
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
  w RECORD;
BEGIN
  IF p_workspace_id IS NULL OR p_visitor_id IS NULL THEN
    RAISE EXCEPTION 'visitor_session_invalid' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO w FROM public.workspaces WHERE id = p_workspace_id;
  IF (to_jsonb(w) ->> 'is_suspended')::boolean IS TRUE
     OR (to_jsonb(w) ->> 'deleted_at') IS NOT NULL THEN
    RAISE EXCEPTION 'workspace_unavailable' USING ERRCODE = 'P0002';
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
    IF NOT public.fn_rate_limit('ws_session:' || p_workspace_id::text, 300, 60) THEN
      RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

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

GRANT EXECUTE ON FUNCTION public.fn_widget_session(UUID, UUID, TEXT) TO anon, authenticated, service_role;

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

  IF NOT public.fn_rate_limit('visitor_msg_m:' || p_visitor_id::text, 20, 60)
     OR NOT public.fn_rate_limit('visitor_msg_d:' || p_visitor_id::text, 300, 86400) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;

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

GRANT EXECUTE ON FUNCTION public.fn_widget_send_message(UUID, TEXT, UUID, TEXT, TEXT) TO anon, authenticated, service_role;
