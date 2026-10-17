-- ============================================================================
-- Migration: 20261112090000_system_health_email_issues.sql
-- Description: Fix fn_get_platform_system_health to inspect channel_connections
--              for email issues instead of non-existent email_verifications columns.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_get_platform_system_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- 2. Email Channel issues (read channel_connections where channel = 'email' and status != 'connected' or last_error set)
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', cc.id,
      'workspace_id', cc.workspace_id,
      'workspace_name', coalesce(w.name, 'Unknown'),
      'error_type', coalesce(cc.last_error, 'verification_pending'),
      'created_at', cc.created_at
    ) ORDER BY cc.created_at DESC
  ) INTO v_email_issues
  FROM public.channel_connections cc
  LEFT JOIN public.workspaces w ON w.id = cc.workspace_id
  WHERE cc.channel = 'email' AND (cc.status != 'connected' OR cc.last_error IS NOT NULL)
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
$function$;

REVOKE ALL ON FUNCTION public.fn_get_platform_system_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_platform_system_health() TO authenticated, service_role;
