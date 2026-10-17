-- ============================================================================
-- Clear domain statuses that describe a domain nobody set
--
-- Onboarding wrote `custom_domain_status = 'pending'` unconditionally, even
-- when the workspace had no website URL and therefore no custom domain. Those
-- workspaces show "verification pending" in Settings for a domain that does
-- not exist, and there is no way to clear it from the UI because the domain
-- field is empty.
--
-- Onboarding no longer does this; the status and the token are only written
-- alongside an actual domain. This tidies up the rows created before that.
-- ============================================================================

UPDATE public.workspaces
   SET custom_domain_status = NULL,
       custom_domain_verified_at = NULL,
       custom_domain_verification_token = NULL
 WHERE custom_domain IS NULL
   AND custom_domain_status IS NOT NULL;
