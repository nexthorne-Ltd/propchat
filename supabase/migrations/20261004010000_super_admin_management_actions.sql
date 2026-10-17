-- Migration: 20261004010000_super_admin_management_actions.sql
-- Description: Add management columns (suspend, soft delete, plan & limits, merge) and update RPCs

-- 1. Add columns to public.workspaces
ALTER TABLE public.workspaces
ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free',
ADD COLUMN IF NOT EXISTS plan_limits JSONB NOT NULL DEFAULT '{"max_seats": 5, "max_monthly_conversations": 1000, "max_ai_replies": 500}'::jsonb,
ADD COLUMN IF NOT EXISTS merged_into_workspace_id UUID REFERENCES public.workspaces(id);

-- 2. Update fn_get_workspace_config to block suspended and soft-deleted workspaces from loading the widget
CREATE OR REPLACE FUNCTION public.fn_get_workspace_config(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  v_ws public.workspaces;
begin
  select * into v_ws from public.workspaces where id = p_workspace_id;
  if not found or coalesce(v_ws.is_suspended, false) = true or v_ws.deleted_at is not null then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_ws.id,
    'name', v_ws.name,
    'website_url', v_ws.website_url,
    'brand_color', v_ws.brand_color,
    'logo_url', v_ws.logo_url,
    'show_launcher_logo', coalesce(v_ws.show_launcher_logo, true),
    'widget_position', coalesce(v_ws.widget_position, 'right'),
    'launcher_offset_bottom', coalesce(v_ws.launcher_offset_bottom, 20),
    'launcher_offset_side', coalesce(v_ws.launcher_offset_side, 20),
    'widget_z_index', coalesce(v_ws.widget_z_index, 2147483000),
    'enable_proactive_welcome', coalesce(v_ws.enable_proactive_welcome, true),
    'proactive_delay_seconds', coalesce(v_ws.proactive_delay_seconds, 8),
    'greeting_title', v_ws.greeting_title,
    'greeting_message', v_ws.greeting_message,
    'business_hours', v_ws.business_hours,
    'auto_assignment', v_ws.auto_assignment,
    'help_center_tab_label', coalesce(v_ws.help_center_tab_label, 'Help'),
    'show_help_tab', coalesce(v_ws.show_help_tab, true),
    'help_center_tab_icon', coalesce(v_ws.help_center_tab_icon, '📖'),
    'custom_domain', v_ws.custom_domain,
    'custom_domain_status', v_ws.custom_domain_status,
    'navbar_trigger_config', coalesce(v_ws.navbar_trigger_config, '{"enabled": false, "label": "FAQ", "action": "help", "auto_inject": false, "style": "navbar_link"}'::jsonb),
    'agents', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'avatar_url', a.avatar_url, 'status', a.status)), '[]'::jsonb)
      FROM public.agents a
      WHERE a.workspace_id = v_ws.id
    )
  );
end;
$$;

-- 3. Update fn_get_platform_companies_summary with all card and table metrics
CREATE OR REPLACE FUNCTION public.fn_get_platform_companies_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  v_result jsonb;
  v_orphan_agents jsonb;
  v_orphan_conversations jsonb;
  v_orphan_messages jsonb;
  v_orphan_visitors jsonb;
begin
  -- Enforce platform super admin check inside the database
  IF NOT public.is_current_user_super_admin() THEN
    RAISE EXCEPTION 'Forbidden: Platform super admin privileges required.';
  END IF;

  -- 1. Orphan agents (no workspace or invalid workspace)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'name', a.name,
    'email', a.email,
    'role', a.role,
    'is_super_admin', a.is_super_admin,
    'created_at', a.created_at,
    'workspace_id', a.workspace_id,
    'issue_reason', case 
      when a.workspace_id is null then 'Unassigned workspace (workspace_id is NULL)'
      else 'Referenced workspace does not exist'
    end
  )), '[]'::jsonb)
  into v_orphan_agents
  from public.agents a
  where a.workspace_id is null or a.workspace_id not in (select id from public.workspaces);

  -- 2. Orphan conversations (no workspace or invalid workspace)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'visitor_id', c.visitor_id,
    'status', c.status,
    'channel', c.channel,
    'created_at', c.created_at,
    'updated_at', c.updated_at,
    'workspace_id', c.workspace_id,
    'issue_reason', case 
      when c.workspace_id is null then 'Missing workspace (workspace_id is NULL)'
      else 'Referenced workspace does not exist'
    end
  )), '[]'::jsonb)
  into v_orphan_conversations
  from public.conversations c
  where c.workspace_id is null or c.workspace_id not in (select id from public.workspaces);

  -- 3. Orphan messages (no conversation, or conversation has invalid/null workspace)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'conversation_id', m.conversation_id,
    'sender_type', m.sender_type,
    'created_at', m.created_at,
    'content_preview', substring(m.content from 1 for 60),
    'issue_reason', case 
      when c.id is null then 'Conversation does not exist'
      when c.workspace_id is null then 'Parent conversation has no workspace'
      else 'Parent conversation belongs to deleted workspace'
    end
  )), '[]'::jsonb)
  into v_orphan_messages
  from public.messages m
  left join public.conversations c on c.id = m.conversation_id
  where c.id is null or c.workspace_id is null or c.workspace_id not in (select id from public.workspaces);

  -- 4. Orphan visitors (no workspace or invalid workspace)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id,
    'name', v.name,
    'email', v.email,
    'current_url', coalesce(v.current_url, v.current_page_url),
    'location', coalesce(v.location, v.ip_location_city),
    'last_seen', coalesce(v.last_seen, v.last_seen_at),
    'created_at', coalesce(v.first_seen, v.first_seen_at),
    'workspace_id', v.workspace_id,
    'issue_reason', case 
      when v.workspace_id is null then 'Unassigned workspace (workspace_id is NULL)'
      else 'Referenced workspace does not exist'
    end
  )), '[]'::jsonb)
  into v_orphan_visitors
  from public.visitors v
  where v.workspace_id is null or v.workspace_id not in (select id from public.workspaces);

  -- 5. Per-workspace metrics
  with ws_metrics as (
    select
      w.id,
      w.name,
      w.website_url,
      w.brand_color,
      w.logo_url,
      coalesce(w.widget_position, 'right') as widget_position,
      w.greeting_title,
      w.greeting_message,
      w.business_hours,
      w.auto_assignment,
      w.ai_settings,
      coalesce((w.ai_settings->>'enabled')::boolean, false) as ai_enabled,
      coalesce(w.help_center_tab_label, 'Help') as help_center_tab_label,
      coalesce(w.show_help_tab, true) as show_help_tab,
      w.created_at,
      w.owner_id,
      (select a.email from public.agents a where a.id = w.owner_id limit 1) as owner_email,
      coalesce(w.is_suspended, false) as is_suspended,
      w.suspended_at,
      w.suspension_reason,
      w.deleted_at,
      coalesce(w.plan, 'free') as plan,
      coalesce(w.plan_limits, '{"max_seats": 5, "max_monthly_conversations": 1000, "max_ai_replies": 500}'::jsonb) as plan_limits,
      w.merged_into_workspace_id,
      coalesce(c_agg.conversations_count, 0)::int as conversations_count,
      coalesce(c_agg.open_count, 0)::int as open_conversations_count,
      coalesce(c_agg.closed_count, 0)::int as closed_conversations_count,
      coalesce(m_agg.messages_count, 0)::int as messages_count,
      coalesce(v_agg.visitors_count, 0)::int as visitors_count,
      coalesce(v_agg.active_visitors_count, 0)::int as active_visitors_count,
      coalesce(a_agg.agents_count, 0)::int as agents_count,
      coalesce(art_agg.articles_count, 0)::int as articles_count,
      coalesce(art_agg.published_articles_count, 0)::int as published_articles_count,
      coalesce(art_agg.total_views, 0)::int as total_article_views,
      (coalesce(v_agg.visitors_count, 0) > 0 or coalesce(c_agg.conversations_count, 0) > 0) as widget_installed,
      greatest(
        w.created_at,
        c_agg.last_conv_at,
        m_agg.last_msg_at,
        v_agg.last_visitor_at
      ) as last_activity_at
    from public.workspaces w
    left join lateral (
      select 
        count(*) as conversations_count,
        count(*) filter (where status = 'open') as open_count,
        count(*) filter (where status = 'closed') as closed_count,
        max(coalesce(updated_at, created_at)) as last_conv_at
      from public.conversations
      where workspace_id = w.id
    ) c_agg on true
    left join lateral (
      select 
        count(*) as messages_count,
        max(m.created_at) as last_msg_at
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where c.workspace_id = w.id
    ) m_agg on true
    left join lateral (
      select 
        count(*) as visitors_count,
        count(*) filter (where coalesce(last_seen, last_seen_at) > now() - interval '30 minutes') as active_visitors_count,
        max(coalesce(last_seen, last_seen_at)) as last_visitor_at
      from public.visitors
      where workspace_id = w.id
    ) v_agg on true
    left join lateral (
      select count(*) as agents_count
      from public.agents
      where workspace_id = w.id
    ) a_agg on true
    left join lateral (
      select 
        count(*) as articles_count,
        count(*) filter (where status = 'published') as published_articles_count,
        coalesce(sum(views_count), 0) as total_views
      from public.articles
      where workspace_id = w.id
    ) art_agg on true
    order by w.created_at desc
  )
  select jsonb_build_object(
    'total_companies', coalesce((select count(*) from ws_metrics), 0),
    'total_conversations', coalesce((select sum(conversations_count) from ws_metrics), 0),
    'total_messages', coalesce((select sum(messages_count) from ws_metrics), 0),
    'total_visitors', coalesce((select sum(visitors_count) from ws_metrics), 0),
    'total_agents', coalesce((select sum(agents_count) from ws_metrics), 0),
    'total_articles', coalesce((select sum(articles_count) from ws_metrics), 0),
    'companies', coalesce(jsonb_agg(to_jsonb(ws_metrics)), '[]'::jsonb),
    'data_issues', jsonb_build_object(
      'total_orphan_count', jsonb_array_length(v_orphan_agents) + jsonb_array_length(v_orphan_conversations) + jsonb_array_length(v_orphan_messages) + jsonb_array_length(v_orphan_visitors),
      'orphan_agents', v_orphan_agents,
      'orphan_conversations', v_orphan_conversations,
      'orphan_messages', v_orphan_messages,
      'orphan_visitors', v_orphan_visitors
    )
  )
  into v_result
  from ws_metrics;

  return v_result;
end;
$$;

-- 4. Workspace Merging Function
CREATE OR REPLACE FUNCTION public.fn_merge_workspaces(p_source_id uuid, p_target_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  v_source public.workspaces;
  v_target public.workspaces;
  v_conv_count int := 0;
  v_vis_count int := 0;
  v_art_count int := 0;
  v_sec_count int := 0;
  v_canned_count int := 0;
  v_agents_count int := 0;
begin
  -- Enforce platform super admin
  IF NOT public.is_current_user_super_admin() THEN
    RAISE EXCEPTION 'Forbidden: Platform super admin privileges required.';
  END IF;

  IF p_source_id = p_target_id THEN
    RAISE EXCEPTION 'Cannot merge a workspace into itself.';
  END IF;

  SELECT * INTO v_source FROM public.workspaces WHERE id = p_source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source workspace not found.';
  END IF;

  SELECT * INTO v_target FROM public.workspaces WHERE id = p_target_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target workspace not found.';
  END IF;

  -- 1. Transfer conversations
  UPDATE public.conversations SET workspace_id = p_target_id WHERE workspace_id = p_source_id;
  GET DIAGNOSTICS v_conv_count = ROW_COUNT;

  -- 2. Transfer visitors
  UPDATE public.visitors SET workspace_id = p_target_id WHERE workspace_id = p_source_id;
  GET DIAGNOSTICS v_vis_count = ROW_COUNT;

  -- 3. Transfer articles & sections
  UPDATE public.help_sections SET workspace_id = p_target_id WHERE workspace_id = p_source_id;
  GET DIAGNOSTICS v_sec_count = ROW_COUNT;

  UPDATE public.articles SET workspace_id = p_target_id WHERE workspace_id = p_source_id;
  GET DIAGNOSTICS v_art_count = ROW_COUNT;

  UPDATE public.article_chunks SET workspace_id = p_target_id WHERE workspace_id = p_source_id;
  UPDATE public.article_feedback SET workspace_id = p_target_id WHERE workspace_id = p_source_id;
  UPDATE public.article_slug_redirects SET workspace_id = p_target_id WHERE workspace_id = p_source_id;
  UPDATE public.knowledge_notes SET workspace_id = p_target_id WHERE workspace_id = p_source_id;
  UPDATE public.unanswered_questions SET workspace_id = p_target_id WHERE workspace_id = p_source_id;

  -- 4. Transfer canned responses
  UPDATE public.canned_responses SET workspace_id = p_target_id WHERE workspace_id = p_source_id;
  GET DIAGNOSTICS v_canned_count = ROW_COUNT;

  -- 5. Transfer non-conflicting agents
  UPDATE public.agents
  SET workspace_id = p_target_id
  WHERE workspace_id = p_source_id
    AND id NOT IN (SELECT id FROM public.agents WHERE workspace_id = p_target_id);
  GET DIAGNOSTICS v_agents_count = ROW_COUNT;

  -- 6. Mark source workspace as merged and soft-deleted
  UPDATE public.workspaces
  SET is_suspended = true,
      suspended_at = coalesce(suspended_at, now()),
      suspension_reason = 'Merged into workspace ' || v_target.name || ' (' || p_target_id::text || ')',
      deleted_at = coalesce(deleted_at, now()),
      merged_into_workspace_id = p_target_id
  WHERE id = p_source_id;

  RETURN jsonb_build_object(
    'success', true,
    'source_workspace_id', p_source_id,
    'target_workspace_id', p_target_id,
    'conversations_moved', v_conv_count,
    'visitors_moved', v_vis_count,
    'articles_moved', v_art_count,
    'sections_moved', v_sec_count,
    'canned_responses_moved', v_canned_count,
    'agents_moved', v_agents_count
  );
end;
$$;
