-- ============================================================================
-- Migration: 20261111090000_email_verifications_brute_force.sql
-- Description: Add attempts and locked_until to email_verifications for brute-force protection
-- ============================================================================

ALTER TABLE public.email_verifications
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
