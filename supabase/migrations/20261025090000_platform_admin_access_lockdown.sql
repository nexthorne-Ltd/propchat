-- ============================================================================
-- Migration: 20261025090000_platform_admin_access_lockdown.sql
-- Description: Locks down Zentry admin panel to platform_access table.
--              Owner is strictly <zentry385@gmail.com>.
--              Removes all other super admins, seeds platform_access,
--              enforces single owner, owner non-removable, and RLS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Create public.platform_access table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_access_user_id ON public.platform_access(user_id);

-- Enforce exactly one owner row in platform_access at all times
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_access_single_owner
ON public.platform_access (role)
WHERE role = 'owner';

-- ----------------------------------------------------------------------------
-- 2. Trigger: The owner can never be removed, demoted or transferred
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_protect_platform_owner_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'owner' THEN
      RAISE EXCEPTION 'The platform owner account cannot be removed.';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.role = 'owner' THEN
      IF NEW.role <> 'owner' THEN
        RAISE EXCEPTION 'The platform owner account cannot be demoted.';
      END IF;
      IF NEW.user_id <> OLD.user_id THEN
        RAISE EXCEPTION 'The platform owner account cannot be changed.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_platform_owner_access ON public.platform_access;
CREATE TRIGGER trg_protect_platform_owner_access
BEFORE UPDATE OR DELETE ON public.platform_access
FOR EACH ROW
EXECUTE FUNCTION public.fn_protect_platform_owner_access();

-- ----------------------------------------------------------------------------
-- 3. Trigger: Automatically enroll zentry385@gmail.com as owner on auth signup
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sync_platform_owner_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF lower(NEW.email) = 'zentry385@gmail.com' THEN
    INSERT INTO public.platform_access (user_id, role, granted_by, granted_at)
    VALUES (NEW.id, 'owner', NEW.id, now())
    ON CONFLICT (user_id) DO UPDATE SET role = 'owner';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_platform_owner_auth ON auth.users;
CREATE TRIGGER trg_sync_platform_owner_auth
AFTER INSERT OR UPDATE OF email ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_platform_owner_auth();

-- ----------------------------------------------------------------------------
-- 4. Trigger: Sync public.agents table flags from platform_access
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sync_agent_from_platform_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    UPDATE public.agents
    SET is_super_admin = true,
        is_platform_owner = (NEW.role = 'owner'),
        platform_staff_role = CASE WHEN NEW.role = 'owner' THEN 'owner' ELSE 'support' END
    WHERE id = NEW.user_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.agents
    SET is_super_admin = false,
        is_platform_owner = false,
        platform_staff_role = NULL
    WHERE id = OLD.user_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_agent_from_platform_access ON public.platform_access;
CREATE TRIGGER trg_sync_agent_from_platform_access
AFTER INSERT OR UPDATE OR DELETE ON public.platform_access
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_agent_from_platform_access();

-- ----------------------------------------------------------------------------
-- 5. Trigger: Audit log every grant and revocation
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_audit_platform_access_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_email TEXT;
  v_admin_email TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT email INTO v_target_email FROM auth.users WHERE id = NEW.user_id;
    SELECT email INTO v_admin_email FROM auth.users WHERE id = coalesce(NEW.granted_by, auth.uid());
    INSERT INTO public.super_admin_audit_logs (
      admin_id,
      admin_email,
      admin_name,
      action,
      details
    ) VALUES (
      coalesce(NEW.granted_by, auth.uid(), NEW.user_id),
      coalesce(v_admin_email, 'system'),
      'Platform Owner',
      'platform_admin_access_granted',
      jsonb_build_object(
        'target_user_id', NEW.user_id,
        'target_email', v_target_email,
        'role', NEW.role
      )
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT email INTO v_target_email FROM auth.users WHERE id = OLD.user_id;
    SELECT email INTO v_admin_email FROM auth.users WHERE id = auth.uid();
    INSERT INTO public.super_admin_audit_logs (
      admin_id,
      admin_email,
      admin_name,
      action,
      details
    ) VALUES (
      coalesce(auth.uid(), OLD.user_id),
      coalesce(v_admin_email, 'system'),
      'Platform Owner',
      'platform_admin_access_revoked',
      jsonb_build_object(
        'target_user_id', OLD.user_id,
        'target_email', v_target_email,
        'role', OLD.role
      )
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_platform_access_change ON public.platform_access;
CREATE TRIGGER trg_audit_platform_access_change
AFTER INSERT OR DELETE ON public.platform_access
FOR EACH ROW
EXECUTE FUNCTION public.fn_audit_platform_access_change();

-- ----------------------------------------------------------------------------
-- 6. Helper functions: is_current_user_super_admin() and is_current_user_platform_owner()
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_current_user_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_access
    WHERE user_id = auth.uid()
      AND role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_current_user_platform_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_access
    WHERE user_id = auth.uid()
      AND role = 'owner'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_current_user_super_admin() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_current_user_platform_owner() TO authenticated, anon;

-- ----------------------------------------------------------------------------
-- 7. Row Level Security for public.platform_access
-- ----------------------------------------------------------------------------
ALTER TABLE public.platform_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Platform admins can view platform access" ON public.platform_access;
CREATE POLICY "Platform admins can view platform access"
ON public.platform_access
FOR SELECT
TO authenticated
USING (public.is_current_user_super_admin());

DROP POLICY IF EXISTS "Only platform owner can insert platform access" ON public.platform_access;
CREATE POLICY "Only platform owner can insert platform access"
ON public.platform_access
FOR INSERT
TO authenticated
WITH CHECK (public.is_current_user_platform_owner());

DROP POLICY IF EXISTS "Only platform owner can update platform access" ON public.platform_access;
CREATE POLICY "Only platform owner can update platform access"
ON public.platform_access
FOR UPDATE
TO authenticated
USING (public.is_current_user_platform_owner())
WITH CHECK (public.is_current_user_platform_owner());

DROP POLICY IF EXISTS "Only platform owner can delete platform access" ON public.platform_access;
CREATE POLICY "Only platform owner can delete platform access"
ON public.platform_access
FOR DELETE
TO authenticated
USING (public.is_current_user_platform_owner());

-- ----------------------------------------------------------------------------
-- 8. Data Migration & Cleanup
--    RULE: Every UPDATE and DELETE must have a WHERE clause.
-- ----------------------------------------------------------------------------

-- Remove any non-owner rows currently in platform_access
DELETE FROM public.platform_access
WHERE user_id NOT IN (
  SELECT id FROM auth.users WHERE lower(email) = 'zentry385@gmail.com'
);

-- Seed owner if zentry385@gmail.com already exists in auth.users
INSERT INTO public.platform_access (user_id, role, granted_by, granted_at)
SELECT id, 'owner', id, now()
FROM auth.users
WHERE lower(email) = 'zentry385@gmail.com'
ON CONFLICT (user_id) DO UPDATE SET role = 'owner';

-- Revoke super admin and platform owner status from ALL other accounts in agents
UPDATE public.agents
SET is_super_admin = false,
    is_platform_owner = false,
    platform_staff_role = NULL
WHERE lower(coalesce(email, '')) <> 'zentry385@gmail.com';

-- Ensure zentry385@gmail.com has owner flags set in agents if present
UPDATE public.agents
SET is_super_admin = true,
    is_platform_owner = true,
    platform_staff_role = 'owner'
WHERE lower(email) = 'zentry385@gmail.com';

-- Clear pending invitations from legacy table
DELETE FROM public.platform_super_admin_invitations
WHERE id IS NOT NULL;

-- Lock platform settings maintenance bypass only to zentry385@gmail.com
UPDATE public.platform_settings
SET maintenance_bypass_emails = '["zentry385@gmail.com"]'::jsonb
WHERE id IS NOT NULL;
