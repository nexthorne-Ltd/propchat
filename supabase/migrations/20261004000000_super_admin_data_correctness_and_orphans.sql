-- Migration: 20261004000000_super_admin_data_correctness_and_orphans.sql
-- Description: Ensure platform totals match sum of company cards, identify orphan data issues, and support service role inspection

-- 1. Update is_current_user_super_admin to recognize service_role and internal maintenance roles
CREATE OR REPLACE FUNCTION public.is_current_user_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    current_user IN ('postgres', 'supabase_admin', 'service_role'),
    false
  ) OR coalesce(
    auth.role() = 'service_role',
    false
  ) OR coalesce(
    (SELECT is_super_admin FROM public.agents WHERE id = auth.uid() LIMIT 1),
    false
  );
$$;

-- 2. Update fn_get_platform_companies_summary to guarantee platform totals equal sum of company cards
-- and detect orphan rows across agents, conversations, messages, and visitors for data integrity inspection.
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
      coalesce(w.help_center_tab_label, 'Help') as help_center_tab_label,
      coalesce(w.show_help_tab, true) as show_help_tab,
      w.created_at,
      w.owner_id,
      coalesce(c_agg.conversations_count, 0)::int as conversations_count,
      coalesce(c_agg.open_count, 0)::int as open_conversations_count,
      coalesce(c_agg.closed_count, 0)::int as closed_conversations_count,
      coalesce(m_agg.messages_count, 0)::int as messages_count,
      coalesce(v_agg.visitors_count, 0)::int as visitors_count,
      coalesce(v_agg.active_visitors_count, 0)::int as active_visitors_count,
      coalesce(a_agg.agents_count, 0)::int as agents_count,
      coalesce(art_agg.articles_count, 0)::int as articles_count,
      coalesce(art_agg.total_views, 0)::int as total_article_views
    from public.workspaces w
    left join lateral (
      select 
        count(*) as conversations_count,
        count(*) filter (where status = 'open') as open_count,
        count(*) filter (where status = 'closed') as closed_count
      from public.conversations
      where workspace_id = w.id
    ) c_agg on true
    left join lateral (
      select count(*) as messages_count
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where c.workspace_id = w.id
    ) m_agg on true
    left join lateral (
      select 
        count(*) as visitors_count,
        count(*) filter (where coalesce(last_seen, last_seen_at) > now() - interval '30 minutes') as active_visitors_count
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
