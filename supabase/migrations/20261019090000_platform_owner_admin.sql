-- ============================================================================
-- Migration: 20261019090000_platform_owner_admin.sql
-- Description: Platform-owner super admin RPCs and security for Workspaces List,
--              Platform Overview, and Workspace Drilldown Analytics.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Helper function: is_current_user_super_admin()
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_current_user_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT is_super_admin FROM public.agents WHERE id = auth.uid()),
    false
  );
$$;

-- ----------------------------------------------------------------------------
-- 2. Audit Log Table RLS verification
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.super_admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_email TEXT NOT NULL,
  admin_name TEXT,
  action TEXT NOT NULL,
  workspace_id UUID REFERENCES public.workspaces(id) ON DELETE SET NULL,
  workspace_name TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.super_admin_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Super admins can view audit logs" ON public.super_admin_audit_logs;
CREATE POLICY "Super admins can view audit logs"
ON public.super_admin_audit_logs
FOR SELECT
TO authenticated
USING (public.is_current_user_super_admin());

DROP POLICY IF EXISTS "Super admins can insert audit logs" ON public.super_admin_audit_logs;
CREATE POLICY "Super admins can insert audit logs"
ON public.super_admin_audit_logs
FOR INSERT
TO authenticated
WITH CHECK (public.is_current_user_super_admin());

-- ----------------------------------------------------------------------------
-- 3. fn_get_platform_workspaces()
-- Workspaces list with name, site, status, agents count, tickets in the
-- last 30 days, connected channels, and last activity.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_get_platform_workspaces()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_super boolean;
  v_result jsonb;
BEGIN
  v_is_super := public.is_current_user_super_admin();
  IF NOT v_is_super AND current_user <> 'postgres' AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied. Only platform super administrators can access workspaces list.';
  END IF;

  WITH ws_agents AS (
    SELECT
      workspace_id,
      count(*) AS agents_count
    FROM public.agents
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id
  ),
  ws_tickets_30d AS (
    SELECT
      workspace_id,
      count(*) AS tickets_30d_count,
      max(greatest(created_at, coalesce(updated_at, created_at))) AS last_ticket_activity
    FROM public.tickets
    WHERE workspace_id IS NOT NULL
      AND created_at >= (now() - interval '30 days')
    GROUP BY workspace_id
  ),
  ws_all_tickets AS (
    SELECT
      workspace_id,
      max(greatest(created_at, coalesce(updated_at, created_at))) AS last_ticket_activity_all
    FROM public.tickets
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id
  ),
  ws_channels AS (
    SELECT
      workspace_id,
      array_agg(DISTINCT channel) AS channels_list
    FROM public.channel_connections
    WHERE workspace_id IS NOT NULL
      AND status <> 'disconnected'
    GROUP BY workspace_id
  ),
  ws_conversations AS (
    SELECT
      workspace_id,
      max(greatest(created_at, coalesce(updated_at, created_at))) AS last_conv_activity
    FROM public.conversations
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id
  ),
  ws_messages AS (
    SELECT
      c.workspace_id,
      max(m.created_at) AS last_msg_activity
    FROM public.messages m
    JOIN public.conversations c ON m.conversation_id = c.id
    WHERE c.workspace_id IS NOT NULL
    GROUP BY c.workspace_id
  ),
  ws_visitors AS (
    SELECT
      workspace_id,
      count(id) AS visitors_count,
      max(coalesce(last_seen_at, last_seen)) AS last_vis_activity,
      bool_or(coalesce(last_seen_at, last_seen) >= now() - interval '30 days') AS widget_active
    FROM public.visitors
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id
  ),
  ws_owners AS (
    SELECT DISTINCT ON (workspace_id)
      workspace_id,
      email AS owner_email
    FROM public.agents
    WHERE role = 'owner'
    ORDER BY workspace_id, created_at ASC
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', w.id,
      'name', w.name,
      'website_url', coalesce(w.website_url, w.custom_domain),
      'status', CASE WHEN coalesce(w.is_suspended, false) THEN 'suspended' ELSE 'active' END,
      'is_suspended', coalesce(w.is_suspended, false),
      'suspended_at', w.suspended_at,
      'suspension_reason', w.suspension_reason,
      'deleted_at', w.deleted_at,
      'plan', coalesce(w.plan, 'free'),
      'brand_color', w.brand_color,
      'logo_url', w.logo_url,
      'agents_count', coalesce(wa.agents_count, 0),
      'tickets_30d_count', coalesce(wt30.tickets_30d_count, 0),
      'connected_channels', CASE
        WHEN wc.channels_list IS NOT NULL THEN
          CASE
            WHEN coalesce(wv.widget_active, false) AND NOT ('chat' = ANY(wc.channels_list))
              THEN array_append(wc.channels_list, 'chat')
            ELSE wc.channels_list
          END
        WHEN coalesce(wv.widget_active, false) THEN ARRAY['chat']
        ELSE ARRAY[]::text[]
      END,
      'last_activity_at', greatest(
        w.created_at,
        wt.last_ticket_activity_all,
        wt30.last_ticket_activity,
        wco.last_conv_activity,
        wm.last_msg_activity,
        wv.last_vis_activity
      ),
      'created_at', w.created_at,
      'owner_email', coalesce(wo.owner_email, (SELECT email FROM auth.users WHERE id = w.owner_id))
    ) ORDER BY w.created_at DESC
  ), '[]'::jsonb) INTO v_result
  FROM public.workspaces w
  LEFT JOIN ws_agents wa ON w.id = wa.workspace_id
  LEFT JOIN ws_tickets_30d wt30 ON w.id = wt30.workspace_id
  LEFT JOIN ws_all_tickets wt ON w.id = wt.workspace_id
  LEFT JOIN ws_channels wc ON w.id = wc.workspace_id
  LEFT JOIN ws_conversations wco ON w.id = wco.workspace_id
  LEFT JOIN ws_messages wm ON w.id = wm.workspace_id
  LEFT JOIN ws_visitors wv ON w.id = wv.workspace_id
  LEFT JOIN ws_owners wo ON w.id = wo.workspace_id
  WHERE w.deleted_at IS NULL;

  RETURN v_result;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. fn_get_platform_overview(p_days integer DEFAULT 30)
-- Platform-wide metrics aggregated across all workspaces.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_get_platform_overview(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_super boolean;
  v_start_date date;
  v_end_date date := CURRENT_DATE;
  v_tickets_per_day jsonb;
  v_total_workspaces integer := 0;
  v_active_workspaces integer := 0;
  v_suspended_workspaces integer := 0;
  v_total_tickets integer := 0;
  v_tickets_30d integer := 0;
  v_total_members integer := 0;
  v_avg_frt_seconds integer;
  v_resolution_rate numeric;
  v_bot_resolved integer := 0;
  v_bot_handover integer := 0;
  v_top_articles jsonb;
BEGIN
  v_is_super := public.is_current_user_super_admin();
  IF NOT v_is_super AND current_user <> 'postgres' AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied. Only platform super administrators can access platform overview.';
  END IF;

  IF p_days IS NULL OR p_days <= 0 THEN
    p_days := 30;
  END IF;
  v_start_date := v_end_date - ((p_days - 1) || ' days')::interval;

  -- Workspaces summary counts
  SELECT
    count(*),
    count(*) FILTER (WHERE NOT coalesce(is_suspended, false)),
    count(*) FILTER (WHERE coalesce(is_suspended, false))
  INTO v_total_workspaces, v_active_workspaces, v_suspended_workspaces
  FROM public.workspaces
  WHERE deleted_at IS NULL;

  -- Total agents/members
  SELECT count(*)
  INTO v_total_members
  FROM public.agents
  WHERE workspace_id IS NOT NULL;

  -- Tickets metrics
  SELECT
    count(*),
    count(*) FILTER (WHERE created_at >= now() - interval '30 days')
  INTO v_total_tickets, v_tickets_30d
  FROM public.tickets;

  -- Resolution rate
  SELECT
    CASE WHEN count(*) > 0 THEN
      round((count(*) FILTER (WHERE status IN ('solved', 'closed'))::numeric / count(*) * 100)::numeric, 1)
    ELSE 0 END
  INTO v_resolution_rate
  FROM public.tickets;

  -- Tickets per day chart (created vs solved)
  WITH date_series AS (
    SELECT generate_series(v_start_date, v_end_date, '1 day'::interval)::date AS day
  ),
  daily_created AS (
    SELECT created_at::date AS day, count(*) AS created_cnt
    FROM public.tickets
    WHERE created_at::date >= v_start_date AND created_at::date <= v_end_date
    GROUP BY created_at::date
  ),
  daily_solved AS (
    SELECT coalesce(solved_at, closed_at, updated_at)::date AS day, count(*) AS solved_cnt
    FROM public.tickets
    WHERE status IN ('solved', 'closed')
      AND coalesce(solved_at, closed_at, updated_at)::date >= v_start_date
      AND coalesce(solved_at, closed_at, updated_at)::date <= v_end_date
    GROUP BY coalesce(solved_at, closed_at, updated_at)::date
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.day, 'YYYY-MM-DD'),
      'formatted_date', to_char(ds.day, 'Mon DD'),
      'tickets', coalesce(dc.created_cnt, 0),
      'solved', coalesce(dsol.solved_cnt, 0)
    ) ORDER BY ds.day ASC
  ), '[]'::jsonb) INTO v_tickets_per_day
  FROM date_series ds
  LEFT JOIN daily_created dc ON ds.day = dc.day
  LEFT JOIN daily_solved dsol ON ds.day = dsol.day;

  -- Average First Reply Time across platform
  WITH ticket_frt AS (
    SELECT
      t.id,
      EXTRACT(EPOCH FROM (min(m.created_at) - t.created_at)) AS frt_sec
    FROM public.tickets t
    JOIN public.messages m ON m.conversation_id = t.conversation_id
    WHERE m.sender_type IN ('agent', 'ai')
      AND m.created_at >= t.created_at
      AND t.created_at::date >= v_start_date
    GROUP BY t.id, t.created_at
  )
  SELECT round(avg(frt_sec))
  INTO v_avg_frt_seconds
  FROM ticket_frt
  WHERE frt_sec >= 0;

  -- Bot Resolved vs Handed to Human across platform
  WITH conv_ai AS (
    SELECT
      c.id,
      count(m.id) FILTER (WHERE m.sender_type = 'ai') AS ai_cnt,
      count(m.id) FILTER (WHERE m.sender_type = 'agent') AS agent_cnt,
      c.status
    FROM public.conversations c
    JOIN public.messages m ON m.conversation_id = c.id
    WHERE c.created_at::date >= v_start_date
    GROUP BY c.id, c.status
  )
  SELECT
    count(*) FILTER (WHERE ai_cnt > 0 AND agent_cnt = 0),
    count(*) FILTER (WHERE ai_cnt > 0 AND agent_cnt > 0)
  INTO v_bot_resolved, v_bot_handover
  FROM conv_ai;

  -- Top Help Articles viewed across platform
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'title', a.title,
      'slug', a.slug,
      'workspace_id', a.workspace_id,
      'workspace_name', coalesce(w.name, 'Unknown'),
      'views_count', coalesce(a.views_count, 0),
      'helpful_count', coalesce(a.helpful_count, 0)
    ) ORDER BY a.views_count DESC
  ), '[]'::jsonb) INTO v_top_articles
  FROM (
    SELECT id, title, slug, workspace_id, views_count, helpful_count
    FROM public.articles
    WHERE status = 'published'
    ORDER BY views_count DESC
    LIMIT 10
  ) a
  LEFT JOIN public.workspaces w ON a.workspace_id = w.id;

  RETURN jsonb_build_object(
    'range_days', p_days,
    'total_workspaces', v_total_workspaces,
    'active_workspaces', v_active_workspaces,
    'suspended_workspaces', v_suspended_workspaces,
    'total_tickets', v_total_tickets,
    'tickets_30d', v_tickets_30d,
    'total_members', v_total_members,
    'avg_first_reply_seconds', v_avg_frt_seconds,
    'resolution_rate_percent', coalesce(v_resolution_rate, 0),
    'bot_resolved_count', v_bot_resolved,
    'bot_handover_count', v_bot_handover,
    'tickets_per_day', v_tickets_per_day,
    'top_articles', v_top_articles
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. fn_get_workspace_owner_detail(p_workspace_id uuid, p_days integer DEFAULT 30)
-- Detailed analytics and metrics for a specific workspace.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_get_workspace_owner_detail(
  p_workspace_id uuid,
  p_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_super boolean;
  v_ws record;
  v_start_date date;
  v_end_date date := CURRENT_DATE;
  v_tickets_per_day jsonb;
  v_avg_frt_seconds integer;
  v_resolution_rate numeric;
  v_total_tickets integer := 0;
  v_tickets_30d integer := 0;
  v_bot_resolved integer := 0;
  v_bot_handover integer := 0;
  v_top_articles jsonb;
  v_members jsonb;
  v_channels text[];
BEGIN
  v_is_super := public.is_current_user_super_admin();
  IF NOT v_is_super AND current_user <> 'postgres' AND current_user <> 'service_role' THEN
    RAISE EXCEPTION 'Access denied. Only platform super administrators can access workspace details.';
  END IF;

  SELECT * INTO v_ws FROM public.workspaces WHERE id = p_workspace_id;
  IF v_ws.id IS NULL THEN
    RAISE EXCEPTION 'Workspace not found.';
  END IF;

  IF p_days IS NULL OR p_days <= 0 THEN
    p_days := 30;
  END IF;
  v_start_date := v_end_date - ((p_days - 1) || ' days')::interval;

  -- Tickets totals for this workspace
  SELECT
    count(*),
    count(*) FILTER (WHERE created_at >= now() - interval '30 days')
  INTO v_total_tickets, v_tickets_30d
  FROM public.tickets
  WHERE workspace_id = p_workspace_id;

  -- Resolution rate for this workspace
  SELECT
    CASE WHEN count(*) > 0 THEN
      round((count(*) FILTER (WHERE status IN ('solved', 'closed'))::numeric / count(*) * 100)::numeric, 1)
    ELSE 0 END
  INTO v_resolution_rate
  FROM public.tickets
  WHERE workspace_id = p_workspace_id;

  -- Tickets per day chart for this workspace
  WITH date_series AS (
    SELECT generate_series(v_start_date, v_end_date, '1 day'::interval)::date AS day
  ),
  daily_created AS (
    SELECT created_at::date AS day, count(*) AS created_cnt
    FROM public.tickets
    WHERE workspace_id = p_workspace_id
      AND created_at::date >= v_start_date AND created_at::date <= v_end_date
    GROUP BY created_at::date
  ),
  daily_solved AS (
    SELECT coalesce(solved_at, closed_at, updated_at)::date AS day, count(*) AS solved_cnt
    FROM public.tickets
    WHERE workspace_id = p_workspace_id
      AND status IN ('solved', 'closed')
      AND coalesce(solved_at, closed_at, updated_at)::date >= v_start_date
      AND coalesce(solved_at, closed_at, updated_at)::date <= v_end_date
    GROUP BY coalesce(solved_at, closed_at, updated_at)::date
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.day, 'YYYY-MM-DD'),
      'formatted_date', to_char(ds.day, 'Mon DD'),
      'tickets', coalesce(dc.created_cnt, 0),
      'solved', coalesce(dsol.solved_cnt, 0)
    ) ORDER BY ds.day ASC
  ), '[]'::jsonb) INTO v_tickets_per_day
  FROM date_series ds
  LEFT JOIN daily_created dc ON ds.day = dc.day
  LEFT JOIN daily_solved dsol ON ds.day = dsol.day;

  -- Average First Reply Time for this workspace
  WITH ticket_frt AS (
    SELECT
      t.id,
      EXTRACT(EPOCH FROM (min(m.created_at) - t.created_at)) AS frt_sec
    FROM public.tickets t
    JOIN public.messages m ON m.conversation_id = t.conversation_id
    WHERE t.workspace_id = p_workspace_id
      AND m.sender_type IN ('agent', 'ai')
      AND m.created_at >= t.created_at
      AND t.created_at::date >= v_start_date
    GROUP BY t.id, t.created_at
  )
  SELECT round(avg(frt_sec))
  INTO v_avg_frt_seconds
  FROM ticket_frt
  WHERE frt_sec >= 0;

  -- Bot Resolved vs Handed to Human for this workspace
  WITH conv_ai AS (
    SELECT
      c.id,
      count(m.id) FILTER (WHERE m.sender_type = 'ai') AS ai_cnt,
      count(m.id) FILTER (WHERE m.sender_type = 'agent') AS agent_cnt
    FROM public.conversations c
    JOIN public.messages m ON m.conversation_id = c.id
    WHERE c.workspace_id = p_workspace_id
      AND c.created_at::date >= v_start_date
    GROUP BY c.id
  )
  SELECT
    count(*) FILTER (WHERE ai_cnt > 0 AND agent_cnt = 0),
    count(*) FILTER (WHERE ai_cnt > 0 AND agent_cnt > 0)
  INTO v_bot_resolved, v_bot_handover
  FROM conv_ai;

  -- Top Help Articles viewed for this workspace
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'title', a.title,
      'slug', a.slug,
      'status', a.status,
      'views_count', coalesce(a.views_count, 0),
      'helpful_count', coalesce(a.helpful_count, 0),
      'created_at', a.created_at
    ) ORDER BY a.views_count DESC
  ), '[]'::jsonb) INTO v_top_articles
  FROM (
    SELECT id, title, slug, status, views_count, helpful_count, created_at
    FROM public.articles
    WHERE workspace_id = p_workspace_id
    ORDER BY views_count DESC
    LIMIT 10
  ) a;

  -- Workspace's members
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', ag.id,
      'name', ag.name,
      'email', ag.email,
      'role', ag.role,
      'status', ag.status,
      'avatar_url', ag.avatar_url,
      'created_at', ag.created_at,
      'is_active', coalesce(ag.is_active, true),
      'max_open_tickets', ag.max_open_tickets
    ) ORDER BY ag.created_at ASC
  ), '[]'::jsonb) INTO v_members
  FROM public.agents ag
  WHERE ag.workspace_id = p_workspace_id;

  -- Connected channels
  SELECT coalesce(array_agg(DISTINCT channel), ARRAY[]::text[])
  INTO v_channels
  FROM public.channel_connections
  WHERE workspace_id = p_workspace_id
    AND status <> 'disconnected';

  IF EXISTS (SELECT 1 FROM public.visitors WHERE workspace_id = p_workspace_id) THEN
    IF NOT ('chat' = ANY(v_channels)) THEN
      v_channels := array_append(v_channels, 'chat');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'workspace', jsonb_build_object(
      'id', v_ws.id,
      'name', v_ws.name,
      'website_url', coalesce(v_ws.website_url, v_ws.custom_domain),
      'brand_color', v_ws.brand_color,
      'status', CASE WHEN coalesce(v_ws.is_suspended, false) THEN 'suspended' ELSE 'active' END,
      'is_suspended', coalesce(v_ws.is_suspended, false),
      'suspended_at', v_ws.suspended_at,
      'suspension_reason', v_ws.suspension_reason,
      'plan', coalesce(v_ws.plan, 'free'),
      'owner_email', (SELECT email FROM public.agents WHERE workspace_id = p_workspace_id AND role = 'owner' LIMIT 1),
      'created_at', v_ws.created_at,
      'connected_channels', v_channels,
      'tickets_30d_count', v_tickets_30d,
      'total_tickets', v_total_tickets,
      'agents_count', jsonb_array_length(v_members)
    ),
    'tickets_per_day', v_tickets_per_day,
    'avg_first_reply_seconds', v_avg_frt_seconds,
    'resolution_rate_percent', coalesce(v_resolution_rate, 0),
    'bot_resolved_count', v_bot_resolved,
    'bot_handover_count', v_bot_handover,
    'top_articles', v_top_articles,
    'members', v_members
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Permissions / Grants
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_get_platform_workspaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_platform_workspaces() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_get_platform_overview(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_platform_overview(integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_get_workspace_owner_detail(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_workspace_owner_detail(uuid, integer) TO authenticated, service_role;
