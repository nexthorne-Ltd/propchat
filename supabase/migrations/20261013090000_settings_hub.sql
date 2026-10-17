-- ============================================================================
-- Settings hub: workspace timezone/language, per-agent notification
-- preferences, and a workspace audit log.
--
-- Problem: Settings → Workspace needs a default timezone and language, but only
-- business hours carried a timezone (inside a JSON blob) and nothing stored a
-- language. Agents had nowhere to choose which alerts they get. And admins had
-- no record of who changed workspace settings or someone's role; only the
-- platform-level super_admin_audit_logs existed.
--
-- 1. workspaces.timezone / workspaces.language (nullable; the app falls back to
--    the business-hours timezone and 'en').
-- 2. agent_notification_preferences: one row per (agent, workspace), readable
--    and writable only by that agent while they are an active member.
-- 3. workspace_audit_logs: written only by triggers (so every writer is
--    covered: the settings screens, the old inbox, server actions) and readable
--    only by owners and admins. Secrets are never copied in: a change records
--    which fields changed, not their values.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Workspace timezone and language
-- ----------------------------------------------------------------------------
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS timezone TEXT;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS language TEXT;

ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_timezone_length;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_timezone_length CHECK (timezone IS NULL OR char_length(timezone) BETWEEN 1 AND 64);

ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_language_format;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_language_format CHECK (language IS NULL OR language ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$');

-- ----------------------------------------------------------------------------
-- 2. Per-agent notification preferences
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_notification_preferences (
  agent_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email        JSONB NOT NULL DEFAULT '{}'::jsonb,
  in_app       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, workspace_id),
  CONSTRAINT notification_prefs_email_object CHECK (jsonb_typeof(email) = 'object'),
  CONSTRAINT notification_prefs_in_app_object CHECK (jsonb_typeof(in_app) = 'object')
);

ALTER TABLE public.agent_notification_preferences ENABLE ROW LEVEL SECURITY;

-- Your own row, and only while you are an active member of that workspace.
DROP POLICY IF EXISTS notification_prefs_select_own ON public.agent_notification_preferences;
CREATE POLICY notification_prefs_select_own ON public.agent_notification_preferences
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid() AND public.fn_workspace_role(workspace_id) IS NOT NULL);

DROP POLICY IF EXISTS notification_prefs_insert_own ON public.agent_notification_preferences;
CREATE POLICY notification_prefs_insert_own ON public.agent_notification_preferences
  FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid() AND public.fn_workspace_role(workspace_id) IS NOT NULL);

DROP POLICY IF EXISTS notification_prefs_update_own ON public.agent_notification_preferences;
CREATE POLICY notification_prefs_update_own ON public.agent_notification_preferences
  FOR UPDATE TO authenticated
  USING (agent_id = auth.uid() AND public.fn_workspace_role(workspace_id) IS NOT NULL)
  WITH CHECK (agent_id = auth.uid() AND public.fn_workspace_role(workspace_id) IS NOT NULL);

DROP POLICY IF EXISTS notification_prefs_delete_own ON public.agent_notification_preferences;
CREATE POLICY notification_prefs_delete_own ON public.agent_notification_preferences
  FOR DELETE TO authenticated
  USING (agent_id = auth.uid());

REVOKE ALL ON public.agent_notification_preferences FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_notification_preferences TO authenticated;
GRANT ALL ON public.agent_notification_preferences TO service_role;

-- ----------------------------------------------------------------------------
-- 3. Workspace audit log
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_id     UUID,
  actor_name   TEXT,
  action       TEXT NOT NULL,
  target       TEXT,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_audit_logs_ws_created_idx
  ON public.workspace_audit_logs (workspace_id, created_at DESC);

ALTER TABLE public.workspace_audit_logs ENABLE ROW LEVEL SECURITY;

-- Owners and admins read their own workspace's log. No INSERT/UPDATE/DELETE
-- policy exists on purpose: only the triggers below write, and nobody edits
-- history.
DROP POLICY IF EXISTS workspace_audit_logs_select_admin ON public.workspace_audit_logs;
CREATE POLICY workspace_audit_logs_select_admin ON public.workspace_audit_logs
  FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'));

REVOKE ALL ON public.workspace_audit_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.workspace_audit_logs TO authenticated;
GRANT ALL ON public.workspace_audit_logs TO service_role;

-- Workspace edits: which fields changed, never their values (ai_settings and
-- smtp_settings hold secrets). Skips machine writes (crons, DNS checks) where
-- nobody is signed in, and counters/timestamps that change on their own.
CREATE OR REPLACE FUNCTION public.fn_audit_workspace_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed TEXT[];
  v_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}')
    INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) n
    LEFT JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
   WHERE n.value IS DISTINCT FROM o.value
     AND n.key NOT IN (
       'updated_at', 'slug_changes_count', 'slug_changed_at', 'widget_installed',
       'custom_domain_last_checked_at', 'custom_domain_notification_sent',
       'custom_domain_verified_at', 'custom_domain_connected_at', 'navbar_prompt_dismissed'
     );

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_name FROM public.agents WHERE id = auth.uid();

  INSERT INTO public.workspace_audit_logs (workspace_id, actor_id, actor_name, action, target, details)
  VALUES (NEW.id, auth.uid(), v_name, 'workspace.updated', NEW.name, jsonb_build_object('fields', to_jsonb(v_changed)));

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_workspace_update ON public.workspaces;
CREATE TRIGGER trg_audit_workspace_update
  AFTER UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_workspace_update();

-- Role and access changes for team members.
CREATE OR REPLACE FUNCTION public.fn_audit_member_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_name TEXT;
BEGIN
  IF auth.uid() IS NULL OR NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.role IS NOT DISTINCT FROM OLD.role AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_actor_name FROM public.agents WHERE id = auth.uid();

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    INSERT INTO public.workspace_audit_logs (workspace_id, actor_id, actor_name, action, target, details)
    VALUES (NEW.workspace_id, auth.uid(), v_actor_name, 'member.role_changed', NEW.name,
            jsonb_build_object('from', OLD.role, 'to', NEW.role));
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    INSERT INTO public.workspace_audit_logs (workspace_id, actor_id, actor_name, action, target, details)
    VALUES (NEW.workspace_id, auth.uid(), v_actor_name,
            CASE WHEN NEW.is_active THEN 'member.reactivated' ELSE 'member.deactivated' END,
            NEW.name, '{}'::jsonb);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_member_change ON public.agents;
CREATE TRIGGER trg_audit_member_change
  AFTER UPDATE OF role, is_active ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_member_change();
