-- ============================================================================
-- Migration: 20261021090000_super_admin_polish.sql
-- Description: Platform-owner Super Admin Schema Enhancements:
--              1. super_admin_workspace_notes (private notes per workspace)
--              2. fn_get_platform_overview_metrics RPC
--              3. fn_get_platform_users RPC
--              4. fn_get_platform_system_health RPC
--              5. RLS policies guarding all platform tables strictly to super admins
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Private Super Admin Workspace Notes
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.super_admin_workspace_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_email TEXT,
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for speedy retrieval per workspace
CREATE INDEX IF NOT EXISTS idx_super_admin_notes_workspace_id 
ON public.super_admin_workspace_notes(workspace_id);

ALTER TABLE public.super_admin_workspace_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Super admins can view workspace notes" ON public.super_admin_workspace_notes;
CREATE POLICY "Super admins can view workspace notes"
ON public.super_admin_workspace_notes
FOR SELECT
TO authenticated
USING (public.is_current_user_super_admin());

DROP POLICY IF EXISTS "Super admins can insert workspace notes" ON public.super_admin_workspace_notes;
CREATE POLICY "Super admins can insert workspace notes"
ON public.super_admin_workspace_notes
FOR INSERT
TO authenticated
WITH CHECK (public.is_current_user_super_admin());

DROP POLICY IF EXISTS "Super admins can update workspace notes" ON public.super_admin_workspace_notes;
CREATE POLICY "Super admins can update workspace notes"
ON public.super_admin_workspace_notes
FOR UPDATE
TO authenticated
USING (public.is_current_user_super_admin())
WITH CHECK (public.is_current_user_super_admin());

DROP POLICY IF EXISTS "Super admins can delete workspace notes" ON public.super_admin_workspace_notes;
CREATE POLICY "Super admins can delete workspace notes"
ON public.super_admin_workspace_notes
FOR DELETE
TO authenticated
USING (public.is_current_user_super_admin());

-- ----------------------------------------------------------------------------
-- 2. Platform Overview Metrics RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_get_platform_overview_metrics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_super boolean;
  v_result jsonb;
  v_total_workspaces bigint;
  v_active_workspaces bigint;
  v_suspended_workspaces bigint;
  v_total_agents bigint;
  v_active_agents bigint;
  v_tickets_today bigint;
  v_tickets_this_month bigint;
  v_total_messages bigint;
  v_bot_resolved bigint;
  v_bot_handover bigint;
  v_bot_resolution_rate numeric;
  v_trend_data jsonb;
  v_newest_workspaces jsonb;
  v_alerts jsonb;
BEGIN
  v_is_super := public.is_current_user_super_admin();
  IF NOT v_is_super AND current_user <> 'postgres' AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied: Only platform super administrators can access overview metrics.';
  END IF;

  -- Workspaces counts
  SELECT count(*) INTO v_total_workspaces FROM public.workspaces WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_active_workspaces FROM public.workspaces WHERE deleted_at IS NULL AND coalesce(is_suspended, false) = false;
  SELECT count(*) INTO v_suspended_workspaces FROM public.workspaces WHERE deleted_at IS NULL AND coalesce(is_suspended, false) = true;

  -- Agents counts
  SELECT count(*) INTO v_total_agents FROM public.agents;
  SELECT count(*) INTO v_active_agents FROM public.agents WHERE coalesce(is_active, true) = true AND status IN ('online', 'away');

  -- Tickets counts
  SELECT count(*) INTO v_tickets_today FROM public.tickets WHERE created_at >= date_trunc('day', now());
  SELECT count(*) INTO v_tickets_this_month FROM public.tickets WHERE created_at >= date_trunc('month', now());

  -- Messages count
  SELECT count(*) INTO v_total_messages FROM public.messages;

  -- Bot metrics
  SELECT count(*) INTO v_bot_resolved FROM public.conversations WHERE ai_mode = 'autopilot' AND status IN ('closed', 'solved');
  SELECT count(*) INTO v_bot_handover FROM public.conversations WHERE ai_mode = 'autopilot' AND assigned_agent_id IS NOT NULL;
  
  IF (v_bot_resolved + v_bot_handover) > 0 THEN
    v_bot_resolution_rate := round((v_bot_resolved::numeric / (v_bot_resolved + v_bot_handover)::numeric) * 100, 1);
  ELSE
    v_bot_resolution_rate := NULL;
  END IF;

  -- 30-Day Trend
  WITH daily_series AS (
    SELECT generate_series(
      date_trunc('day', now() - interval '29 days'),
      date_trunc('day', now()),
      interval '1 day'
    )::date AS day
  ),
  daily_tickets AS (
    SELECT
      created_at::date AS day,
      count(*) AS created_count,
      count(*) FILTER (WHERE status IN ('solved', 'closed')) AS solved_count
    FROM public.tickets
    WHERE created_at >= now() - interval '30 days'
    GROUP BY created_at::date
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'date', ds.day,
      'formatted_date', to_char(ds.day, 'Mon DD'),
      'created', coalesce(dt.created_count, 0),
      'solved', coalesce(dt.solved_count, 0)
    ) ORDER BY ds.day
  ) INTO v_trend_data
  FROM daily_series ds
  LEFT JOIN daily_tickets dt ON dt.day = ds.day;

  -- Newest 5 Workspaces
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', w.id,
      'name', w.name,
      'brand_color', coalesce(w.brand_color, '#2563eb'),
      'created_at', w.created_at,
      'is_suspended', coalesce(w.is_suspended, false),
      'plan', coalesce(w.plan, 'free'),
      'owner_email', u.email
    ) ORDER BY w.created_at DESC
  ) INTO v_newest_workspaces
  FROM (
    SELECT * FROM public.workspaces
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 5
  ) w
  LEFT JOIN auth.users u ON u.id = w.owner_id;

  -- Alerts list (suspended workspaces + failing channels)
  WITH suspended_alerts AS (
    SELECT
      'workspace_suspended' AS alert_type,
      'high' AS severity,
      'Workspace ' || w.name || ' is suspended' AS message,
      w.id AS workspace_id,
      w.name AS workspace_name,
      w.suspended_at AS created_at
    FROM public.workspaces w
    WHERE coalesce(w.is_suspended, false) = true
      AND w.deleted_at IS NULL
  ),
  channel_alerts AS (
    SELECT
      'channel_error' AS alert_type,
      'medium' AS severity,
      'Outbound failure on channel: ' || q.channel AS message,
      q.workspace_id,
      coalesce(w.name, 'Unknown Workspace') AS workspace_name,
      q.created_at
    FROM public.channel_outbound_queue q
    LEFT JOIN public.workspaces w ON w.id = q.workspace_id
    WHERE q.status = 'failed' OR coalesce(q.attempts, 0) >= 3
    ORDER BY q.created_at DESC
    LIMIT 10
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'alert_type', a.alert_type,
      'severity', a.severity,
      'message', a.message,
      'workspace_id', a.workspace_id,
      'workspace_name', a.workspace_name,
      'created_at', a.created_at
    )
  ) INTO v_alerts
  FROM (
    SELECT * FROM suspended_alerts
    UNION ALL
    SELECT * FROM channel_alerts
  ) a;

  v_result := jsonb_build_object(
    'total_workspaces', v_total_workspaces,
    'active_workspaces', v_active_workspaces,
    'suspended_workspaces', v_suspended_workspaces,
    'total_agents', v_total_agents,
    'active_agents', v_active_agents,
    'tickets_today', v_tickets_today,
    'tickets_this_month', v_tickets_this_month,
    'total_messages', v_total_messages,
    'bot_resolved_count', v_bot_resolved,
    'bot_handover_count', v_bot_handover,
    'bot_resolution_rate', v_bot_resolution_rate,
    'trend_tickets', coalesce(v_trend_data, '[]'::jsonb),
    'newest_workspaces', coalesce(v_newest_workspaces, '[]'::jsonb),
    'alerts', coalesce(v_alerts, '[]'::jsonb)
  );

  RETURN v_result;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Platform Users RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_get_platform_users()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_super boolean;
  v_users jsonb;
BEGIN
  v_is_super := public.is_current_user_super_admin();
  IF NOT v_is_super AND current_user <> 'postgres' AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied: Only platform super administrators can view platform users.';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'name', a.name,
      'email', coalesce(a.email, u.email),
      'role', a.role,
      'status', a.status,
      'is_active', coalesce(a.is_active, true),
      'is_super_admin', coalesce(a.is_super_admin, false),
      'workspace_id', a.workspace_id,
      'workspace_name', w.name,
      'created_at', a.created_at
    ) ORDER BY a.created_at DESC
  ) INTO v_users
  FROM public.agents a
  LEFT JOIN auth.users u ON u.id = a.id
  LEFT JOIN public.workspaces w ON w.id = a.workspace_id;

  RETURN coalesce(v_users, '[]'::jsonb);
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Platform System Health RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_get_platform_system_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_super boolean;
  v_channel_failures jsonb;
  v_webhook_issues jsonb;
  v_email_issues jsonb;
  v_background_errors jsonb;
BEGIN
  v_is_super := public.is_current_user_super_admin();
  IF NOT v_is_super AND current_user <> 'postgres' AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied: Only platform super administrators can inspect system health.';
  END IF;

  -- 1. Channel outbound failures
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', q.id,
      'workspace_id', q.workspace_id,
      'workspace_name', coalesce(w.name, 'Unknown'),
      'channel', q.channel,
      'error', q.error,
      'attempts', q.attempts,
      'created_at', q.created_at
    ) ORDER BY q.created_at DESC
  ) INTO v_channel_failures
  FROM public.channel_outbound_queue q
  LEFT JOIN public.workspaces w ON w.id = q.workspace_id
  WHERE q.status = 'failed' OR coalesce(q.attempts, 0) >= 3
  LIMIT 50;

  -- 2. Email Channel issues
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', e.id,
      'workspace_id', e.workspace_id,
      'workspace_name', coalesce(w.name, 'Unknown'),
      'error_type', 'verification_pending',
      'created_at', e.created_at
    ) ORDER BY e.created_at DESC
  ) INTO v_email_issues
  FROM public.email_verifications e
  LEFT JOIN public.workspaces w ON w.id = e.workspace_id
  WHERE e.verified_at IS NULL AND e.created_at < (now() - interval '24 hours')
  LIMIT 50;

  -- 3. Automation outbox failures
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', ao.id,
      'workspace_id', ao.workspace_id,
      'workspace_name', coalesce(w.name, 'Unknown'),
      'action_type', ao.action_type,
      'status', ao.status,
      'error', ao.error,
      'created_at', ao.created_at
    ) ORDER BY ao.created_at DESC
  ) INTO v_background_errors
  FROM public.automation_outbox ao
  LEFT JOIN public.workspaces w ON w.id = ao.workspace_id
  WHERE ao.status = 'failed'
  LIMIT 50;

  RETURN jsonb_build_object(
    'channel_failures', coalesce(v_channel_failures, '[]'::jsonb),
    'email_issues', coalesce(v_email_issues, '[]'::jsonb),
    'background_errors', coalesce(v_background_errors, '[]'::jsonb),
    'checked_at', now()
  );
END;
$$;

-- Explicitly revoke execute from public and anon, grant to authenticated
REVOKE ALL ON FUNCTION public.fn_get_platform_overview_metrics() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_platform_overview_metrics() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_get_platform_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_platform_users() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_get_platform_system_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_platform_system_health() TO authenticated, service_role;
