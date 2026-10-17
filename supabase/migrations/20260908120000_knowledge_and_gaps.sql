-- ============================================================================
-- Internal knowledge, and a record of what the help centre could not answer
--
-- Two gaps this closes:
--
-- 1. Everything the assistant knows has to be a published article. Refund
--    thresholds, escalation paths, "the invoice bug from March" — the things a
--    team actually needs on hand — either got published to customers or lived
--    nowhere.
--
-- 2. When a question fell outside the documentation the conversation was handed
--    to a person and the question itself was lost. Those are exactly the
--    articles worth writing next, and nobody could see them.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Internal knowledge notes
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.knowledge_notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  -- Free-form labels so a team can group notes their own way.
  tags          TEXT[] NOT NULL DEFAULT '{}',
  -- 'agent_only'  : never leaves the dashboard. The default, because the safe
  --                 mistake is a note the assistant did not use.
  -- 'assistant'   : the assistant may answer customers from it.
  visibility    TEXT NOT NULL DEFAULT 'agent_only'
                  CHECK (visibility IN ('agent_only', 'assistant')),
  created_by    UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knowledge_notes_workspace_idx
  ON public.knowledge_notes (workspace_id, updated_at DESC);

-- The assistant loads only the notes it is allowed to use; keep that cheap.
CREATE INDEX IF NOT EXISTS knowledge_notes_assistant_idx
  ON public.knowledge_notes (workspace_id)
  WHERE visibility = 'assistant';

COMMENT ON TABLE public.knowledge_notes IS
  'Private team knowledge. Never published to the help centre; visibility decides whether the assistant may answer from it.';

-- ----------------------------------------------------------------------------
-- 2. Questions nothing could answer
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.unanswered_questions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- What the customer actually typed, kept verbatim for the owner to read.
  question         TEXT NOT NULL,
  -- Lowercased and stripped, so the same question asked ten different ways by
  -- ten people collapses into one row with a count instead of ten rows.
  normalized       TEXT NOT NULL,
  -- Why the assistant stayed quiet — the retrieval engine's own explanation.
  reason           TEXT,
  times_asked      INTEGER NOT NULL DEFAULT 1,
  -- The most recent conversation it came up in, to read it in context.
  last_conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  -- 'open'     : still a gap
  -- 'answered' : an article or note now covers it
  -- 'ignored'  : deliberately out of scope
  status           TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'answered', 'ignored')),
  -- Set when the gap was closed by writing something.
  resolved_article_id UUID REFERENCES public.articles(id) ON DELETE SET NULL,
  resolved_note_id    UUID REFERENCES public.knowledge_notes(id) ON DELETE SET NULL,
  first_asked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_asked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per distinct question per workspace; the RPC below relies on this.
CREATE UNIQUE INDEX IF NOT EXISTS unanswered_questions_unique
  ON public.unanswered_questions (workspace_id, normalized);

CREATE INDEX IF NOT EXISTS unanswered_questions_open_idx
  ON public.unanswered_questions (workspace_id, times_asked DESC, last_asked_at DESC)
  WHERE status = 'open';

COMMENT ON TABLE public.unanswered_questions IS
  'Customer questions the help centre could not answer, deduplicated and counted — the backlog of articles worth writing.';

-- ----------------------------------------------------------------------------
-- 3. Recording a gap
--
-- SECURITY DEFINER because the widget's anonymous session must be able to
-- record a gap, but must not be able to read the table.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_record_unanswered_question(
  p_workspace_id UUID,
  p_question TEXT,
  p_reason TEXT DEFAULT NULL,
  p_conversation_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm TEXT;
BEGIN
  -- Collapse case, punctuation and runs of whitespace so "How do I cancel?"
  -- and "how do i cancel" are recognised as the same gap.
  v_norm := btrim(regexp_replace(lower(coalesce(p_question, '')), '[^a-z0-9 ]+', ' ', 'g'));
  v_norm := regexp_replace(v_norm, '\s+', ' ', 'g');

  -- Nothing to learn from a greeting.
  IF length(v_norm) < 8 THEN
    RETURN;
  END IF;

  INSERT INTO public.unanswered_questions AS u
    (workspace_id, question, normalized, reason, last_conversation_id)
  VALUES
    (p_workspace_id, p_question, v_norm, p_reason, p_conversation_id)
  ON CONFLICT (workspace_id, normalized) DO UPDATE
    SET times_asked = u.times_asked + 1,
        last_asked_at = NOW(),
        reason = COALESCE(EXCLUDED.reason, u.reason),
        last_conversation_id = COALESCE(EXCLUDED.last_conversation_id, u.last_conversation_id),
        -- A question asked again after being marked answered is not answered.
        status = CASE WHEN u.status = 'ignored' THEN 'ignored' ELSE 'open' END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_record_unanswered_question(UUID, TEXT, TEXT, UUID)
  TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Row level security
--
-- Both tables hold internal data. Neither is readable by the public role —
-- knowledge_notes especially: an agent-only note reaching a visitor would be
-- worse than the note not existing.
-- ----------------------------------------------------------------------------

ALTER TABLE public.knowledge_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unanswered_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_notes_team ON public.knowledge_notes;
CREATE POLICY knowledge_notes_team ON public.knowledge_notes
  FOR ALL
  USING (
    workspace_id IN (
      SELECT a.workspace_id FROM public.agents a WHERE a.id = auth.uid()
      UNION
      SELECT w.id FROM public.workspaces w WHERE w.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT a.workspace_id FROM public.agents a WHERE a.id = auth.uid()
      UNION
      SELECT w.id FROM public.workspaces w WHERE w.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS unanswered_questions_team ON public.unanswered_questions;
CREATE POLICY unanswered_questions_team ON public.unanswered_questions
  FOR ALL
  USING (
    workspace_id IN (
      SELECT a.workspace_id FROM public.agents a WHERE a.id = auth.uid()
      UNION
      SELECT w.id FROM public.workspaces w WHERE w.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT a.workspace_id FROM public.agents a WHERE a.id = auth.uid()
      UNION
      SELECT w.id FROM public.workspaces w WHERE w.owner_id = auth.uid()
    )
  );
