-- Bot knowledge: material the bot answers from that is not a help-centre article.
--
-- The bot answered only from published articles. Teams have facts the bot
-- should know (price lists, delivery areas, plan details, longer policies) that
-- do not belong in the public help centre, and the only other place for them,
-- assistant notes, never reached the answer pipeline. Writing an article for
-- each of them published it to every visitor of the help centre.
--
-- bot_knowledge holds those entries; bot_knowledge_chunks holds their chunks
-- and embeddings for hybrid search. Nothing here is readable by anon: entries
-- are visible to workspace members, and chunks only to the service role. The
-- bot searches them through fn_hybrid_search_bot_knowledge, which only the
-- service role may call.
--
-- Embedding is a deliberate step ("Generate embeddings" in the Help Center),
-- so an entry the bot can use is one somebody chose to train it on. Editing an
-- entry's title or content puts it back to 'pending' and deletes its chunks in
-- the same statement, so the bot never answers from text that is no longer
-- there. Chunks are written only by fn_store_bot_knowledge_chunks, which
-- refuses when the entry changed after the caller read it (content_version),
-- so a slow embedding run cannot store an old version over a newer edit.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.bot_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  content TEXT NOT NULL CHECK (char_length(btrim(content)) BETWEEN 1 AND 100000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  content_version INT NOT NULL DEFAULT 1,
  chunk_count INT NOT NULL DEFAULT 0,
  embedded_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  embedded_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_knowledge_workspace
  ON public.bot_knowledge (workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.bot_knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  knowledge_id UUID NOT NULL REFERENCES public.bot_knowledge(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INT NOT NULL DEFAULT 0,
  embedding vector(768),
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || content)
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_bot_knowledge_chunk UNIQUE (knowledge_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_bot_knowledge_chunks_workspace ON public.bot_knowledge_chunks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_bot_knowledge_chunks_knowledge ON public.bot_knowledge_chunks (knowledge_id);
CREATE INDEX IF NOT EXISTS idx_bot_knowledge_chunks_embedding
  ON public.bot_knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_bot_knowledge_chunks_fts ON public.bot_knowledge_chunks USING gin (fts);

/* ── Access ─────────────────────────────────────────────────────────────── */

ALTER TABLE public.bot_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_knowledge_chunks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.bot_knowledge FROM anon;
-- No policy on the chunks: only the service role (which bypasses RLS) reads
-- or writes them.
REVOKE ALL ON public.bot_knowledge_chunks FROM anon, authenticated;

DROP POLICY IF EXISTS bot_knowledge_select ON public.bot_knowledge;
CREATE POLICY bot_knowledge_select ON public.bot_knowledge FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'view'));

DROP POLICY IF EXISTS bot_knowledge_insert ON public.bot_knowledge;
CREATE POLICY bot_knowledge_insert ON public.bot_knowledge FOR INSERT TO authenticated
  WITH CHECK (public.fn_role_can(workspace_id, 'edit_content'));

DROP POLICY IF EXISTS bot_knowledge_update ON public.bot_knowledge;
CREATE POLICY bot_knowledge_update ON public.bot_knowledge FOR UPDATE TO authenticated
  USING (public.fn_role_can(workspace_id, 'edit_content'))
  WITH CHECK (public.fn_role_can(workspace_id, 'edit_content'));

DROP POLICY IF EXISTS bot_knowledge_delete ON public.bot_knowledge;
CREATE POLICY bot_knowledge_delete ON public.bot_knowledge FOR DELETE TO authenticated
  USING (public.fn_role_can(workspace_id, 'edit_content'));

-- Same role rule as the other content tables, for writers that bypass RLS.
DROP TRIGGER IF EXISTS trg_guard_content_write ON public.bot_knowledge;
CREATE TRIGGER trg_guard_content_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.bot_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_content_write('edit_content');

/* ── Bookkeeping ────────────────────────────────────────────────────────── */

-- A person edits the title and content only. The embedding state is the
-- embedding run's to set, so a user cannot mark an entry 'ready' that was
-- never embedded, and any change to the text resets it.
CREATE OR REPLACE FUNCTION public.fn_bot_knowledge_bookkeeping()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'pending';
    NEW.content_version := 1;
    NEW.chunk_count := 0;
    NEW.embedded_count := 0;
    NEW.last_error := NULL;
    NEW.embedded_at := NULL;
    NEW.created_at := now();
    NEW.updated_at := now();
    IF public.fn_is_direct_user_write() THEN
      NEW.created_by := auth.uid();
      NEW.updated_by := auth.uid();
    END IF;
    RETURN NEW;
  END IF;

  NEW.workspace_id := OLD.workspace_id;
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;

  IF public.fn_is_direct_user_write() THEN
    NEW.status := OLD.status;
    NEW.content_version := OLD.content_version;
    NEW.chunk_count := OLD.chunk_count;
    NEW.embedded_count := OLD.embedded_count;
    NEW.last_error := OLD.last_error;
    NEW.embedded_at := OLD.embedded_at;
    NEW.updated_by := auth.uid();
  END IF;

  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.content IS DISTINCT FROM OLD.content THEN
    NEW.content_version := OLD.content_version + 1;
    NEW.status := 'pending';
    NEW.chunk_count := 0;
    NEW.embedded_count := 0;
    NEW.last_error := NULL;
    NEW.embedded_at := NULL;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bot_knowledge_bookkeeping ON public.bot_knowledge;
CREATE TRIGGER trg_bot_knowledge_bookkeeping
  BEFORE INSERT OR UPDATE ON public.bot_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.fn_bot_knowledge_bookkeeping();

-- Definer rights: the user who edited the entry cannot touch chunks directly.
CREATE OR REPLACE FUNCTION public.fn_bot_knowledge_drop_stale_chunks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.content_version <> OLD.content_version THEN
    DELETE FROM public.bot_knowledge_chunks WHERE knowledge_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_bot_knowledge_drop_stale_chunks ON public.bot_knowledge;
CREATE TRIGGER trg_bot_knowledge_drop_stale_chunks
  AFTER UPDATE ON public.bot_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.fn_bot_knowledge_drop_stale_chunks();

REVOKE EXECUTE ON FUNCTION public.fn_bot_knowledge_drop_stale_chunks() FROM PUBLIC, anon, authenticated;

/* ── Storing an embedding run ───────────────────────────────────────────── */

-- Replaces an entry's chunks in one transaction, or records why it could not.
-- Returns false, changing nothing, when the entry is gone or was edited since
-- the caller read `p_version`. A failure on an entry that is already ready
-- for this version keeps its chunks and only records the error, so a flaky
-- provider cannot take away what the bot already knows.
--
-- p_chunks: [{ "chunk_index": 0, "content": "...", "token_count": 120,
--              "embedding": [..768 floats..] | null }, ...]
CREATE OR REPLACE FUNCTION public.fn_store_bot_knowledge_chunks(
  p_knowledge_id UUID,
  p_version INT,
  p_chunks JSONB,
  p_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_entry public.bot_knowledge%ROWTYPE;
  v_count INT;
  v_embedded INT;
BEGIN
  SELECT * INTO v_entry FROM public.bot_knowledge WHERE id = p_knowledge_id FOR UPDATE;
  IF NOT FOUND OR v_entry.content_version <> p_version THEN
    RETURN false;
  END IF;

  IF p_error IS NOT NULL THEN
    UPDATE public.bot_knowledge
       SET status = CASE WHEN v_entry.status = 'ready' THEN 'ready' ELSE 'failed' END,
           last_error = left(p_error, 500)
     WHERE id = p_knowledge_id;
    RETURN true;
  END IF;

  DELETE FROM public.bot_knowledge_chunks WHERE knowledge_id = p_knowledge_id;

  INSERT INTO public.bot_knowledge_chunks (workspace_id, knowledge_id, chunk_index, title, content, token_count, embedding)
  SELECT v_entry.workspace_id,
         p_knowledge_id,
         (c ->> 'chunk_index')::int,
         v_entry.title,
         c ->> 'content',
         coalesce((c ->> 'token_count')::int, 0),
         CASE WHEN jsonb_typeof(c -> 'embedding') = 'array' THEN (c ->> 'embedding')::vector ELSE NULL END
    FROM jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) AS c;

  SELECT count(*), count(embedding) INTO v_count, v_embedded
    FROM public.bot_knowledge_chunks WHERE knowledge_id = p_knowledge_id;

  UPDATE public.bot_knowledge
     SET status = CASE WHEN v_count > 0 THEN 'ready' ELSE 'failed' END,
         chunk_count = v_count,
         embedded_count = v_embedded,
         last_error = CASE WHEN v_count > 0 THEN NULL ELSE 'Nothing to index.' END,
         embedded_at = now()
   WHERE id = p_knowledge_id;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_store_bot_knowledge_chunks(UUID, INT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_store_bot_knowledge_chunks(UUID, INT, JSONB, TEXT) TO service_role;

/* ── Search ─────────────────────────────────────────────────────────────── */

-- The same scoring as fn_hybrid_search_chunks (articles), so the two result
-- lists can be merged by combined_score. Only entries that are ready.
CREATE OR REPLACE FUNCTION public.fn_hybrid_search_bot_knowledge(
  p_workspace_id UUID,
  p_query_text TEXT,
  p_query_embedding vector(768),
  p_limit INT DEFAULT 6
)
RETURNS TABLE (
  id UUID,
  knowledge_id UUID,
  title TEXT,
  chunk_index INT,
  content TEXT,
  similarity FLOAT8,
  keyword_score FLOAT8,
  combined_score FLOAT8
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_has_embedding BOOLEAN := (p_query_embedding IS NOT NULL);
  v_clean_query TEXT := trim(coalesce(p_query_text, ''));
  v_tsquery tsquery;
BEGIN
  IF v_clean_query <> '' THEN
    BEGIN
      v_tsquery := plainto_tsquery('english', v_clean_query);
    EXCEPTION WHEN OTHERS THEN
      v_tsquery := NULL;
    END;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      c.id,
      c.knowledge_id,
      c.title,
      c.chunk_index,
      c.content,
      CASE
        WHEN v_has_embedding AND c.embedding IS NOT NULL THEN
          GREATEST(0.0::float8, (1.0::float8 - (c.embedding <=> p_query_embedding)::float8))
        ELSE 0.0::float8
      END AS sim,
      (
        CASE
          WHEN v_tsquery IS NOT NULL AND c.fts @@ v_tsquery THEN ts_rank_cd(c.fts, v_tsquery)::float8
          ELSE 0.0::float8
        END
        +
        CASE
          WHEN v_clean_query <> '' AND c.content ILIKE '%' || v_clean_query || '%' THEN 1.0::float8
          WHEN v_clean_query <> '' AND c.title ILIKE '%' || v_clean_query || '%' THEN 1.2::float8
          ELSE 0.0::float8
        END
      ) AS kw_score
    FROM public.bot_knowledge_chunks c
    JOIN public.bot_knowledge k ON k.id = c.knowledge_id
    WHERE c.workspace_id = p_workspace_id
      AND k.status = 'ready'
  ),
  ranked AS (
    SELECT
      candidates.*,
      ((0.65::float8 * candidates.sim) + (0.35::float8 * LEAST(candidates.kw_score, 2.0::float8) / 2.0::float8)) AS comb_score
    FROM candidates
  )
  SELECT ranked.id, ranked.knowledge_id, ranked.title, ranked.chunk_index, ranked.content,
         ranked.sim, ranked.kw_score, ranked.comb_score
    FROM ranked
   WHERE (v_has_embedding AND ranked.sim > 0.25) OR ranked.kw_score > 0.05
   ORDER BY ranked.comb_score DESC, ranked.sim DESC, ranked.kw_score DESC
   LIMIT p_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_hybrid_search_bot_knowledge(UUID, TEXT, vector, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_hybrid_search_bot_knowledge(UUID, TEXT, vector, INT) TO service_role;
