-- ============================================================================
-- Migration: 20261114090000_widget_session_workspace_status.sql
-- Description: Refuse widget session for suspended or deleted workspaces with
--              workspace_unavailable (ERRCODE 'P0002').
-- ============================================================================

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
