-- Migration: 20261002030000_super_admin_lockdown_and_rls.sql
-- Description: Platform super admin flag, strict RLS isolation per workspace, audit logging, and protected RPCs.

-- 1. Add is_super_admin column to agents table if not exists
ALTER TABLE public.agents 
ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Initialize existing platform admins
UPDATE public.agents
SET is_super_admin = TRUE
WHERE email IN ('musmanrai372@gmail.com', 'raiusman37218@gmail.com');

-- 2. Helper function: check if current authenticated user is a platform super admin
CREATE OR REPLACE FUNCTION public.is_current_user_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT is_super_admin FROM public.agents WHERE id = auth.uid() LIMIT 1),
    false
  );
$$;

-- 3. Helper function: return set of workspace_ids current user has membership in or owns
CREATE OR REPLACE FUNCTION public.current_user_workspace_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT workspace_id FROM public.agents WHERE id = auth.uid() AND workspace_id IS NOT NULL
  UNION
  SELECT id FROM public.workspaces WHERE owner_id = auth.uid();
$$;

-- Update fn_is_workspace_member and fn_is_workspace_admin to include super admins
CREATE OR REPLACE FUNCTION public.fn_is_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agents
    WHERE id = auth.uid()
      AND workspace_id = p_workspace_id
  ) OR EXISTS (
    SELECT 1 FROM public.workspaces
    WHERE id = p_workspace_id
      AND owner_id = auth.uid()
  ) OR public.is_current_user_super_admin();
$$;

CREATE OR REPLACE FUNCTION public.fn_is_workspace_admin(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agents
    WHERE id = auth.uid()
      AND workspace_id = p_workspace_id
      AND role IN ('admin', 'owner')
  ) OR EXISTS (
    SELECT 1 FROM public.workspaces
    WHERE id = p_workspace_id
      AND owner_id = auth.uid()
  ) OR public.is_current_user_super_admin();
$$;

-- 4. Trigger to prevent non-super admins from self-promoting or altering is_super_admin
CREATE OR REPLACE FUNCTION public.fn_protect_agent_super_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_super_admin = TRUE THEN
      IF auth.uid() IS NOT NULL AND NOT public.is_current_user_super_admin() THEN
        NEW.is_super_admin := FALSE;
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin THEN
      IF auth.uid() IS NOT NULL AND NOT public.is_current_user_super_admin() THEN
        RAISE EXCEPTION 'Forbidden: You do not have permission to modify super admin privileges.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_agent_super_admin ON public.agents;
CREATE TRIGGER trg_protect_agent_super_admin
BEFORE INSERT OR UPDATE ON public.agents
FOR EACH ROW
EXECUTE FUNCTION public.fn_protect_agent_super_admin();

-- 5. Audit Log Table for Super Admin actions
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

-- 6. Lock down RPC fn_get_platform_companies_summary to super admins only
CREATE OR REPLACE FUNCTION public.fn_get_platform_companies_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  v_result jsonb;
begin
  -- Enforce platform super admin check inside the database
  IF NOT public.is_current_user_super_admin() THEN
    RAISE EXCEPTION 'Forbidden: Platform super admin privileges required.';
  END IF;

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
        count(*) filter (where last_seen > now() - interval '30 minutes') as active_visitors_count
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
    'total_companies', (select count(*) from public.workspaces),
    'total_conversations', (select count(*) from public.conversations),
    'total_messages', (select count(*) from public.messages),
    'total_visitors', (select count(*) from public.visitors),
    'total_agents', (select count(*) from public.agents),
    'total_articles', (select count(*) from public.articles),
    'companies', coalesce(jsonb_agg(to_jsonb(ws_metrics)), '[]'::jsonb)
  )
  into v_result
  from ws_metrics;

  return v_result;
end;
$$;

-- 7. RLS POLICIES LOCKDOWN: STRICT TENANT ISOLATION
-- ==============================================================================

-- 7.1 CONVERSATIONS TABLE
DROP POLICY IF EXISTS "Allow agents full access to conversations" ON public.conversations;
DROP POLICY IF EXISTS "Allow anon to insert conversations" ON public.conversations;
DROP POLICY IF EXISTS "Allow anon to read conversations" ON public.conversations;
DROP POLICY IF EXISTS "Allow anon to update conversations" ON public.conversations;
DROP POLICY IF EXISTS "Conversations: public can insert and read" ON public.conversations;
DROP POLICY IF EXISTS "Conversations: public can insert" ON public.conversations;
DROP POLICY IF EXISTS "Conversations: public can update" ON public.conversations;
DROP POLICY IF EXISTS "Allow authenticated agents access to conversations" ON public.conversations;

CREATE POLICY "Allow authenticated agents access to conversations"
ON public.conversations
FOR ALL
TO authenticated
USING (
  workspace_id IN (SELECT public.current_user_workspace_ids())
  OR public.is_current_user_super_admin()
)
WITH CHECK (
  workspace_id IN (SELECT public.current_user_workspace_ids())
  OR public.is_current_user_super_admin()
);

CREATE POLICY "Allow anon to insert conversations"
ON public.conversations
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow anon to read conversations"
ON public.conversations
FOR SELECT
TO anon
USING (true);

CREATE POLICY "Allow anon to update conversations"
ON public.conversations
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- 7.2 MESSAGES TABLE
DROP POLICY IF EXISTS "Allow agents full access to messages" ON public.messages;
DROP POLICY IF EXISTS "Allow anon to insert visitor messages" ON public.messages;
DROP POLICY IF EXISTS "Allow anon to read public messages" ON public.messages;
DROP POLICY IF EXISTS "Allow anon to update message read_at" ON public.messages;
DROP POLICY IF EXISTS "Allow insert messages from webhooks and agents" ON public.messages;
DROP POLICY IF EXISTS "Messages: public can select" ON public.messages;
DROP POLICY IF EXISTS "Messages: public can insert visitor message" ON public.messages;
DROP POLICY IF EXISTS "Allow authenticated agents access to messages" ON public.messages;

CREATE POLICY "Allow authenticated agents access to messages"
ON public.messages
FOR ALL
TO authenticated
USING (
  conversation_id IN (
    SELECT id FROM public.conversations 
    WHERE workspace_id IN (SELECT public.current_user_workspace_ids())
  )
  OR public.is_current_user_super_admin()
)
WITH CHECK (
  conversation_id IN (
    SELECT id FROM public.conversations 
    WHERE workspace_id IN (SELECT public.current_user_workspace_ids())
  )
  OR public.is_current_user_super_admin()
);

CREATE POLICY "Allow anon to read public messages"
ON public.messages
FOR SELECT
TO anon
USING (is_internal IS NOT TRUE);

CREATE POLICY "Allow anon to insert visitor messages"
ON public.messages
FOR INSERT
TO anon
WITH CHECK (sender_type = 'visitor');

CREATE POLICY "Allow anon to update message read_at"
ON public.messages
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- 7.3 VISITORS TABLE
DROP POLICY IF EXISTS "Allow anon to select own visitor record" ON public.visitors;
DROP POLICY IF EXISTS "Allow anon and agents to insert/update visitors" ON public.visitors;
DROP POLICY IF EXISTS "Allow update to visitors" ON public.visitors;
DROP POLICY IF EXISTS "Allow authenticated agents to view all visitors" ON public.visitors;
DROP POLICY IF EXISTS "Visitors: anon can insert" ON public.visitors;
DROP POLICY IF EXISTS "Visitors: anon can select and update own record" ON public.visitors;
DROP POLICY IF EXISTS "Visitors: anon can update" ON public.visitors;
DROP POLICY IF EXISTS "Allow authenticated agents view workspace visitors" ON public.visitors;
DROP POLICY IF EXISTS "Allow anon to insert visitors" ON public.visitors;
DROP POLICY IF EXISTS "Allow anon to select visitors" ON public.visitors;
DROP POLICY IF EXISTS "Allow anon to update visitors" ON public.visitors;

CREATE POLICY "Allow authenticated agents view workspace visitors"
ON public.visitors
FOR ALL
TO authenticated
USING (
  workspace_id IN (SELECT public.current_user_workspace_ids())
  OR public.is_current_user_super_admin()
)
WITH CHECK (
  workspace_id IN (SELECT public.current_user_workspace_ids())
  OR public.is_current_user_super_admin()
);

CREATE POLICY "Allow anon to insert visitors"
ON public.visitors
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow anon to select visitors"
ON public.visitors
FOR SELECT
TO anon
USING (true);

CREATE POLICY "Allow anon to update visitors"
ON public.visitors
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- 7.4 AGENTS TABLE
DROP POLICY IF EXISTS "Allow anyone to read agents list" ON public.agents;
DROP POLICY IF EXISTS "Allow agents to update their own profile" ON public.agents;
DROP POLICY IF EXISTS "Allow authenticated users to insert their own agent profile" ON public.agents;
DROP POLICY IF EXISTS "Agents: public can read agent profiles" ON public.agents;
DROP POLICY IF EXISTS "Agents: authenticated can update own profile" ON public.agents;
DROP POLICY IF EXISTS "Agents: authenticated can insert own profile" ON public.agents;
DROP POLICY IF EXISTS "Allow authenticated agents view workspace agents" ON public.agents;
DROP POLICY IF EXISTS "Allow anon read agents for widget" ON public.agents;

CREATE POLICY "Allow authenticated agents view workspace agents"
ON public.agents
FOR SELECT
TO authenticated
USING (
  workspace_id IN (SELECT public.current_user_workspace_ids())
  OR id = auth.uid()
  OR public.is_current_user_super_admin()
);

CREATE POLICY "Allow authenticated users to insert their own agent profile"
ON public.agents
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = id);

CREATE POLICY "Allow agents to update their own profile"
ON public.agents
FOR UPDATE
TO authenticated
USING (
  auth.uid() = id
  OR public.is_current_user_super_admin()
)
WITH CHECK (
  auth.uid() = id
  OR public.is_current_user_super_admin()
);

CREATE POLICY "Allow anon read agents for widget"
ON public.agents
FOR SELECT
TO anon
USING (true);

-- 7.5 INTERNAL NOTES TABLE
DROP POLICY IF EXISTS "Internal Notes: authenticated agents only" ON public.internal_notes;
DROP POLICY IF EXISTS "Allow authenticated agents access to internal notes" ON public.internal_notes;

CREATE POLICY "Allow authenticated agents access to internal notes"
ON public.internal_notes
FOR ALL
TO authenticated
USING (
  conversation_id IN (
    SELECT id FROM public.conversations 
    WHERE workspace_id IN (SELECT public.current_user_workspace_ids())
  )
  OR public.is_current_user_super_admin()
)
WITH CHECK (
  conversation_id IN (
    SELECT id FROM public.conversations 
    WHERE workspace_id IN (SELECT public.current_user_workspace_ids())
  )
  OR public.is_current_user_super_admin()
);

-- 7.6 CANNED RESPONSES TABLE
DROP POLICY IF EXISTS "Allow all delete canned_responses" ON public.canned_responses;
DROP POLICY IF EXISTS "Allow all insert canned_responses" ON public.canned_responses;
DROP POLICY IF EXISTS "Allow all read canned_responses" ON public.canned_responses;
DROP POLICY IF EXISTS "Allow all update canned_responses" ON public.canned_responses;
DROP POLICY IF EXISTS "Canned Responses: authenticated access" ON public.canned_responses;
DROP POLICY IF EXISTS "Allow authenticated agents access to canned responses" ON public.canned_responses;

CREATE POLICY "Allow authenticated agents access to canned responses"
ON public.canned_responses
FOR ALL
TO authenticated
USING (
  workspace_id IN (SELECT public.current_user_workspace_ids())
  OR public.is_current_user_super_admin()
)
WITH CHECK (
  workspace_id IN (SELECT public.current_user_workspace_ids())
  OR public.is_current_user_super_admin()
);
