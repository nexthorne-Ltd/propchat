-- ============================================================================
-- Migration: 20260906140000_phase1_security_and_multitenancy.sql
-- Description: Phase 1: Critical Database Security + Multi-Tenancy Hardening
--   1. Helper security functions: fn_is_workspace_member, fn_is_workspace_admin
--   2. Schema fixes:
--      - articles.summary DROP NOT NULL, SET DEFAULT ''
--      - articles.workspace_id SET NOT NULL
--      - Unique constraint on articles (workspace_id, lower(slug))
--      - help_sections.slug column added, backfilled, and unique per workspace
--      - Help center branding fields on workspaces:
--        help_center_title, help_center_subtitle, help_center_logo_url,
--        help_center_header_links, help_center_footer_text
--   3. Safe public access:
--      - public_workspaces view exposing only non-sensitive branding columns
--      - fn_get_public_workspace RPC
--   4. RLS Overhaul:
--      - articles: strict workspace isolation for mutations, public SELECT published only
--      - help_sections: strict workspace isolation for mutations
--      - workspaces: full row restricted to members only, public uses view/RPC
--      - article_feedback: reads restricted to workspace members, public can insert
-- ============================================================================

-- Ensure pgcrypto extension is available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. SECURITY FUNCTIONS
-- ----------------------------------------------------------------------------

-- Check if authenticated user belongs to workspace as agent or owner
CREATE OR REPLACE FUNCTION public.fn_is_workspace_member(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agents
    WHERE id = auth.uid()
      AND workspace_id = p_workspace_id
  ) OR EXISTS (
    SELECT 1 FROM public.workspaces
    WHERE id = p_workspace_id
      AND owner_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.fn_is_workspace_member(UUID) TO authenticated, anon, service_role;

-- Check if authenticated user is admin or owner of the workspace
CREATE OR REPLACE FUNCTION public.fn_is_workspace_admin(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agents
    WHERE id = auth.uid()
      AND workspace_id = p_workspace_id
      AND role IN ('admin', 'owner')
  ) OR EXISTS (
    SELECT 1 FROM public.workspaces
    WHERE id = p_workspace_id
      AND owner_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.fn_is_workspace_admin(UUID) TO authenticated, anon, service_role;

-- ----------------------------------------------------------------------------
-- 2. SCHEMA CORRECTIONS: ARTICLES
-- ----------------------------------------------------------------------------

-- 2a. Summary optional in DB to match UI
ALTER TABLE public.articles ALTER COLUMN summary DROP NOT NULL;
ALTER TABLE public.articles ALTER COLUMN summary SET DEFAULT '';

-- 2b. Ensure no orphan articles with null workspace_id
UPDATE public.articles
   SET workspace_id = 'a0000000-0000-0000-0000-000000000001'
 WHERE workspace_id IS NULL;

ALTER TABLE public.articles ALTER COLUMN workspace_id SET NOT NULL;

-- 2c. Backfill slug if missing
DO $$
DECLARE
  r RECORD;
  base_slug TEXT;
  candidate_slug TEXT;
  i INT;
BEGIN
  FOR r IN SELECT id, workspace_id, title, slug FROM public.articles WHERE slug IS NULL OR trim(slug) = '' LOOP
    base_slug := lower(regexp_replace(coalesce(r.title, 'article'), '[^a-zA-Z0-9]+', '-', 'g'));
    base_slug := trim(both '-' from base_slug);
    IF base_slug = '' THEN
      base_slug := 'article';
    END IF;

    candidate_slug := base_slug;
    i := 1;
    WHILE EXISTS (
      SELECT 1 FROM public.articles
       WHERE workspace_id = r.workspace_id
         AND lower(slug) = candidate_slug
         AND id <> r.id
    ) LOOP
      candidate_slug := base_slug || '-' || i;
      i := i + 1;
    END LOOP;

    UPDATE public.articles SET slug = candidate_slug WHERE id = r.id;
  END LOOP;
END $$;

-- 2d. Resolve any duplicate slugs per workspace
DO $$
DECLARE
  r RECORD;
  base_slug TEXT;
  new_slug TEXT;
  i INT;
BEGIN
  FOR r IN (
    SELECT id, workspace_id, slug,
           row_number() OVER (PARTITION BY workspace_id, lower(slug) ORDER BY created_at, id) as rn
      FROM public.articles
     WHERE slug IS NOT NULL
  ) LOOP
    IF r.rn > 1 THEN
      base_slug := lower(r.slug);
      i := r.rn - 1;
      new_slug := base_slug || '-' || i;
      WHILE EXISTS (
        SELECT 1 FROM public.articles
         WHERE workspace_id = r.workspace_id
           AND lower(slug) = new_slug
           AND id <> r.id
      ) LOOP
        i := i + 1;
        new_slug := base_slug || '-' || i;
      END LOOP;

      UPDATE public.articles SET slug = new_slug WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_workspace_slug
  ON public.articles (workspace_id, lower(slug));

-- ----------------------------------------------------------------------------
-- 3. SCHEMA CORRECTIONS: HELP_SECTIONS
-- ----------------------------------------------------------------------------

ALTER TABLE public.help_sections ADD COLUMN IF NOT EXISTS slug TEXT;

-- Backfill section slugs from name
DO $$
DECLARE
  r RECORD;
  base_slug TEXT;
  candidate_slug TEXT;
  i INT;
BEGIN
  FOR r IN SELECT id, workspace_id, name, slug FROM public.help_sections WHERE slug IS NULL OR trim(slug) = '' LOOP
    base_slug := lower(regexp_replace(coalesce(r.name, 'section'), '[^a-zA-Z0-9]+', '-', 'g'));
    base_slug := trim(both '-' from base_slug);
    IF base_slug = '' THEN
      base_slug := 'section';
    END IF;

    candidate_slug := base_slug;
    i := 1;
    WHILE EXISTS (
      SELECT 1 FROM public.help_sections
       WHERE workspace_id = r.workspace_id
         AND lower(slug) = candidate_slug
         AND id <> r.id
    ) LOOP
      candidate_slug := base_slug || '-' || i;
      i := i + 1;
    END LOOP;

    UPDATE public.help_sections SET slug = candidate_slug WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE public.help_sections ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_help_sections_workspace_slug
  ON public.help_sections (workspace_id, lower(slug));

-- ----------------------------------------------------------------------------
-- 4. HELP CENTER BRANDING FIELDS ON WORKSPACES
-- ----------------------------------------------------------------------------

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS help_center_title TEXT,
  ADD COLUMN IF NOT EXISTS help_center_subtitle TEXT,
  ADD COLUMN IF NOT EXISTS help_center_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS help_center_header_links JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS help_center_footer_text TEXT;

-- ----------------------------------------------------------------------------
-- 5. SAFE PUBLIC ACCESS PROJECTION & RPC (Shielding Secrets)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.public_workspaces
WITH (security_invoker = false) AS
SELECT
  id,
  name,
  website_url,
  brand_color,
  logo_url,
  widget_position,
  greeting_title,
  greeting_message,
  help_center_tab_label,
  show_help_tab,
  help_center_tab_icon,
  slug,
  custom_domain,
  custom_domain_status,
  help_center_title,
  help_center_subtitle,
  help_center_logo_url,
  help_center_header_links,
  help_center_footer_text,
  created_at
FROM public.workspaces;

GRANT SELECT ON public.public_workspaces TO public, authenticated, anon, service_role;

-- Safe RPC to lookup public workspace details by id, slug, or custom domain
CREATE OR REPLACE FUNCTION public.fn_get_public_workspace(p_identifier TEXT)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws RECORD;
  v_is_uuid BOOLEAN;
BEGIN
  IF p_identifier IS NULL OR trim(p_identifier) = '' THEN
    RETURN NULL;
  END IF;

  v_is_uuid := p_identifier ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  IF v_is_uuid THEN
    SELECT id, name, website_url, brand_color, logo_url, widget_position,
           greeting_title, greeting_message, help_center_tab_label, show_help_tab,
           help_center_tab_icon, slug, custom_domain, custom_domain_status,
           help_center_title, help_center_subtitle, help_center_logo_url,
           help_center_header_links, help_center_footer_text, created_at
      INTO v_ws
      FROM public.workspaces
     WHERE id = p_identifier::uuid;
  ELSE
    SELECT id, name, website_url, brand_color, logo_url, widget_position,
           greeting_title, greeting_message, help_center_tab_label, show_help_tab,
           help_center_tab_icon, slug, custom_domain, custom_domain_status,
           help_center_title, help_center_subtitle, help_center_logo_url,
           help_center_header_links, help_center_footer_text, created_at
      INTO v_ws
      FROM public.workspaces
     WHERE lower(slug) = lower(p_identifier)
        OR lower(custom_domain) = lower(p_identifier)
     LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', v_ws.id,
    'name', v_ws.name,
    'website_url', v_ws.website_url,
    'brand_color', v_ws.brand_color,
    'logo_url', v_ws.logo_url,
    'widget_position', coalesce(v_ws.widget_position, 'right'),
    'greeting_title', v_ws.greeting_title,
    'greeting_message', v_ws.greeting_message,
    'help_center_tab_label', coalesce(v_ws.help_center_tab_label, 'Help'),
    'show_help_tab', coalesce(v_ws.show_help_tab, true),
    'help_center_tab_icon', coalesce(v_ws.help_center_tab_icon, '📖'),
    'slug', v_ws.slug,
    'custom_domain', v_ws.custom_domain,
    'custom_domain_status', v_ws.custom_domain_status,
    'help_center_title', v_ws.help_center_title,
    'help_center_subtitle', v_ws.help_center_subtitle,
    'help_center_logo_url', v_ws.help_center_logo_url,
    'help_center_header_links', coalesce(v_ws.help_center_header_links, '[]'::jsonb),
    'help_center_footer_text', v_ws.help_center_footer_text,
    'created_at', v_ws.created_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_get_public_workspace(TEXT) TO public, authenticated, anon, service_role;

-- ----------------------------------------------------------------------------
-- 6. RLS OVERHAUL: WORKSPACES
-- ----------------------------------------------------------------------------
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anyone to read workspaces" ON public.workspaces;
DROP POLICY IF EXISTS "Allow authenticated users to create workspaces" ON public.workspaces;
DROP POLICY IF EXISTS "Allow owners to update their workspaces" ON public.workspaces;
DROP POLICY IF EXISTS "Workspace members can view full workspace" ON public.workspaces;
DROP POLICY IF EXISTS "Workspace owners can update workspaces" ON public.workspaces;
DROP POLICY IF EXISTS "Authenticated users can create workspaces" ON public.workspaces;

-- Authenticated members/owners can view their own full workspace row
CREATE POLICY "Workspace members can view full workspace"
  ON public.workspaces FOR SELECT
  TO authenticated
  USING (
    public.fn_is_workspace_member(id)
  );

-- Authenticated users can create new workspaces
CREATE POLICY "Authenticated users can create workspaces"
  ON public.workspaces FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL AND (owner_id = auth.uid())
  );

-- Admins / Owners can update their workspace
CREATE POLICY "Workspace owners can update workspaces"
  ON public.workspaces FOR UPDATE
  TO authenticated
  USING (
    public.fn_is_workspace_admin(id)
  )
  WITH CHECK (
    public.fn_is_workspace_admin(id)
  );

-- ----------------------------------------------------------------------------
-- 7. RLS OVERHAUL: ARTICLES
-- ----------------------------------------------------------------------------
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all delete articles" ON public.articles;
DROP POLICY IF EXISTS "Allow all insert articles" ON public.articles;
DROP POLICY IF EXISTS "Allow all read articles" ON public.articles;
DROP POLICY IF EXISTS "Allow all update articles" ON public.articles;
DROP POLICY IF EXISTS "Public can read published articles" ON public.articles;
DROP POLICY IF EXISTS "Workspace members can read all workspace articles" ON public.articles;
DROP POLICY IF EXISTS "Workspace members can insert articles" ON public.articles;
DROP POLICY IF EXISTS "Workspace members can update articles" ON public.articles;
DROP POLICY IF EXISTS "Workspace members can delete articles" ON public.articles;

-- 1. Public can ONLY read published articles
CREATE POLICY "Public can read published articles"
  ON public.articles FOR SELECT
  TO public
  USING (status = 'published');

-- 2. Workspace members can read ALL articles (drafts + published) in their workspace
CREATE POLICY "Workspace members can read all workspace articles"
  ON public.articles FOR SELECT
  TO authenticated
  USING (
    public.fn_is_workspace_member(workspace_id)
  );

-- 3. Workspace members can insert articles ONLY into their own workspace
CREATE POLICY "Workspace members can insert articles"
  ON public.articles FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IS NOT NULL AND
    public.fn_is_workspace_member(workspace_id)
  );

-- 4. Workspace members can update articles ONLY in their own workspace
CREATE POLICY "Workspace members can update articles"
  ON public.articles FOR UPDATE
  TO authenticated
  USING (
    public.fn_is_workspace_member(workspace_id)
  )
  WITH CHECK (
    workspace_id IS NOT NULL AND
    public.fn_is_workspace_member(workspace_id)
  );

-- 5. Workspace members can delete articles ONLY in their own workspace
CREATE POLICY "Workspace members can delete articles"
  ON public.articles FOR DELETE
  TO authenticated
  USING (
    public.fn_is_workspace_member(workspace_id)
  );

-- ----------------------------------------------------------------------------
-- 8. RLS OVERHAUL: HELP_SECTIONS
-- ----------------------------------------------------------------------------
ALTER TABLE public.help_sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read help sections" ON public.help_sections;
DROP POLICY IF EXISTS "Authenticated can insert help sections" ON public.help_sections;
DROP POLICY IF EXISTS "Authenticated can update help sections" ON public.help_sections;
DROP POLICY IF EXISTS "Authenticated can delete help sections" ON public.help_sections;
DROP POLICY IF EXISTS "Workspace members can insert help sections" ON public.help_sections;
DROP POLICY IF EXISTS "Workspace members can update help sections" ON public.help_sections;
DROP POLICY IF EXISTS "Workspace members can delete help sections" ON public.help_sections;

-- Public can read help sections (for Help Center navigation)
CREATE POLICY "Public can read help sections"
  ON public.help_sections FOR SELECT
  TO public
  USING (true);

-- Workspace members can insert sections ONLY into their workspace
CREATE POLICY "Workspace members can insert help sections"
  ON public.help_sections FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IS NOT NULL AND
    public.fn_is_workspace_member(workspace_id)
  );

-- Workspace members can update sections ONLY in their workspace
CREATE POLICY "Workspace members can update help sections"
  ON public.help_sections FOR UPDATE
  TO authenticated
  USING (
    public.fn_is_workspace_member(workspace_id)
  )
  WITH CHECK (
    workspace_id IS NOT NULL AND
    public.fn_is_workspace_member(workspace_id)
  );

-- Workspace members can delete sections ONLY in their workspace
CREATE POLICY "Workspace members can delete help sections"
  ON public.help_sections FOR DELETE
  TO authenticated
  USING (
    public.fn_is_workspace_member(workspace_id)
  );

-- ----------------------------------------------------------------------------
-- 9. RLS OVERHAUL: ARTICLE_FEEDBACK
-- ----------------------------------------------------------------------------
ALTER TABLE public.article_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can insert feedback" ON public.article_feedback;
DROP POLICY IF EXISTS "Public can read feedback" ON public.article_feedback;
DROP POLICY IF EXISTS "Public can insert article feedback" ON public.article_feedback;
DROP POLICY IF EXISTS "Workspace members can read article feedback" ON public.article_feedback;

-- Public can submit article feedback (thumbs up/down)
CREATE POLICY "Public can insert article feedback"
  ON public.article_feedback FOR INSERT
  TO public
  WITH CHECK (
    article_id IS NOT NULL AND workspace_id IS NOT NULL
  );

-- ONLY workspace members can read feedback for their workspace
CREATE POLICY "Workspace members can read article feedback"
  ON public.article_feedback FOR SELECT
  TO authenticated
  USING (
    public.fn_is_workspace_member(workspace_id)
  );
