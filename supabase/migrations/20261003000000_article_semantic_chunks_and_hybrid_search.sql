-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Article chunks table for semantic retrieval
CREATE TABLE IF NOT EXISTS article_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  article_title TEXT NOT NULL,
  section_name TEXT,
  article_slug TEXT,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_article_chunk UNIQUE (article_id, chunk_index)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_article_chunks_workspace ON article_chunks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_article_chunks_article ON article_chunks(article_id);

-- HNSW cosine index on embeddings
CREATE INDEX IF NOT EXISTS idx_article_chunks_embedding 
ON article_chunks USING hnsw (embedding vector_cosine_ops);

-- Full text search generated column and index
ALTER TABLE article_chunks 
ADD COLUMN IF NOT EXISTS fts tsvector 
GENERATED ALWAYS AS (
  to_tsvector('english', 
    coalesce(article_title, '') || ' ' || 
    coalesce(section_name, '') || ' ' || 
    content
  )
) STORED;

CREATE INDEX IF NOT EXISTS idx_article_chunks_fts ON article_chunks USING gin (fts);

-- RLS policies on article_chunks
ALTER TABLE article_chunks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'article_chunks' AND policyname = 'Public can read published article chunks'
  ) THEN
    CREATE POLICY "Public can read published article chunks"
    ON article_chunks
    FOR SELECT
    TO public
    USING (
      EXISTS (
        SELECT 1 FROM articles
        WHERE articles.id = article_chunks.article_id
          AND articles.status = 'published'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'article_chunks' AND policyname = 'Workspace members can read workspace article chunks'
  ) THEN
    CREATE POLICY "Workspace members can read workspace article chunks"
    ON article_chunks
    FOR SELECT
    TO authenticated
    USING (
      fn_is_workspace_member(workspace_id)
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'article_chunks' AND policyname = 'Workspace members can insert workspace article chunks'
  ) THEN
    CREATE POLICY "Workspace members can insert workspace article chunks"
    ON article_chunks
    FOR INSERT
    TO authenticated
    WITH CHECK (
      workspace_id IS NOT NULL AND fn_is_workspace_member(workspace_id)
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'article_chunks' AND policyname = 'Workspace members can update workspace article chunks'
  ) THEN
    CREATE POLICY "Workspace members can update workspace article chunks"
    ON article_chunks
    FOR UPDATE
    TO authenticated
    USING (
      fn_is_workspace_member(workspace_id)
    )
    WITH CHECK (
      workspace_id IS NOT NULL AND fn_is_workspace_member(workspace_id)
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'article_chunks' AND policyname = 'Workspace members can delete workspace article chunks'
  ) THEN
    CREATE POLICY "Workspace members can delete workspace article chunks"
    ON article_chunks
    FOR DELETE
    TO authenticated
    USING (
      fn_is_workspace_member(workspace_id)
    );
  END IF;
END $$;

-- Hybrid search RPC function combining pgvector cosine similarity with full text search & exact phrase matching
CREATE OR REPLACE FUNCTION fn_hybrid_search_chunks(
  p_workspace_id UUID,
  p_query_text TEXT,
  p_query_embedding vector(768),
  p_limit INT DEFAULT 6
)
RETURNS TABLE (
  id UUID,
  article_id UUID,
  article_title TEXT,
  section_name TEXT,
  article_slug TEXT,
  chunk_index INT,
  content TEXT,
  similarity FLOAT8,
  keyword_score FLOAT8,
  combined_score FLOAT8
)
LANGUAGE plpgsql
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
  ELSE
    v_tsquery := NULL;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      c.id,
      c.article_id,
      c.article_title,
      c.section_name,
      c.article_slug,
      c.chunk_index,
      c.content,
      CASE 
        WHEN v_has_embedding AND c.embedding IS NOT NULL THEN
          GREATEST(0.0::float8, (1.0::float8 - (c.embedding <=> p_query_embedding)::float8))
        ELSE 0.0::float8
      END AS sim,
      (
        CASE
          WHEN v_tsquery IS NOT NULL AND c.fts @@ v_tsquery THEN
            ts_rank_cd(c.fts, v_tsquery)::float8
          ELSE 0.0::float8
        END
        +
        CASE
          WHEN v_clean_query <> '' AND c.content ILIKE '%' || v_clean_query || '%' THEN 1.0::float8
          WHEN v_clean_query <> '' AND c.article_title ILIKE '%' || v_clean_query || '%' THEN 1.2::float8
          ELSE 0.0::float8
        END
      ) AS kw_score
    FROM article_chunks c
    JOIN articles a ON a.id = c.article_id
    WHERE c.workspace_id = p_workspace_id
      AND a.status = 'published'
  ),
  ranked AS (
    SELECT
      candidates.*,
      (
        (0.65::float8 * candidates.sim) + 
        (0.35::float8 * LEAST(candidates.kw_score, 2.0::float8) / 2.0::float8)
      ) AS comb_score
    FROM candidates
  )
  SELECT
    ranked.id,
    ranked.article_id,
    ranked.article_title,
    ranked.section_name,
    ranked.article_slug,
    ranked.chunk_index,
    ranked.content,
    ranked.sim AS similarity,
    ranked.kw_score AS keyword_score,
    ranked.comb_score AS combined_score
  FROM ranked
  WHERE (v_has_embedding AND ranked.sim > 0.25) OR ranked.kw_score > 0.05
  ORDER BY ranked.comb_score DESC, ranked.sim DESC, ranked.kw_score DESC
  LIMIT p_limit;
END;
$$;
