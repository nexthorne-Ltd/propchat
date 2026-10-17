-- ============================================================================
-- Migration: 20260925120000_fix_workspace_creation_rls.sql
-- Description: Fix RLS policies on workspaces table during creation and returning.
--
-- Root Cause:
-- When an authenticated user creates a workspace via .insert().select().single(),
-- Postgres evaluates the SELECT policy on the newly inserted row for the RETURNING clause.
-- Previously, the SELECT policy only checked `fn_is_workspace_member(id)`.
-- Because `fn_is_workspace_member` is a STABLE function querying the workspaces/agents
-- tables, PostgreSQL's command snapshot did not yet see the uncommitted row or linked agent,
-- causing fn_is_workspace_member(id) to return false and throwing:
-- "new row violates row-level security policy for table 'workspaces'".
--
-- Solution:
-- Update SELECT and UPDATE policies to directly check `owner_id = auth.uid()`
-- on the in-flight row before falling back to fn_is_workspace_member / fn_is_workspace_admin.
-- This ensures INSERT ... RETURNING * succeeds smoothly for the workspace owner.
-- ============================================================================

DROP POLICY IF EXISTS "Workspace members can view full workspace" ON public.workspaces;

CREATE POLICY "Workspace members can view full workspace"
  ON public.workspaces
  FOR SELECT
  TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.fn_is_workspace_member(id)
  );

DROP POLICY IF EXISTS "Workspace owners can update workspaces" ON public.workspaces;

CREATE POLICY "Workspace owners can update workspaces"
  ON public.workspaces
  FOR UPDATE
  TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.fn_is_workspace_admin(id)
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR public.fn_is_workspace_admin(id)
  );
