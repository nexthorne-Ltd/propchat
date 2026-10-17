-- ============================================================================
-- Migration: 20261022090000_platform_owner_super_admin_invitations.sql
-- Description: Platform Owner Super Admin Access Control & Invitation System
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Add is_platform_owner flag to agents table
-- ----------------------------------------------------------------------------
ALTER TABLE public.agents
ADD COLUMN IF NOT EXISTS is_platform_owner BOOLEAN NOT NULL DEFAULT FALSE;

-- Initialize existing designated platform owner accounts
UPDATE public.agents
SET is_platform_owner = TRUE, is_super_admin = TRUE
WHERE email IN (
  'musmanrai372@gmail.com',
  'raiusman37218@gmail.com',
  'agent@zentry.io'
);

-- ----------------------------------------------------------------------------
-- 2. Helper function: is_current_user_platform_owner()
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_current_user_platform_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT is_platform_owner FROM public.agents WHERE id = auth.uid() LIMIT 1),
    false
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. Platform Super Admin Invitations Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_super_admin_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invited_by_email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS idx_super_admin_invitations_token ON public.platform_super_admin_invitations(token);
CREATE INDEX IF NOT EXISTS idx_super_admin_invitations_email ON public.platform_super_admin_invitations(email);

ALTER TABLE public.platform_super_admin_invitations ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 4. RLS Policies for platform_super_admin_invitations
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Super admins can view invitations" ON public.platform_super_admin_invitations;
CREATE POLICY "Super admins can view invitations"
ON public.platform_super_admin_invitations
FOR SELECT
TO authenticated
USING (public.is_current_user_super_admin());

DROP POLICY IF EXISTS "Platform owners can manage invitations" ON public.platform_super_admin_invitations;
CREATE POLICY "Platform owners can manage invitations"
ON public.platform_super_admin_invitations
FOR ALL
TO authenticated
USING (public.is_current_user_platform_owner())
WITH CHECK (public.is_current_user_platform_owner());

-- ----------------------------------------------------------------------------
-- 5. RPC: fn_get_platform_super_admins()
-- Returns active super admins and pending invitations for the platform owner
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_get_platform_super_admins()
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
    RAISE EXCEPTION 'Access denied. Only platform super administrators can access this view.';
  END IF;

  WITH admins_list AS (
    SELECT
      id,
      name,
      email,
      role,
      status,
      is_active,
      is_super_admin,
      is_platform_owner,
      created_at
    FROM public.agents
    WHERE is_super_admin = TRUE
    ORDER BY created_at ASC
  ),
  invites_list AS (
    SELECT
      id,
      email,
      name,
      invited_by,
      invited_by_email,
      token,
      status,
      created_at,
      accepted_at,
      expires_at
    FROM public.platform_super_admin_invitations
    ORDER BY created_at DESC
  )
  SELECT jsonb_build_object(
    'admins', coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM admins_list a), '[]'::jsonb),
    'invitations', coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM invites_list i), '[]'::jsonb),
    'caller_is_owner', public.is_current_user_platform_owner()
  ) INTO v_result;

  RETURN v_result;
END;
$$;
