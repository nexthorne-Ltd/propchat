-- 20261029090000_super_admin_invites.sql
-- Table `admin_invites`: id, email, role, token_hash, status (pending / accepted / revoked / expired), invited_by, expires_at, accepted_at, created_at.
-- Enables owner to invite platform admins/owners before they register an account.

CREATE TABLE IF NOT EXISTS public.admin_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '48 hours'),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexing for lookup performance
CREATE INDEX IF NOT EXISTS idx_admin_invites_token_hash ON public.admin_invites (token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_invites_email ON public.admin_invites (lower(email));
CREATE INDEX IF NOT EXISTS idx_admin_invites_status ON public.admin_invites (status);

-- Enable RLS
ALTER TABLE public.admin_invites ENABLE ROW LEVEL SECURITY;

-- Security Policies:
-- Only the platform owner can view, insert, update, or delete admin invites.
DROP POLICY IF EXISTS "Platform owner can view admin invites" ON public.admin_invites;
CREATE POLICY "Platform owner can view admin invites"
  ON public.admin_invites
  FOR SELECT
  TO authenticated
  USING (public.is_current_user_platform_owner());

DROP POLICY IF EXISTS "Platform owner can insert admin invites" ON public.admin_invites;
CREATE POLICY "Platform owner can insert admin invites"
  ON public.admin_invites
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_current_user_platform_owner());

DROP POLICY IF EXISTS "Platform owner can update admin invites" ON public.admin_invites;
CREATE POLICY "Platform owner can update admin invites"
  ON public.admin_invites
  FOR UPDATE
  TO authenticated
  USING (public.is_current_user_platform_owner())
  WITH CHECK (public.is_current_user_platform_owner());

DROP POLICY IF EXISTS "Platform owner can delete admin invites" ON public.admin_invites;
CREATE POLICY "Platform owner can delete admin invites"
  ON public.admin_invites
  FOR DELETE
  TO authenticated
  USING (public.is_current_user_platform_owner());

-- Ensure platform_access has role column if missing (guard check)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'platform_access' AND column_name = 'role'
  ) THEN
    ALTER TABLE public.platform_access ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin'));
  END IF;
END $$;
