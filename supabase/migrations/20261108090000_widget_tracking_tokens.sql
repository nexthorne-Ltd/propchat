-- ============================================================================
-- Visitor tracking behind the session token (docs/AUDIT.md H-3, follow-up)
--
-- After 20261107090000 the widget can no longer read anyone's chats, but the
-- tracking functions it still called took a bare visitor id: with the public
-- key anyone could mark any visitor online or offline, rewrite their current
-- page, timezone and language, or add page-history rows to any workspace
-- (fn_record_visitor_page even took the workspace id from the caller).
--
-- These fn_widget_* versions check the visitor's session token first and
-- take the workspace from the session. The originals stay for signed-in
-- agents and server code, but not for the anon key. The API routes the widget
-- and tracker.js call (/api/tracking, /api/visitor/geo, /api/csat/rate) check
-- the same token on the server through fn_widget_auth.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_widget_heartbeat(
  p_visitor_id UUID,
  p_token TEXT,
  p_current_url TEXT DEFAULT NULL,
  p_page_title TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_time_on_page INT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_widget_auth(p_visitor_id, p_token);
  PERFORM public.fn_visitor_heartbeat(
    p_visitor_id,
    left(p_current_url, 2000),
    left(p_page_title, 300),
    left(p_referrer, 2000),
    greatest(0, least(coalesce(p_time_on_page, 0), 86400))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_widget_record_page(
  p_visitor_id UUID,
  p_token TEXT,
  p_url TEXT,
  p_title TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_duration_seconds INT DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.visitor_sessions;
BEGIN
  v_session := public.fn_widget_auth(p_visitor_id, p_token);
  IF coalesce(btrim(p_url), '') = '' THEN
    RETURN;
  END IF;
  PERFORM public.fn_record_visitor_page(
    p_visitor_id,
    left(p_url, 2000),
    left(p_title, 300),
    left(p_referrer, 2000),
    greatest(0, least(coalesce(p_duration_seconds, 0), 86400)),
    v_session.workspace_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_widget_offline(p_visitor_id UUID, p_token TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_widget_auth(p_visitor_id, p_token);
  PERFORM public.fn_visitor_offline(p_visitor_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_widget_update_meta(
  p_visitor_id UUID,
  p_token TEXT,
  p_timezone TEXT DEFAULT NULL,
  p_language TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_widget_auth(p_visitor_id, p_token);
  PERFORM public.fn_update_visitor_meta(p_visitor_id, left(p_timezone, 64), left(p_language, 35));
END;
$$;

DO $$
DECLARE
  f TEXT;
  r RECORD;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.fn_widget_heartbeat(uuid, text, text, text, text, integer)',
    'public.fn_widget_record_page(uuid, text, text, text, text, integer)',
    'public.fn_widget_offline(uuid, text)',
    'public.fn_widget_update_meta(uuid, text, text, text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated, service_role', f);
  END LOOP;

  -- The id-only originals: no longer reachable with the public key.
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('fn_visitor_heartbeat', 'fn_record_visitor_page', 'fn_visitor_offline', 'fn_update_visitor_meta')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;

-- The API routes check tokens with the service role.
GRANT EXECUTE ON FUNCTION public.fn_widget_auth(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_widget_session(UUID, UUID, TEXT) TO service_role;
