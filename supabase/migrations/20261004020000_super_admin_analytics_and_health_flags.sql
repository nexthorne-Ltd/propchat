-- Migration: Super Admin Platform Analytics, Per-Company Insights & Health Flags
-- Timestamp: 20261004020000

-- ============================================================================
-- 1. Function: fn_get_platform_analytics(p_days integer DEFAULT 30)
-- Platform dashboard metrics:
-- - new companies per week
-- - active companies (had a conversation in the last 7 days)
-- - conversations and messages per day
-- - total visitors per day
-- - AI replies per day and AI cost estimate ($0.002 / reply)
-- - top 10 companies by conversations
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_get_platform_analytics(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_is_super_admin boolean;
  v_start_date date;
  v_end_date date := CURRENT_DATE;
  v_time_series jsonb;
  v_weekly_companies jsonb;
  v_active_companies_7d_count integer;
  v_total_companies_count integer;
  v_top_companies jsonb;
  v_totals jsonb;
BEGIN
  -- Super admin permission guard
  SELECT is_super_admin INTO v_is_super_admin
  FROM public.agents
  WHERE id = auth.uid();

  IF coalesce(v_is_super_admin, false) = false THEN
    -- In service role or background context auth.uid() may be null; check if caller is super admin or service role
    IF current_user <> 'postgres' AND current_user <> 'service_role' THEN
      RAISE EXCEPTION 'Access denied. Only platform super administrators can access platform analytics.';
    END IF;
  END IF;

  IF p_days IS NULL OR p_days <= 0 THEN
    p_days := 30;
  END IF;
  v_start_date := v_end_date - ((p_days - 1) || ' days')::interval;

  -- 1. Daily Time Series (Conversations, Messages, Visitors, AI replies, AI cost, New Companies)
  WITH date_series AS (
    SELECT generate_series(v_start_date, v_end_date, '1 day'::interval)::date AS day
  ),
  daily_ws AS (
    SELECT created_at::date AS day, count(*) AS new_companies
    FROM public.workspaces
    WHERE created_at::date >= v_start_date AND created_at::date <= v_end_date
      AND deleted_at IS NULL
    GROUP BY created_at::date
  ),
  daily_convs AS (
    SELECT created_at::date AS day, count(*) AS convs_count
    FROM public.conversations
    WHERE created_at::date >= v_start_date AND created_at::date <= v_end_date
      AND workspace_id IS NOT NULL
    GROUP BY created_at::date
  ),
  daily_msgs AS (
    SELECT m.created_at::date AS day,
           count(*) AS msgs_count,
           count(*) FILTER (WHERE m.sender_type = 'ai') AS ai_count
    FROM public.messages m
    JOIN public.conversations c ON m.conversation_id = c.id
    WHERE m.created_at::date >= v_start_date AND m.created_at::date <= v_end_date
      AND c.workspace_id IS NOT NULL
    GROUP BY m.created_at::date
  ),
  daily_vis AS (
    SELECT coalesce(first_seen_at, first_seen)::date AS day, count(*) AS vis_count
    FROM public.visitors
    WHERE coalesce(first_seen_at, first_seen)::date >= v_start_date
      AND coalesce(first_seen_at, first_seen)::date <= v_end_date
      AND workspace_id IS NOT NULL
    GROUP BY coalesce(first_seen_at, first_seen)::date
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.day, 'YYYY-MM-DD'),
      'formatted_date', to_char(ds.day, 'Mon DD'),
      'new_companies', coalesce(dw.new_companies, 0),
      'conversations', coalesce(dc.convs_count, 0),
      'messages', coalesce(dm.msgs_count, 0),
      'visitors', coalesce(dv.vis_count, 0),
      'ai_replies', coalesce(dm.ai_count, 0),
      'estimated_ai_cost', round((coalesce(dm.ai_count, 0) * 0.002)::numeric, 4)
    ) ORDER BY ds.day ASC
  ), '[]'::jsonb) INTO v_time_series
  FROM date_series ds
  LEFT JOIN daily_ws dw ON ds.day = dw.day
  LEFT JOIN daily_convs dc ON ds.day = dc.day
  LEFT JOIN daily_msgs dm ON ds.day = dm.day
  LEFT JOIN daily_vis dv ON ds.day = dv.day;

  -- 2. New Companies Per Week (Over past 12 weeks)
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'week_start', to_char(w.week_start, 'YYYY-MM-DD'),
      'week_label', 'Week of ' || to_char(w.week_start, 'Mon DD'),
      'new_companies', w.cnt
    ) ORDER BY w.week_start ASC
  ), '[]'::jsonb) INTO v_weekly_companies
  FROM (
    SELECT date_trunc('week', created_at)::date AS week_start, count(*) AS cnt
    FROM public.workspaces
    WHERE created_at >= CURRENT_DATE - INTERVAL '12 weeks'
      AND deleted_at IS NULL
    GROUP BY date_trunc('week', created_at)::date
  ) w;

  -- 3. Active Companies (had a conversation in the last 7 days)
  SELECT count(DISTINCT c.workspace_id) INTO v_active_companies_7d_count
  FROM public.conversations c
  JOIN public.workspaces w ON c.workspace_id = w.id
  WHERE (c.created_at >= (now() - interval '7 days') OR c.updated_at >= (now() - interval '7 days'))
    AND w.deleted_at IS NULL;

  SELECT count(*) INTO v_total_companies_count
  FROM public.workspaces
  WHERE deleted_at IS NULL;

  -- 4. Top 10 Companies by Conversations in selected period
  WITH period_totals AS (
    SELECT count(DISTINCT c.id) AS total_period_convs
    FROM public.conversations c
    JOIN public.workspaces w ON c.workspace_id = w.id
    WHERE c.created_at::date >= v_start_date AND c.created_at::date <= v_end_date
      AND w.deleted_at IS NULL
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', w.id,
      'name', w.name,
      'website_url', w.website_url,
      'brand_color', w.brand_color,
      'plan', coalesce(w.plan, 'free'),
      'conversations_count', sub.convs,
      'messages_count', sub.msgs,
      'visitors_count', sub.visitors,
      'share_percent', CASE
        WHEN pt.total_period_convs > 0 THEN round((sub.convs::numeric / pt.total_period_convs * 100)::numeric, 1)
        ELSE 0
      END
    ) ORDER BY sub.convs DESC
  ), '[]'::jsonb) INTO v_top_companies
  FROM (
    SELECT c.workspace_id,
           count(DISTINCT c.id) AS convs,
           count(m.id) AS msgs,
           count(DISTINCT c.visitor_id) AS visitors
    FROM public.conversations c
    LEFT JOIN public.messages m ON m.conversation_id = c.id
    WHERE c.created_at::date >= v_start_date AND c.created_at::date <= v_end_date
      AND c.workspace_id IS NOT NULL
    GROUP BY c.workspace_id
    ORDER BY count(DISTINCT c.id) DESC
    LIMIT 10
  ) sub
  CROSS JOIN period_totals pt
  JOIN public.workspaces w ON sub.workspace_id = w.id;

  -- 5. Totals in date range
  SELECT jsonb_build_object(
    'total_conversations', (
      SELECT count(*) FROM public.conversations c
      JOIN public.workspaces w ON c.workspace_id = w.id
      WHERE c.created_at::date >= v_start_date AND c.created_at::date <= v_end_date
        AND w.deleted_at IS NULL
    ),
    'total_messages', (
      SELECT count(*) FROM public.messages m
      JOIN public.conversations c ON m.conversation_id = c.id
      JOIN public.workspaces w ON c.workspace_id = w.id
      WHERE m.created_at::date >= v_start_date AND m.created_at::date <= v_end_date
        AND w.deleted_at IS NULL
    ),
    'total_visitors', (
      SELECT count(*) FROM public.visitors v
      JOIN public.workspaces w ON v.workspace_id = w.id
      WHERE coalesce(v.first_seen_at, v.first_seen)::date >= v_start_date
        AND coalesce(v.first_seen_at, v.first_seen)::date <= v_end_date
        AND w.deleted_at IS NULL
    ),
    'total_ai_replies', (
      SELECT count(*) FROM public.messages m
      JOIN public.conversations c ON m.conversation_id = c.id
      JOIN public.workspaces w ON c.workspace_id = w.id
      WHERE m.sender_type = 'ai'
        AND m.created_at::date >= v_start_date AND m.created_at::date <= v_end_date
        AND w.deleted_at IS NULL
    ),
    'total_new_companies', (
      SELECT count(*) FROM public.workspaces w
      WHERE w.created_at::date >= v_start_date AND w.created_at::date <= v_end_date
        AND w.deleted_at IS NULL
    )
  ) INTO v_totals;

  RETURN jsonb_build_object(
    'range_days', p_days,
    'start_date', to_char(v_start_date, 'YYYY-MM-DD'),
    'end_date', to_char(v_end_date, 'YYYY-MM-DD'),
    'time_series', v_time_series,
    'weekly_companies', v_weekly_companies,
    'active_companies_7d_count', coalesce(v_active_companies_7d_count, 0),
    'total_companies_count', coalesce(v_total_companies_count, 0),
    'active_companies_7d_percent', CASE
      WHEN coalesce(v_total_companies_count, 0) > 0 THEN round((coalesce(v_active_companies_7d_count, 0)::numeric / v_total_companies_count * 100)::numeric, 1)
      ELSE 0
    END,
    'top_10_companies', v_top_companies,
    'totals', v_totals,
    'total_estimated_ai_cost', round(((v_totals->>'total_ai_replies')::numeric * 0.002)::numeric, 2)
  );
END;
$$;


-- ============================================================================
-- 2. Function: fn_get_company_analytics(p_workspace_id uuid, p_days integer DEFAULT 30)
-- Per-company Insights:
-- - conversations per day chart
-- - average first response time
-- - average resolution time
-- - CSAT
-- - share of chats answered by AI only
-- - handover rate
-- - open vs resolved
-- - unanswered chats older than 24h
-- - number of knowledge gaps
-- - health flags
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_get_company_analytics(
  p_workspace_id uuid,
  p_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ws record;
  v_start_date date;
  v_end_date date := CURRENT_DATE;
  v_convs_per_day jsonb;
  v_metrics record;
  v_unanswered_24h_count integer;
  v_unanswered_24h_sample jsonb;
  v_knowledge_gaps_count integer;
  v_knowledge_gaps_sample jsonb;
  v_health_flags text[];
  v_agent_online_7d boolean;
  v_widget_installed boolean;
  v_published_articles_count integer;
BEGIN
  SELECT * INTO v_ws FROM public.workspaces WHERE id = p_workspace_id;
  IF v_ws.id IS NULL THEN
    RAISE EXCEPTION 'Workspace not found.';
  END IF;

  IF p_days IS NULL OR p_days <= 0 THEN
    p_days := 30;
  END IF;
  v_start_date := v_end_date - ((p_days - 1) || ' days')::interval;

  -- 1. Conversations & Messages per day for this company
  WITH date_series AS (
    SELECT generate_series(v_start_date, v_end_date, '1 day'::interval)::date AS day
  ),
  daily_convs AS (
    SELECT created_at::date AS day, count(*) AS convs_count
    FROM public.conversations
    WHERE workspace_id = p_workspace_id
      AND created_at::date >= v_start_date AND created_at::date <= v_end_date
    GROUP BY created_at::date
  ),
  daily_msgs AS (
    SELECT m.created_at::date AS day,
           count(*) AS msgs_count,
           count(*) FILTER (WHERE m.sender_type = 'ai') AS ai_count,
           count(*) FILTER (WHERE m.sender_type = 'agent') AS agent_count
    FROM public.messages m
    JOIN public.conversations c ON m.conversation_id = c.id
    WHERE c.workspace_id = p_workspace_id
      AND m.created_at::date >= v_start_date AND m.created_at::date <= v_end_date
    GROUP BY m.created_at::date
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.day, 'YYYY-MM-DD'),
      'formatted_date', to_char(ds.day, 'Mon DD'),
      'conversations', coalesce(dc.convs_count, 0),
      'messages', coalesce(dm.msgs_count, 0),
      'ai_replies', coalesce(dm.ai_count, 0),
      'agent_replies', coalesce(dm.agent_count, 0)
    ) ORDER BY ds.day ASC
  ), '[]'::jsonb) INTO v_convs_per_day
  FROM date_series ds
  LEFT JOIN daily_convs dc ON ds.day = dc.day
  LEFT JOIN daily_msgs dm ON ds.day = dm.day;

  -- 2. Core Performance Metrics: FRT, Resolution Time, CSAT, AI Only, Handover, Open/Resolved
  WITH conv_summary AS (
    SELECT
      c.id,
      c.status,
      c.created_at,
      c.closed_at,
      c.updated_at,
      c.csat_rating,
      min(m.created_at) FILTER (WHERE m.sender_type = 'visitor') AS first_vis_msg,
      min(m.created_at) FILTER (WHERE m.sender_type IN ('agent', 'ai')) AS first_reply_msg,
      count(m.id) FILTER (WHERE m.sender_type = 'ai') AS ai_count,
      count(m.id) FILTER (WHERE m.sender_type = 'agent') AS agent_count
    FROM public.conversations c
    LEFT JOIN public.messages m ON m.conversation_id = c.id
    WHERE c.workspace_id = p_workspace_id
      AND c.created_at::date >= v_start_date AND c.created_at::date <= v_end_date
    GROUP BY c.id, c.status, c.created_at, c.closed_at, c.updated_at, c.csat_rating
  )
  SELECT
    count(*) AS total_convs,
    count(*) FILTER (WHERE status = 'closed') AS closed_convs,
    count(*) FILTER (WHERE status IN ('open', 'pending', 'snoozed')) AS open_convs,
    round(avg(EXTRACT(EPOCH FROM (first_reply_msg - first_vis_msg))) FILTER (WHERE first_reply_msg >= first_vis_msg)) AS avg_frt_seconds,
    round(avg(EXTRACT(EPOCH FROM (coalesce(closed_at, updated_at) - created_at))) FILTER (WHERE status = 'closed')) AS avg_resolution_seconds,
    round(avg(csat_rating)::numeric, 2) AS avg_csat,
    count(csat_rating) AS csat_count,
    count(csat_rating) FILTER (WHERE csat_rating >= 4) AS csat_positive_count,
    count(*) FILTER (WHERE ai_count > 0 AND agent_count = 0) AS ai_only_count,
    count(*) FILTER (WHERE ai_count > 0 AND agent_count > 0) AS ai_handover_count,
    count(*) FILTER (WHERE ai_count > 0) AS total_ai_participated
  INTO v_metrics
  FROM conv_summary;

  -- 3. Unanswered chats older than 24h
  SELECT count(*) INTO v_unanswered_24h_count
  FROM public.conversations c
  WHERE c.workspace_id = p_workspace_id
    AND c.status IN ('open', 'pending')
    AND c.created_at <= now() - interval '24 hours'
    AND (
      NOT EXISTS (
        SELECT 1 FROM public.messages m
        WHERE m.conversation_id = c.id
          AND m.sender_type IN ('agent', 'ai')
      )
      OR (
        (SELECT sender_type FROM public.messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) = 'visitor'
        AND (SELECT created_at FROM public.messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) <= now() - interval '24 hours'
      )
    );

  -- Sample list of unanswered chats > 24h
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', c.id,
      'created_at', c.created_at,
      'waiting_hours', round(EXTRACT(EPOCH FROM (now() - c.created_at)) / 3600),
      'visitor_name', coalesce(v.name, 'Anonymous Visitor'),
      'channel', c.channel
    ) ORDER BY c.created_at ASC
  ), '[]'::jsonb) INTO v_unanswered_24h_sample
  FROM (
    SELECT c.id, c.created_at, c.visitor_id, c.channel
    FROM public.conversations c
    WHERE c.workspace_id = p_workspace_id
      AND c.status IN ('open', 'pending')
      AND c.created_at <= now() - interval '24 hours'
      AND (
        NOT EXISTS (
          SELECT 1 FROM public.messages m
          WHERE m.conversation_id = c.id
            AND m.sender_type IN ('agent', 'ai')
        )
        OR (
          (SELECT sender_type FROM public.messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) = 'visitor'
          AND (SELECT created_at FROM public.messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) <= now() - interval '24 hours'
        )
      )
    LIMIT 5
  ) c
  LEFT JOIN public.visitors v ON c.visitor_id = v.id;

  -- 4. Number of Knowledge Gaps (Unanswered Questions)
  SELECT count(*) INTO v_knowledge_gaps_count
  FROM public.unanswered_questions uq
  WHERE uq.workspace_id = p_workspace_id
    AND coalesce(uq.status, 'pending') = 'pending';

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', uq.id,
      'question', uq.question,
      'times_asked', uq.times_asked,
      'last_asked_at', uq.last_asked_at
    ) ORDER BY uq.times_asked DESC
  ), '[]'::jsonb) INTO v_knowledge_gaps_sample
  FROM (
    SELECT id, question, times_asked, last_asked_at
    FROM public.unanswered_questions
    WHERE workspace_id = p_workspace_id
      AND coalesce(status, 'pending') = 'pending'
    ORDER BY times_asked DESC
    LIMIT 5
  ) uq;

  -- 5. Calculate Health Flags for this company:
  -- - "widget not installed"
  -- - "no agent online for 7 days"
  -- - "X chats waiting over 24h"
  -- - "no help articles"
  SELECT EXISTS (
    SELECT 1 FROM public.visitors v
    WHERE v.workspace_id = p_workspace_id
      AND coalesce(v.last_seen_at, v.last_seen) >= now() - interval '30 days'
  ) INTO v_widget_installed;

  SELECT (
    EXISTS (
      SELECT 1 FROM public.agents a
      WHERE a.workspace_id = p_workspace_id AND a.status = 'online'
    ) OR EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.conversations c ON m.conversation_id = c.id
      WHERE c.workspace_id = p_workspace_id AND m.sender_type = 'agent' AND m.created_at >= now() - interval '7 days'
    )
  ) INTO v_agent_online_7d;

  SELECT count(*) INTO v_published_articles_count
  FROM public.articles ar
  WHERE ar.workspace_id = p_workspace_id AND ar.status = 'published';

  v_health_flags := ARRAY[]::text[];
  IF NOT v_widget_installed THEN
    v_health_flags := array_append(v_health_flags, 'widget not installed');
  END IF;
  IF NOT v_agent_online_7d THEN
    v_health_flags := array_append(v_health_flags, 'no agent online for 7 days');
  END IF;
  IF coalesce(v_unanswered_24h_count, 0) > 0 THEN
    v_health_flags := array_append(v_health_flags, v_unanswered_24h_count || ' chats waiting over 24h');
  END IF;
  IF coalesce(v_published_articles_count, 0) = 0 THEN
    v_health_flags := array_append(v_health_flags, 'no help articles');
  END IF;

  RETURN jsonb_build_object(
    'workspace_id', p_workspace_id,
    'workspace_name', v_ws.name,
    'range_days', p_days,
    'conversations_per_day', v_convs_per_day,
    'total_conversations', coalesce(v_metrics.total_convs, 0),
    'open_conversations_count', coalesce(v_metrics.open_convs, 0),
    'resolved_conversations_count', coalesce(v_metrics.closed_convs, 0),
    'resolution_rate_percent', CASE
      WHEN coalesce(v_metrics.total_convs, 0) > 0 THEN round((coalesce(v_metrics.closed_convs, 0)::numeric / v_metrics.total_convs * 100)::numeric, 1)
      ELSE 0
    END,
    'avg_first_response_time_seconds', v_metrics.avg_frt_seconds,
    'avg_resolution_time_seconds', v_metrics.avg_resolution_seconds,
    'csat_score', v_metrics.avg_csat,
    'csat_ratings_count', coalesce(v_metrics.csat_count, 0),
    'csat_positive_percent', CASE
      WHEN coalesce(v_metrics.csat_count, 0) > 0 THEN round((coalesce(v_metrics.csat_positive_count, 0)::numeric / v_metrics.csat_count * 100)::numeric, 1)
      ELSE NULL
    END,
    'ai_only_chats_count', coalesce(v_metrics.ai_only_count, 0),
    'ai_only_chats_percent', CASE
      WHEN coalesce(v_metrics.total_convs, 0) > 0 THEN round((coalesce(v_metrics.ai_only_count, 0)::numeric / v_metrics.total_convs * 100)::numeric, 1)
      ELSE 0
    END,
    'ai_handover_chats_count', coalesce(v_metrics.ai_handover_count, 0),
    'ai_handover_percent', CASE
      WHEN coalesce(v_metrics.total_ai_participated, 0) > 0 THEN round((coalesce(v_metrics.ai_handover_count, 0)::numeric / v_metrics.total_ai_participated * 100)::numeric, 1)
      ELSE 0
    END,
    'unanswered_older_24h_count', coalesce(v_unanswered_24h_count, 0),
    'unanswered_older_24h_list', v_unanswered_24h_sample,
    'knowledge_gaps_count', coalesce(v_knowledge_gaps_count, 0),
    'knowledge_gaps_sample', v_knowledge_gaps_sample,
    'health_flags', to_jsonb(v_health_flags),
    'widget_installed', v_widget_installed,
    'agent_online_7d', v_agent_online_7d,
    'published_articles_count', v_published_articles_count
  );
END;
$$;


-- ============================================================================
-- 3. Enhance fn_get_platform_companies_summary
-- Embed health_flags, avg response time, CSAT, AI share, unanswered 24h count
-- for each company in the main summary cards and table
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_get_platform_companies_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_is_super_admin boolean;
  v_companies jsonb;
  v_total_companies integer := 0;
  v_total_convs integer := 0;
  v_total_messages integer := 0;
  v_total_visitors integer := 0;
  v_total_agents integer := 0;
  v_active_companies_7d integer := 0;
BEGIN
  -- Permission check
  SELECT is_super_admin INTO v_is_super_admin
  FROM public.agents
  WHERE id = auth.uid();

  IF coalesce(v_is_super_admin, false) = false THEN
    IF current_user <> 'postgres' AND current_user <> 'service_role' THEN
      RAISE EXCEPTION 'Access denied. Only platform super administrators can access platform summaries.';
    END IF;
  END IF;

  WITH ws_active_traffic AS (
    SELECT
      workspace_id,
      count(*) AS active_visitors_count
    FROM public.visitors
    WHERE is_online = true
      AND coalesce(last_seen_at, last_seen) >= (now() - interval '5 minutes')
      AND workspace_id IS NOT NULL
    GROUP BY workspace_id
  ),
  ws_conv_stats AS (
    SELECT
      c.workspace_id,
      count(c.id) AS conversations_count,
      count(c.id) FILTER (WHERE c.status = 'open') AS open_conversations_count,
      round(avg(c.csat_rating)::numeric, 2) AS avg_csat,
      count(c.csat_rating) AS csat_count,
      max(greatest(c.created_at, coalesce(c.updated_at, c.created_at))) AS last_conv_activity
    FROM public.conversations c
    WHERE c.workspace_id IS NOT NULL
    GROUP BY c.workspace_id
  ),
  ws_msg_stats AS (
    SELECT
      c.workspace_id,
      count(m.id) AS messages_count,
      count(m.id) FILTER (WHERE m.sender_type = 'ai') AS ai_messages_count,
      max(m.created_at) AS last_msg_activity
    FROM public.messages m
    JOIN public.conversations c ON m.conversation_id = c.id
    WHERE c.workspace_id IS NOT NULL
    GROUP BY c.workspace_id
  ),
  ws_vis_stats AS (
    SELECT
      workspace_id,
      count(id) AS visitors_count,
      max(coalesce(last_seen_at, last_seen)) AS last_vis_activity,
      bool_or(coalesce(last_seen_at, last_seen) >= now() - interval '30 days') AS widget_installed
    FROM public.visitors
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id
  ),
  ws_agent_stats AS (
    SELECT
      workspace_id,
      count(id) AS agents_count,
      bool_or(status = 'online') AS has_agent_online
    FROM public.agents
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id
  ),
  ws_article_stats AS (
    SELECT
      workspace_id,
      count(id) AS total_articles_count,
      count(id) FILTER (WHERE status = 'published') AS published_articles_count
    FROM public.articles
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id
  ),
  ws_unanswered_24h AS (
    SELECT
      c.workspace_id,
      count(*) AS unanswered_older_24h_count
    FROM public.conversations c
    WHERE c.workspace_id IS NOT NULL
      AND c.status IN ('open', 'pending')
      AND c.created_at <= now() - interval '24 hours'
      AND (
        NOT EXISTS (
          SELECT 1 FROM public.messages m
          WHERE m.conversation_id = c.id
            AND m.sender_type IN ('agent', 'ai')
        )
        OR (
          (SELECT sender_type FROM public.messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) = 'visitor'
          AND (SELECT created_at FROM public.messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) <= now() - interval '24 hours'
        )
      )
    GROUP BY c.workspace_id
  ),
  ws_knowledge_gaps AS (
    SELECT
      workspace_id,
      count(*) AS gaps_count
    FROM public.unanswered_questions
    WHERE workspace_id IS NOT NULL
      AND coalesce(status, 'pending') = 'pending'
    GROUP BY workspace_id
  ),
  ws_owner AS (
    SELECT DISTINCT ON (workspace_id)
      workspace_id,
      email AS owner_email
    FROM public.agents
    WHERE role = 'owner'
    ORDER BY workspace_id, created_at ASC
  )
  SELECT
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', w.id,
        'name', w.name,
        'website_url', w.website_url,
        'brand_color', w.brand_color,
        'greeting_title', w.greeting_title,
        'greeting_message', w.greeting_message,
        'owner_id', w.owner_id,
        'owner_email', coalesce(wo.owner_email, (SELECT email FROM auth.users WHERE id = w.owner_id)),
        'logo_url', w.logo_url,
        'is_suspended', coalesce(w.is_suspended, false),
        'suspended_at', w.suspended_at,
        'suspension_reason', w.suspension_reason,
        'deleted_at', w.deleted_at,
        'plan', coalesce(w.plan, 'free'),
        'plan_limits', w.plan_limits,
        'merged_into_workspace_id', w.merged_into_workspace_id,
        'created_at', w.created_at,
        'conversations_count', coalesce(cs.conversations_count, 0),
        'open_conversations_count', coalesce(cs.open_conversations_count, 0),
        'messages_count', coalesce(ms.messages_count, 0),
        'visitors_count', coalesce(vs.visitors_count, 0),
        'active_visitors_count', coalesce(wat.active_visitors_count, 0),
        'agents_count', coalesce(ast.agents_count, 0),
        'articles_count', coalesce(art.total_articles_count, 0),
        'published_articles_count', coalesce(art.published_articles_count, 0),
        'widget_installed', coalesce(vs.widget_installed, false),
        'ai_enabled', coalesce((w.ai_settings->>'enabled')::boolean, true),
        'ai_messages_count', coalesce(ms.ai_messages_count, 0),
        'csat_score', cs.avg_csat,
        'csat_count', coalesce(cs.csat_count, 0),
        'unanswered_older_24h_count', coalesce(u24.unanswered_older_24h_count, 0),
        'knowledge_gaps_count', coalesce(kg.gaps_count, 0),
        'last_activity_at', greatest(
          w.created_at,
          cs.last_conv_activity,
          ms.last_msg_activity,
          vs.last_vis_activity
        ),
        -- Computed health flags array for cards, table, and filters
        'health_flags', (
          SELECT coalesce(jsonb_agg(flag), '[]'::jsonb)
          FROM (
            SELECT 'widget not installed' AS flag WHERE NOT coalesce(vs.widget_installed, false)
            UNION ALL
            SELECT 'no agent online for 7 days' AS flag
            WHERE NOT (
              coalesce(ast.has_agent_online, false) OR
              EXISTS (
                SELECT 1 FROM public.messages m2
                JOIN public.conversations c2 ON m2.conversation_id = c2.id
                WHERE c2.workspace_id = w.id AND m2.sender_type = 'agent' AND m2.created_at >= now() - interval '7 days'
              )
            )
            UNION ALL
            SELECT (coalesce(u24.unanswered_older_24h_count, 0) || ' chats waiting over 24h') AS flag
            WHERE coalesce(u24.unanswered_older_24h_count, 0) > 0
            UNION ALL
            SELECT 'no help articles' AS flag WHERE coalesce(art.published_articles_count, 0) = 0
          ) flags_sub
        )
      ) ORDER BY w.created_at DESC
    ), '[]'::jsonb)
  INTO v_companies
  FROM public.workspaces w
  LEFT JOIN ws_active_traffic wat ON w.id = wat.workspace_id
  LEFT JOIN ws_conv_stats cs ON w.id = cs.workspace_id
  LEFT JOIN ws_msg_stats ms ON w.id = ms.workspace_id
  LEFT JOIN ws_vis_stats vs ON w.id = vs.workspace_id
  LEFT JOIN ws_agent_stats ast ON w.id = ast.workspace_id
  LEFT JOIN ws_article_stats art ON w.id = art.workspace_id
  LEFT JOIN ws_unanswered_24h u24 ON w.id = u24.workspace_id
  LEFT JOIN ws_knowledge_gaps kg ON w.id = kg.workspace_id
  LEFT JOIN ws_owner wo ON w.id = wo.workspace_id
  WHERE w.deleted_at IS NULL;

  -- Platform Accounting Totals: EXACT sum of the per-company metrics above
  SELECT
    count(*),
    coalesce(sum((comp->>'conversations_count')::integer), 0),
    coalesce(sum((comp->>'messages_count')::integer), 0),
    coalesce(sum((comp->>'visitors_count')::integer), 0),
    coalesce(sum((comp->>'agents_count')::integer), 0)
  INTO
    v_total_companies,
    v_total_convs,
    v_total_messages,
    v_total_visitors,
    v_total_agents
  FROM jsonb_array_elements(v_companies) comp;

  -- Active companies in last 7 days
  SELECT count(DISTINCT c.workspace_id) INTO v_active_companies_7d
  FROM public.conversations c
  JOIN public.workspaces w ON c.workspace_id = w.id
  WHERE (c.created_at >= now() - interval '7 days' OR c.updated_at >= now() - interval '7 days')
    AND w.deleted_at IS NULL;

  RETURN jsonb_build_object(
    'companies', v_companies,
    'total_companies', v_total_companies,
    'total_conversations', v_total_convs,
    'total_messages', v_total_messages,
    'total_visitors', v_total_visitors,
    'total_agents', v_total_agents,
    'active_companies_7d', v_active_companies_7d,
    'active_companies_7d_percent', CASE
      WHEN v_total_companies > 0 THEN round((v_active_companies_7d::numeric / v_total_companies * 100)::numeric, 1)
      ELSE 0
    END,
  -- Orphan records for Data Issues panel
  DECLARE
    v_orphan_agents jsonb;
    v_orphan_conversations jsonb;
    v_orphan_messages jsonb;
    v_orphan_visitors jsonb;
  BEGIN
    -- 1. Orphan agents (no workspace or invalid workspace)
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'name', a.name,
      'email', a.email,
      'role', a.role,
      'is_super_admin', a.is_super_admin,
      'created_at', a.created_at,
      'workspace_id', a.workspace_id,
      'issue_reason', CASE 
        WHEN a.workspace_id IS NULL THEN 'Unassigned workspace (workspace_id is NULL)'
        ELSE 'Referenced workspace does not exist'
      END
    )), '[]'::jsonb)
    INTO v_orphan_agents
    FROM public.agents a
    WHERE a.workspace_id IS NULL OR a.workspace_id NOT IN (SELECT id FROM public.workspaces);

    -- 2. Orphan conversations (no workspace or invalid workspace)
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id,
      'visitor_id', c.visitor_id,
      'status', c.status,
      'channel', c.channel,
      'created_at', c.created_at,
      'updated_at', c.updated_at,
      'workspace_id', c.workspace_id,
      'issue_reason', CASE 
        WHEN c.workspace_id IS NULL THEN 'Missing workspace (workspace_id is NULL)'
        ELSE 'Referenced workspace does not exist'
      END
    )), '[]'::jsonb)
    INTO v_orphan_conversations
    FROM public.conversations c
    WHERE c.workspace_id IS NULL OR c.workspace_id NOT IN (SELECT id FROM public.workspaces);

    -- 3. Orphan messages (no conversation, or conversation has invalid/null workspace)
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id,
      'conversation_id', m.conversation_id,
      'sender_type', m.sender_type,
      'created_at', m.created_at,
      'content_preview', substring(m.content from 1 for 60),
      'issue_reason', CASE 
        WHEN c.id IS NULL THEN 'Conversation does not exist'
        WHEN c.workspace_id IS NULL THEN 'Parent conversation has no workspace'
        ELSE 'Parent conversation belongs to deleted workspace'
      END
    )), '[]'::jsonb)
    INTO v_orphan_messages
    FROM public.messages m
    LEFT JOIN public.conversations c ON c.id = m.conversation_id
    WHERE c.id IS NULL OR c.workspace_id IS NULL OR c.workspace_id NOT IN (SELECT id FROM public.workspaces);

    -- 4. Orphan visitors (no workspace or invalid workspace)
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id,
      'name', v.name,
      'email', v.email,
      'current_url', v.current_url,
      'location', v.location,
      'last_seen', coalesce(v.last_seen_at, v.last_seen),
      'created_at', coalesce(v.first_seen_at, v.first_seen),
      'workspace_id', v.workspace_id,
      'issue_reason', CASE 
        WHEN v.workspace_id IS NULL THEN 'Unassigned workspace (workspace_id is NULL)'
        ELSE 'Referenced workspace does not exist'
      END
    )), '[]'::jsonb)
    INTO v_orphan_visitors
    FROM public.visitors v
    WHERE v.workspace_id IS NULL OR v.workspace_id NOT IN (SELECT id FROM public.workspaces);

    RETURN jsonb_build_object(
      'companies', v_companies,
      'total_companies', v_total_companies,
      'total_conversations', v_total_convs,
      'total_messages', v_total_messages,
      'total_visitors', v_total_visitors,
      'total_agents', v_total_agents,
      'active_companies_7d', v_active_companies_7d,
      'active_companies_7d_percent', CASE
        WHEN v_total_companies > 0 THEN round((v_active_companies_7d::numeric / v_total_companies * 100)::numeric, 1)
        ELSE 0
      END,
      'data_issues', jsonb_build_object(
        'total_orphan_count', jsonb_array_length(v_orphan_agents) + jsonb_array_length(v_orphan_conversations) + jsonb_array_length(v_orphan_messages) + jsonb_array_length(v_orphan_visitors),
        'orphan_agents', v_orphan_agents,
        'orphan_conversations', v_orphan_conversations,
        'orphan_messages', v_orphan_messages,
        'orphan_visitors', v_orphan_visitors
      )
    );
  END;
END;
$$;
