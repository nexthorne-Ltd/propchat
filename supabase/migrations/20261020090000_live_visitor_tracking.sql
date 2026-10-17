-- ============================================================================
-- Migration: 20261020090000_live_visitor_tracking.sql
-- Description: Live website visitor tracking with page URL, title, referrer,
--              time on page, SPA navigation tracking, and offline expiry.
-- ============================================================================

-- 1. Ensure columns exist on visitors table
ALTER TABLE public.visitors
  ADD COLUMN IF NOT EXISTS current_page_url TEXT NOT NULL DEFAULT '/',
  ADD COLUMN IF NOT EXISTS current_page_title TEXT,
  ADD COLUMN IF NOT EXISTS referrer_source TEXT,
  ADD COLUMN IF NOT EXISTS current_page_entered_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS time_on_page_seconds INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT now();

-- 2. Ensure visitor_page_history table exists with all required columns
CREATE TABLE IF NOT EXISTS public.visitor_page_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id UUID NOT NULL REFERENCES public.visitors(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  referrer TEXT,
  duration_seconds INT DEFAULT 0,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure columns exist in case table was created earlier
ALTER TABLE public.visitor_page_history
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS referrer TEXT,
  ADD COLUMN IF NOT EXISTS duration_seconds INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS visited_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Indexes for fast lookup of visitor trails and workspace metrics
CREATE INDEX IF NOT EXISTS idx_visitor_page_history_visitor_visited
  ON public.visitor_page_history (visitor_id, visited_at DESC);

CREATE INDEX IF NOT EXISTS idx_visitor_page_history_workspace_visited
  ON public.visitor_page_history (workspace_id, visited_at DESC);

-- Enable Row Level Security on visitor_page_history
ALTER TABLE public.visitor_page_history ENABLE ROW LEVEL SECURITY;

-- Policy: anon visitors can insert page history records
DROP POLICY IF EXISTS "visitor_page_history_anon_insert" ON public.visitor_page_history;
CREATE POLICY "visitor_page_history_anon_insert" ON public.visitor_page_history
  FOR INSERT TO anon
  WITH CHECK (true);

-- Policy: authenticated agents can read page history for visitors in their workspaces
DROP POLICY IF EXISTS "visitor_page_history_agent_select" ON public.visitor_page_history;
CREATE POLICY "visitor_page_history_agent_select" ON public.visitor_page_history
  FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT public.current_user_workspace_ids())
    OR EXISTS (
      SELECT 1 FROM public.visitors v
      WHERE v.id = visitor_page_history.visitor_id
        AND (v.workspace_id IN (SELECT public.current_user_workspace_ids()) OR public.is_current_user_super_admin())
    )
    OR public.is_current_user_super_admin()
  );

-- 3. Function: fn_visitor_heartbeat
-- Called by widget heartbeat ping every 15-20s. Updates presence, current page & time on page.
DROP FUNCTION IF EXISTS public.fn_visitor_heartbeat(UUID, TEXT);
DROP FUNCTION IF EXISTS public.fn_visitor_heartbeat(UUID, TEXT, TEXT, TEXT, INT);
CREATE OR REPLACE FUNCTION public.fn_visitor_heartbeat(
  p_visitor_id UUID,
  p_current_url TEXT DEFAULT NULL,
  p_page_title TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_time_on_page INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  UPDATE public.visitors
  SET
    last_seen = v_now,
    last_seen_at = v_now,
    is_online = true,
    current_url = COALESCE(p_current_url, current_url),
    current_page_url = COALESCE(p_current_url, current_page_url),
    current_page_title = COALESCE(p_page_title, current_page_title),
    referrer_source = COALESCE(p_referrer, referrer_source),
    time_on_page_seconds = COALESCE(p_time_on_page, time_on_page_seconds)
  WHERE id = p_visitor_id;

  RETURN jsonb_build_object('success', true, 'last_seen', v_now);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_visitor_heartbeat(UUID, TEXT, TEXT, TEXT, INT) TO anon, authenticated, service_role;

-- 4. Function: fn_record_visitor_page
-- Called on initial page load and on SPA route changes.
-- Records page visit to visitor_page_history and updates visitor record.
DROP FUNCTION IF EXISTS public.fn_record_visitor_page(UUID, TEXT, TEXT, TEXT, INT, UUID);
CREATE OR REPLACE FUNCTION public.fn_record_visitor_page(
  p_visitor_id UUID,
  p_url TEXT,
  p_title TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_duration_seconds INT DEFAULT 0,
  p_workspace_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_history_id UUID;
  v_ws_id UUID := p_workspace_id;
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Resolve workspace_id from visitor if not explicitly provided
  IF v_ws_id IS NULL THEN
    SELECT workspace_id INTO v_ws_id FROM public.visitors WHERE id = p_visitor_id;
  END IF;

  -- Insert new page history entry
  INSERT INTO public.visitor_page_history (
    visitor_id,
    workspace_id,
    url,
    title,
    referrer,
    duration_seconds,
    visited_at
  ) VALUES (
    p_visitor_id,
    v_ws_id,
    p_url,
    p_title,
    p_referrer,
    COALESCE(p_duration_seconds, 0),
    v_now
  ) RETURNING id INTO v_history_id;

  -- Update visitor live state
  UPDATE public.visitors
  SET
    last_seen = v_now,
    last_seen_at = v_now,
    is_online = true,
    current_url = p_url,
    current_page_url = p_url,
    current_page_title = p_title,
    referrer_source = COALESCE(p_referrer, referrer_source),
    current_page_entered_at = v_now,
    time_on_page_seconds = 0
  WHERE id = p_visitor_id;

  RETURN jsonb_build_object('success', true, 'history_id', v_history_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_record_visitor_page(UUID, TEXT, TEXT, TEXT, INT, UUID) TO anon, authenticated, service_role;

-- 5. Function: fn_visitor_offline
-- Marks visitor as offline upon pagehide / beforeunload beacon.
DROP FUNCTION IF EXISTS public.fn_visitor_offline(UUID);
CREATE OR REPLACE FUNCTION public.fn_visitor_offline(p_visitor_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.visitors
  SET is_online = false, last_seen_at = now()
  WHERE id = p_visitor_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_visitor_offline(UUID) TO anon, authenticated, service_role;

-- 6. Function: fn_expire_stale_visitors
-- Explicit utility to expire any visitor inactive for longer than p_stale_seconds (default 90).
DROP FUNCTION IF EXISTS public.fn_expire_stale_visitors(INT);
CREATE OR REPLACE FUNCTION public.fn_expire_stale_visitors(p_stale_seconds INT DEFAULT 90)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE public.visitors
  SET is_online = false
  WHERE is_online = true
    AND last_seen_at < (now() - (p_stale_seconds || ' seconds')::interval);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_expire_stale_visitors(INT) TO anon, authenticated, service_role;
