-- ============================================================================
-- Tenant isolation fixes that ticketing depends on (docs/AUDIT.md H-2, H-4)
--
-- Tickets are only as private as the rows around them: their threads are
-- `messages`, their requesters `visitors`, and every membership check reads
-- `agents`. Two flaws let any signed-in user past all of that.
--
-- H-2  is_current_user_super_admin() returned true for every caller. It
--      checked `current_user IN ('postgres', ...)`, and inside a SECURITY
--      DEFINER function current_user is the function's owner, `postgres`.
--      Every policy with "OR is_current_user_super_admin()" (conversations,
--      messages, visitors, agents, internal notes, canned responses, and via
--      fn_is_workspace_member the help centre and workspaces) was open to all
--      authenticated users, and fn_merge_workspaces to everyone.
--
--      The app had come to rely on it in four places that check slugs and
--      custom domains are unique across workspaces; they now read the
--      public_workspaces view, which exposes exactly those columns.
--
-- H-4  An agent could update their own row's workspace_id and role, joining
--      any workspace as admin (workspace IDs are public: they are in every
--      embed snippet).
--
-- Not fixed here: the anonymous widget policies (H-3) and the `current_user`
-- checks inside fn_get_platform_analytics / fn_get_platform_companies_summary.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- H-2
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_current_user_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(auth.role() = 'service_role', false)
      OR coalesce((SELECT is_super_admin FROM public.agents WHERE id = auth.uid() LIMIT 1), false);
$$;

-- ----------------------------------------------------------------------------
-- H-4
--
-- Workspace membership now means one of:
--   - the caller owns the workspace (onboarding links the owner this way);
--   - trusted server code moved them (invites use the service role);
--   - a platform super admin did it.
-- The same rule covers raising one's own role to admin or owner. Profile edits
-- (name, avatar, status) are unaffected, and so is creating an agent row with
-- no workspace, which the dashboard does on first sign-in.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_guard_agent_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_moving BOOLEAN;
  v_promoting BOOLEAN;
BEGIN
  -- No signed-in user: the service role, a migration, or a cron job.
  IF v_uid IS NULL OR coalesce(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.agents WHERE id = v_uid AND is_super_admin) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_moving := NEW.workspace_id IS NOT NULL;
    v_promoting := NEW.role IN ('admin', 'owner') AND NEW.workspace_id IS NOT NULL;
  ELSE
    v_moving := NEW.workspace_id IS DISTINCT FROM OLD.workspace_id AND NEW.workspace_id IS NOT NULL;
    v_promoting := NEW.role IS DISTINCT FROM OLD.role
      AND NEW.role IN ('admin', 'owner')
      AND NEW.workspace_id IS NOT NULL;
  END IF;

  IF (v_moving OR v_promoting)
     AND NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = NEW.workspace_id AND owner_id = v_uid) THEN
    RAISE EXCEPTION 'Forbidden: workspace membership and roles are granted by a workspace admin.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_agent_membership ON public.agents;
CREATE TRIGGER trg_guard_agent_membership
  BEFORE INSERT OR UPDATE OF workspace_id, role ON public.agents
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_agent_membership();
