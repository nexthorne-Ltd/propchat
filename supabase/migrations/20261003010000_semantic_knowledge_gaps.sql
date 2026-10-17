-- ============================================================================
-- Semantic Knowledge Gaps: Group near-duplicate unanswered questions with pgvector
-- ============================================================================

ALTER TABLE public.unanswered_questions ADD COLUMN IF NOT EXISTS embedding vector(768);

CREATE INDEX IF NOT EXISTS unanswered_questions_embedding_idx
  ON public.unanswered_questions USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION public.fn_record_unanswered_question_semantic(
  p_workspace_id UUID,
  p_question TEXT,
  p_embedding vector(768) DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_conversation_id UUID DEFAULT NULL,
  p_similarity_threshold FLOAT DEFAULT 0.82
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

  IF length(v_norm) < 6 THEN
    RETURN NULL;
  END IF;

  -- 1. Try semantic matching against open unanswered questions in the same workspace
  IF p_embedding IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM public.unanswered_questions
    WHERE workspace_id = p_workspace_id
      AND status = 'open'
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> p_embedding) >= p_similarity_threshold
    ORDER BY 1 - (embedding <=> p_embedding) DESC
    LIMIT 1;
  END IF;

  -- 2. Fallback to exact normalized match if no semantic match was found
  IF v_existing_id IS NULL THEN
    SELECT id INTO v_existing_id
    FROM public.unanswered_questions
    WHERE workspace_id = p_workspace_id
      AND normalized = v_norm
    LIMIT 1;
  END IF;

  -- 3. If an existing near-duplicate or exact gap was found, increment and update
  IF v_existing_id IS NOT NULL THEN
    UPDATE public.unanswered_questions
    SET times_asked = times_asked + 1,
        last_asked_at = NOW(),
        reason = COALESCE(p_reason, reason),
        last_conversation_id = COALESCE(p_conversation_id, last_conversation_id),
        status = CASE WHEN status = 'ignored' THEN 'ignored' ELSE 'open' END,
        embedding = COALESCE(embedding, p_embedding)
    WHERE id = v_existing_id;
    RETURN v_existing_id;
  END IF;

  -- 4. Otherwise, insert new gap
  INSERT INTO public.unanswered_questions (
    workspace_id,
    question,
    normalized,
    reason,
    last_conversation_id,
    embedding,
    status
  ) VALUES (
    p_workspace_id,
    p_question,
    v_norm,
    p_reason,
    p_conversation_id,
    p_embedding,
    'open'
  ) RETURNING id INTO v_existing_id;

  RETURN v_existing_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_record_unanswered_question_semantic(UUID, TEXT, vector, TEXT, UUID, FLOAT)
  TO anon, authenticated, service_role;
