-- ============================================================================
-- Help center design (Settings → Help Center → Design)
--
-- Owners can now choose how their public help center looks: a preset, colours,
-- hero background, fonts, card shape, and which blocks show (popular articles,
-- contact card, table of contents, feedback, ...). The whole design is one
-- JSONB value, cleaned by the app before it is saved (src/lib/help/theme.ts).
--
-- The help center is public and reads workspaces through the
-- public_workspaces view. Rather than recreate that view (its live definition
-- predates the repo), the design is read through one narrow function that
-- returns only this column. It is not secret: it is how the public page looks.
--
-- Safe for the deployed app: a new column with a default and new functions;
-- nothing existing changes. Undo:
--   DROP FUNCTION IF EXISTS public.fn_help_center_theme(uuid);
--   DROP FUNCTION IF EXISTS public.fn_help_article_author(uuid);
--   ALTER TABLE public.workspaces DROP COLUMN IF EXISTS help_center_theme;
-- ============================================================================

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS help_center_theme JSONB NOT NULL DEFAULT '{}'::jsonb;

-- A design is a few dozen short fields; anything far larger is not one.
ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_help_center_theme_size;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_help_center_theme_size
  CHECK (jsonb_typeof(help_center_theme) = 'object' AND pg_column_size(help_center_theme) <= 32768);

-- Public read of one workspace's design. Deleted workspaces have no help
-- center, so they return nothing.
CREATE OR REPLACE FUNCTION public.fn_help_center_theme(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(w.help_center_theme, '{}'::jsonb)
  FROM public.workspaces w
  WHERE w.id = p_workspace_id
    AND (to_jsonb(w) ->> 'deleted_at') IS NULL;
$$;

REVOKE ALL ON FUNCTION public.fn_help_center_theme(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_help_center_theme(UUID) TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Article author on the public help center.
--
-- The article page joined agents for the author's name. Since the widget
-- lockdown (20261107090000) anon cannot read agents, so that join failed and
-- every public article showed "Article not found". The page no longer joins;
-- it asks this function for the one author of one published article: name and
-- avatar only, never email, role or status.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_help_article_author(p_article_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_author JSONB;
BEGIN
  SELECT jsonb_build_object('id', ag.id, 'name', ag.name, 'avatar_url', ag.avatar_url)
    INTO v_author
  FROM public.articles a
  JOIN public.agents ag ON ag.id = a.author_id AND ag.workspace_id = a.workspace_id
  WHERE a.id = p_article_id
    AND a.status = 'published';
  RETURN v_author;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_help_article_author(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_help_article_author(UUID) TO anon, authenticated, service_role;
