-- ============================================================================
-- Migration: 20261026090000_workspace_admin_control_center.sql
-- Description: Adds workspace setting locks, extended workspace control columns,
--              platform global defaults, and lock enforcement triggers.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Create workspace_setting_locks table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_setting_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  is_locked BOOLEAN NOT NULL DEFAULT true,
  locked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_workspace_setting_locks UNIQUE (workspace_id, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_setting_locks_ws_key
ON public.workspace_setting_locks (workspace_id, setting_key);

-- RLS for workspace_setting_locks
ALTER TABLE public.workspace_setting_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members can view setting locks" ON public.workspace_setting_locks;
CREATE POLICY "Workspace members can view setting locks"
ON public.workspace_setting_locks
FOR SELECT
TO authenticated
USING (
  public.fn_is_workspace_member(workspace_id)
  OR public.is_current_user_super_admin()
);

DROP POLICY IF EXISTS "Platform super admins can insert setting locks" ON public.workspace_setting_locks;
CREATE POLICY "Platform super admins can insert setting locks"
ON public.workspace_setting_locks
FOR INSERT
TO authenticated
WITH CHECK (public.is_current_user_super_admin());

DROP POLICY IF EXISTS "Platform super admins can update setting locks" ON public.workspace_setting_locks;
CREATE POLICY "Platform super admins can update setting locks"
ON public.workspace_setting_locks
FOR UPDATE
TO authenticated
USING (public.is_current_user_super_admin())
WITH CHECK (public.is_current_user_super_admin());

DROP POLICY IF EXISTS "Platform super admins can delete setting locks" ON public.workspace_setting_locks;
CREATE POLICY "Platform super admins can delete setting locks"
ON public.workspace_setting_locks
FOR DELETE
TO authenticated
USING (public.is_current_user_super_admin());

-- ----------------------------------------------------------------------------
-- 2. Add extended control columns to workspaces table
-- ----------------------------------------------------------------------------
ALTER TABLE public.workspaces
ADD COLUMN IF NOT EXISTS widget_disabled BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS force_powered_by TEXT NOT NULL DEFAULT 'inherited'
  CHECK (force_powered_by IN ('inherited', 'force_on', 'force_off')),
ADD COLUMN IF NOT EXISTS help_center_enabled BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS require_2fa BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS data_retention_days INTEGER DEFAULT NULL,
ADD COLUMN IF NOT EXISTS ai_monthly_reply_cap INTEGER DEFAULT NULL,
ADD COLUMN IF NOT EXISTS ai_monthly_cost_cap_usd NUMERIC(10,2) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS channel_disabled_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ----------------------------------------------------------------------------
-- 3. Add global defaults columns to platform_settings table
-- ----------------------------------------------------------------------------
ALTER TABLE public.platform_settings
ADD COLUMN IF NOT EXISTS default_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS default_features JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS default_ai_settings JSONB NOT NULL DEFAULT '{"enabled": true, "model": "claude-3-5-sonnet", "monthly_token_cap": 500000, "monthly_reply_cap": 1000, "monthly_cost_cap_usd": 50.0}'::jsonb,
ADD COLUMN IF NOT EXISTS default_allowed_channels TEXT[] NOT NULL DEFAULT ARRAY['email', 'whatsapp', 'instagram', 'x', 'threads', 'linkedin', 'tiktok']::text[],
ADD COLUMN IF NOT EXISTS default_require_2fa BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS default_data_retention_days INTEGER DEFAULT NULL,
ADD COLUMN IF NOT EXISTS default_widget_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Ensure default row exists
INSERT INTO public.platform_settings (id, default_plan_slug, default_trial_days, signup_mode)
VALUES ('default', 'starter', 14, 'open')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. Helper Function: fn_is_setting_locked
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_is_setting_locked(
  p_workspace_id UUID,
  p_setting_key TEXT
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_setting_locks
    WHERE workspace_id = p_workspace_id
      AND setting_key = p_setting_key
      AND is_locked = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.fn_is_setting_locked(UUID, TEXT) TO authenticated, anon;

-- ----------------------------------------------------------------------------
-- 5. Trigger: Enforce workspace setting locks against direct tenant updates
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_guard_locked_workspace_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If write is coming from service role (auth.uid() is null) or super admin, allow it
  IF auth.uid() IS NULL OR public.is_current_user_super_admin() THEN
    RETURN NEW;
  END IF;

  -- Check widget appearance / branding lock
  IF (NEW.brand_color IS DISTINCT FROM OLD.brand_color
      OR NEW.logo_url IS DISTINCT FROM OLD.logo_url
      OR NEW.widget_position IS DISTINCT FROM OLD.widget_position
      OR NEW.greeting_title IS DISTINCT FROM OLD.greeting_title
      OR NEW.greeting_message IS DISTINCT FROM OLD.greeting_message
      OR NEW.navbar_trigger_config IS DISTINCT FROM OLD.navbar_trigger_config)
     AND public.fn_is_setting_locked(OLD.id, 'widget_appearance') THEN
    RAISE EXCEPTION 'Setting "widget_appearance" is locked by Zentry platform administration.';
  END IF;

  -- Check business hours lock
  IF (NEW.business_hours IS DISTINCT FROM OLD.business_hours)
     AND public.fn_is_setting_locked(OLD.id, 'business_hours') THEN
    RAISE EXCEPTION 'Setting "business_hours" is locked by Zentry platform administration.';
  END IF;

  -- Check auto assignment lock
  IF (NEW.auto_assignment IS DISTINCT FROM OLD.auto_assignment)
     AND public.fn_is_setting_locked(OLD.id, 'auto_assignment') THEN
    RAISE EXCEPTION 'Setting "auto_assignment" is locked by Zentry platform administration.';
  END IF;

  -- Check AI settings lock
  IF (NEW.ai_settings IS DISTINCT FROM OLD.ai_settings)
     AND public.fn_is_setting_locked(OLD.id, 'ai_settings') THEN
    RAISE EXCEPTION 'Setting "ai_settings" is locked by Zentry platform administration.';
  END IF;

  -- Check CSAT lock
  IF (NEW.csat_enabled IS DISTINCT FROM OLD.csat_enabled)
     AND public.fn_is_setting_locked(OLD.id, 'csat') THEN
    RAISE EXCEPTION 'Setting "csat" is locked by Zentry platform administration.';
  END IF;

  -- Check SMTP lock
  IF (NEW.smtp_settings IS DISTINCT FROM OLD.smtp_settings)
     AND public.fn_is_setting_locked(OLD.id, 'smtp_settings') THEN
    RAISE EXCEPTION 'Setting "smtp_settings" is locked by Zentry platform administration.';
  END IF;

  -- Check help center branding & domain lock
  IF (NEW.help_center_title IS DISTINCT FROM OLD.help_center_title
      OR NEW.help_center_branding IS DISTINCT FROM OLD.help_center_branding
      OR NEW.help_center_enabled IS DISTINCT FROM OLD.help_center_enabled
      OR NEW.slug IS DISTINCT FROM OLD.slug
      OR NEW.custom_domain IS DISTINCT FROM OLD.custom_domain)
     AND public.fn_is_setting_locked(OLD.id, 'help_center') THEN
    RAISE EXCEPTION 'Setting "help_center" is locked by Zentry platform administration.';
  END IF;

  -- Check security policy lock (2FA, retention)
  IF (NEW.require_2fa IS DISTINCT FROM OLD.require_2fa
      OR NEW.data_retention_days IS DISTINCT FROM OLD.data_retention_days)
     AND public.fn_is_setting_locked(OLD.id, 'security') THEN
    RAISE EXCEPTION 'Setting "security" is locked by Zentry platform administration.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_locked_workspace_settings ON public.workspaces;
CREATE TRIGGER trg_guard_locked_workspace_settings
BEFORE UPDATE ON public.workspaces
FOR EACH ROW
EXECUTE FUNCTION public.fn_guard_locked_workspace_settings();
