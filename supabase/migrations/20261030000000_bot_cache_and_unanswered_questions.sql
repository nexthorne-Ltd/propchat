-- ============================================================================
-- Migration: 20261030000000_bot_cache_and_unanswered_questions.sql
-- Description:
-- 1. Answer cache with semantic matching and automatic article invalidation
-- 2. Extended unanswered_questions table, status checks, and semantic deduplication
-- 3. Conversation running summary and failure counters
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Per-Workspace Bot Answer Cache
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.bot_answer_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  question_embedding vector(768),
  answer_text TEXT NOT NULL,
  source_article_ids UUID[] NOT NULL DEFAULT '{}',
  citation JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS idx_bot_answer_cache_lookup
  ON public.bot_answer_cache(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_answer_cache_sources
  ON public.bot_answer_cache USING gin(source_article_ids);

CREATE INDEX IF NOT EXISTS idx_bot_answer_cache_embedding
  ON public.bot_answer_cache USING hnsw (question_embedding vector_cosine_ops);

ALTER TABLE public.bot_answer_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members can read own answer cache" ON public.bot_answer_cache;
CREATE POLICY "Workspace members can read own answer cache"
  ON public.bot_answer_cache
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.agents
      WHERE agents.workspace_id = bot_answer_cache.workspace_id
        AND agents.id = auth.uid()
    ) OR EXISTS (
      SELECT 1 FROM public.workspaces
      WHERE workspaces.id = bot_answer_cache.workspace_id
        AND workspaces.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Workspace members can manage own answer cache" ON public.bot_answer_cache;
CREATE POLICY "Workspace members can manage own answer cache"
  ON public.bot_answer_cache
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.agents
      WHERE agents.workspace_id = bot_answer_cache.workspace_id
        AND agents.id = auth.uid()
    ) OR EXISTS (
      SELECT 1 FROM public.workspaces
      WHERE workspaces.id = bot_answer_cache.workspace_id
        AND workspaces.owner_id = auth.uid()
    )
  );

-- Trigger: Invalidate cache entries when source articles change or are deleted
CREATE OR REPLACE FUNCTION public.trg_fn_invalidate_bot_cache_on_article_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.bot_answer_cache
  WHERE workspace_id = OLD.workspace_id
    AND OLD.id = ANY(source_article_ids);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_invalidate_bot_cache ON public.articles;
CREATE TRIGGER trg_invalidate_bot_cache
  AFTER UPDATE OR DELETE ON public.articles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_invalidate_bot_cache_on_article_change();

-- Lookup RPC with threshold and freshness validation
CREATE OR REPLACE FUNCTION public.fn_lookup_bot_answer_cache(
  p_workspace_id UUID,
  p_embedding vector(768),
  p_similarity_threshold FLOAT DEFAULT 0.90
)
RETURNS TABLE (
  id UUID,
  answer_text TEXT,
  source_article_ids UUID[],
  citation JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.answer_text,
    c.source_article_ids,
    c.citation,
    (1 - (c.question_embedding <=> p_embedding))::FLOAT AS similarity
  FROM public.bot_answer_cache c
  WHERE c.workspace_id = p_workspace_id
    AND c.question_embedding IS NOT NULL
    AND c.expires_at > NOW()
    AND 1 - (c.question_embedding <=> p_embedding) >= p_similarity_threshold
  ORDER BY (c.question_embedding <=> p_embedding) ASC
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_lookup_bot_answer_cache(UUID, vector, FLOAT)
  TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Extended Unanswered Questions Table
-- ----------------------------------------------------------------------------

ALTER TABLE public.unanswered_questions
  ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_answer TEXT DEFAULT NULL;

-- Update status check constraint to include 'dismissed' and 'pending_approval'
ALTER TABLE public.unanswered_questions DROP CONSTRAINT IF EXISTS unanswered_questions_status_check;
ALTER TABLE public.unanswered_questions
  ADD CONSTRAINT unanswered_questions_status_check
  CHECK (status IN ('open', 'answered', 'dismissed', 'ignored', 'pending_approval'));

-- Backfill conversation_id and created_at if null
UPDATE public.unanswered_questions
SET conversation_id = last_conversation_id
WHERE conversation_id IS NULL AND last_conversation_id IS NOT NULL;

UPDATE public.unanswered_questions
SET created_at = first_asked_at
WHERE created_at IS NULL AND first_asked_at IS NOT NULL;

-- Semantic deduplication and increment function
CREATE OR REPLACE FUNCTION public.fn_record_or_increment_unanswered_question(
  p_workspace_id UUID,
  p_question TEXT,
  p_conversation_id UUID DEFAULT NULL,
  p_embedding vector(768) DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_similarity_threshold FLOAT DEFAULT 0.88
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm TEXT;
  v_existing_id UUID;
BEGIN
  v_norm := btrim(regexp_replace(lower(coalesce(p_question, '')), '[^a-z0-9 ]+', ' ', 'g'));
  v_norm := regexp_replace(v_norm, '\s+', ' ', 'g');

  IF length(v_norm) < 4 THEN
    RETURN NULL;
  END IF;

  -- 1. Semantic match if embedding provided
  IF p_embedding IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM public.unanswered_questions
    WHERE workspace_id = p_workspace_id
      AND status IN ('open', 'pending_approval')
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> p_embedding) >= p_similarity_threshold
    ORDER BY 1 - (embedding <=> p_embedding) DESC
    LIMIT 1;
  END IF;

  -- 2. Fallback to exact normalized text
  IF v_existing_id IS NULL THEN
    SELECT id INTO v_existing_id
    FROM public.unanswered_questions
    WHERE workspace_id = p_workspace_id
      AND normalized = v_norm
    LIMIT 1;
  END IF;

  -- 3. If found, increment times_asked
  IF v_existing_id IS NOT NULL THEN
    UPDATE public.unanswered_questions
    SET times_asked = times_asked + 1,
        last_asked_at = NOW(),
        last_conversation_id = COALESCE(p_conversation_id, last_conversation_id),
        conversation_id = COALESCE(p_conversation_id, conversation_id),
        reason = COALESCE(p_reason, reason),
        embedding = COALESCE(embedding, p_embedding),
        status = CASE WHEN status = 'dismissed' OR status = 'ignored' THEN status ELSE 'open' END
    WHERE id = v_existing_id;
    RETURN v_existing_id;
  END IF;

  -- 4. Insert new row
  INSERT INTO public.unanswered_questions (
    workspace_id,
    question,
    normalized,
    reason,
    conversation_id,
    last_conversation_id,
    embedding,
    status,
    times_asked,
    created_at,
    first_asked_at,
    last_asked_at
  ) VALUES (
    p_workspace_id,
    p_question,
    v_norm,
    p_reason,
    p_conversation_id,
    p_conversation_id,
    p_embedding,
    'open',
    1,
    NOW(),
    NOW(),
    NOW()
  ) RETURNING id INTO v_existing_id;

  RETURN v_existing_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_record_or_increment_unanswered_question(UUID, TEXT, UUID, vector, TEXT, FLOAT)
  TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Conversation Running Summary & Failure Tracking
-- ----------------------------------------------------------------------------

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS running_summary TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS bot_failure_count INTEGER DEFAULT 0;
