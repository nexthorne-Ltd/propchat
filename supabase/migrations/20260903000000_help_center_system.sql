-- ============================================================================
-- Migration: 20260903000000_help_center_system.sql
-- Description: Intercom-Style Help Desk & Knowledge Base System Schema
-- Tables:
--   1. help_sections (categories/collections)
--   2. articles (enhanced with sections, slug, status, metrics, author)
--   3. article_feedback (visitor helpfulness votes & ratings)
-- RPC Functions:
--   1. fn_track_article_view
--   2. fn_submit_article_feedback
-- ============================================================================

-- Ensure pgcrypto extension is available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. HELP_SECTIONS TABLE
-- Groups articles into collections/categories (e.g. "Getting Started", "Billing")
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.help_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT NOT NULL DEFAULT '📚',
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_help_sections_workspace_id ON public.help_sections(workspace_id);

-- Enable RLS on help_sections
ALTER TABLE public.help_sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read help sections" ON public.help_sections;
CREATE POLICY "Public can read help sections"
  ON public.help_sections FOR SELECT
  TO public
  USING (true);

DROP POLICY IF EXISTS "Authenticated can insert help sections" ON public.help_sections;
CREATE POLICY "Authenticated can insert help sections"
  ON public.help_sections FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated can update help sections" ON public.help_sections;
CREATE POLICY "Authenticated can update help sections"
  ON public.help_sections FOR UPDATE
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated can delete help sections" ON public.help_sections;
CREATE POLICY "Authenticated can delete help sections"
  ON public.help_sections FOR DELETE
  TO authenticated
  USING (true);

-- ----------------------------------------------------------------------------
-- 2. ENHANCE ARTICLES TABLE
-- ----------------------------------------------------------------------------
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'articles' AND column_name = 'section_id') THEN
    ALTER TABLE public.articles ADD COLUMN section_id UUID REFERENCES public.help_sections(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'articles' AND column_name = 'slug') THEN
    ALTER TABLE public.articles ADD COLUMN slug TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'articles' AND column_name = 'status') THEN
    ALTER TABLE public.articles ADD COLUMN status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'articles' AND column_name = 'author_id') THEN
    ALTER TABLE public.articles ADD COLUMN author_id UUID REFERENCES public.agents(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'articles' AND column_name = 'views_count') THEN
    ALTER TABLE public.articles ADD COLUMN views_count INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'articles' AND column_name = 'helpful_count') THEN
    ALTER TABLE public.articles ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'articles' AND column_name = 'not_helpful_count') THEN
    ALTER TABLE public.articles ADD COLUMN not_helpful_count INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'articles' AND column_name = 'updated_at') THEN
    ALTER TABLE public.articles ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_articles_workspace_section ON public.articles(workspace_id, section_id);
CREATE INDEX IF NOT EXISTS idx_articles_status ON public.articles(status);

-- ----------------------------------------------------------------------------
-- 3. ARTICLE_FEEDBACK TABLE
-- Captures user ratings (thumbs up/down) and qualitative feedback
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.article_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL REFERENCES public.articles(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  visitor_id TEXT,
  is_helpful BOOLEAN NOT NULL,
  feedback_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_article_feedback_article ON public.article_feedback(article_id);

ALTER TABLE public.article_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can insert feedback" ON public.article_feedback;
CREATE POLICY "Public can insert feedback"
  ON public.article_feedback FOR INSERT
  TO public
  WITH CHECK (true);

DROP POLICY IF EXISTS "Public can read feedback" ON public.article_feedback;
CREATE POLICY "Public can read feedback"
  ON public.article_feedback FOR SELECT
  TO public
  USING (true);

-- ----------------------------------------------------------------------------
-- 4. RPC FUNCTIONS FOR VIEW TRACKING & FEEDBACK
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_track_article_view(p_article_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.articles
  SET views_count = COALESCE(views_count, 0) + 1
  WHERE id = p_article_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.fn_submit_article_feedback(
  p_article_id UUID,
  p_workspace_id UUID,
  p_visitor_id TEXT,
  p_is_helpful BOOLEAN,
  p_feedback_text TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO public.article_feedback (article_id, workspace_id, visitor_id, is_helpful, feedback_text)
  VALUES (p_article_id, p_workspace_id, p_visitor_id, p_is_helpful, p_feedback_text);

  IF p_is_helpful THEN
    UPDATE public.articles SET helpful_count = COALESCE(helpful_count, 0) + 1 WHERE id = p_article_id;
  ELSE
    UPDATE public.articles SET not_helpful_count = COALESCE(not_helpful_count, 0) + 1 WHERE id = p_article_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
