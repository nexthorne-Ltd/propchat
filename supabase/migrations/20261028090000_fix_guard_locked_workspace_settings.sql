-- Fix fn_guard_locked_workspace_settings:
-- 1. Replace non-existent NEW.csat_enabled with NEW.csat_settings
-- 2. Replace non-existent NEW.help_center_branding with actual help center branding columns

CREATE OR REPLACE FUNCTION public.fn_guard_locked_workspace_settings()
RETURNS TRIGGER
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
  IF (NEW.csat_settings IS DISTINCT FROM OLD.csat_settings)
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
      OR NEW.help_center_subtitle IS DISTINCT FROM OLD.help_center_subtitle
      OR NEW.help_center_logo_url IS DISTINCT FROM OLD.help_center_logo_url
      OR NEW.help_center_header_links IS DISTINCT FROM OLD.help_center_header_links
      OR NEW.help_center_footer_text IS DISTINCT FROM OLD.help_center_footer_text
      OR NEW.help_center_layout IS DISTINCT FROM OLD.help_center_layout
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
