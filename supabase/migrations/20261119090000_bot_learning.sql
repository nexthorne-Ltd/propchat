-- Bot self-learning: each workspace's bot learns from the questions its team
-- answers, without ever learning from bad data.
--
-- The bot answers only from published articles and Bot knowledge. When it
-- cannot, the question goes to a person, the person answers, and that answer
-- was lost: the next visitor who asked the same thing got the same handover.
-- Model weights are never trained (the model is hosted and shared); what
-- grows is the workspace's verified knowledge, plus one bounded decision
-- setting tuned from outcomes.
--
-- Learning loop (src/lib/ai/learning/, run by /api/cron/bot-learning):
--   1. A help-centre question the bot handed over, whose ticket a person then
--      solved without a bad rating, becomes a candidate. Only the person's
--      public reply is used: never the visitor's text, never the bot's own
--      answers (a bot that learns from itself repeats its own mistakes).
--   2. The candidate is rewritten as a general Q&A, refused when it carries
--      personal data or is account specific, and checked against the help
--      centre and the team's own Bot knowledge (learned entries excluded, so
--      learned answers cannot vouch for each other):
--        grounded     the articles already say it (the bot missed it because
--                     of wording or language) -> may be approved automatically
--        new_fact     the articles do not say it -> a person must approve it
--        contradicts  the articles say otherwise -> rejected; if the article
--                     is out of date, fix the article
--   3. The same question seen again adds to `occurrences`. A grounded
--      candidate seen `min_occurrences` times (3 by default) is approved
--      automatically when the workspace allows it; everything else waits in
--      Settings -> AI bot -> Self-learning.
--   4. Approving creates a Bot knowledge entry (origin 'learned') which the
--      bot then searches like any other entry.
--   5. When an article or Bot knowledge entry a learned answer was checked
--      against changes or goes away, the learned entry is withdrawn at once
--      (in the same statement) and the candidate is marked 'stale' until the
--      next run checks it again against the new text.
--
-- Retrieval policy (src/lib/ai/learning/policy.ts): a per-workspace Thompson-
-- sampling bandit over three fixed confidence thresholds (strict / standard /
-- open). It never goes outside them, so it changes how readily the bot trusts
-- a close match, never what the bot says. Rewards come from what happened
-- after each answer (rejected, asked for a person, rated, thanked).
--
-- Everything here is written by the service role after the caller's access
-- was checked in a server action; members can read, nobody else writes.

CREATE EXTENSION IF NOT EXISTS vector;

/* ── Settings ───────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS public.bot_learning_settings (
  workspace_id UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  auto_approve BOOLEAN NOT NULL DEFAULT true,
  min_occurrences INT NOT NULL DEFAULT 3 CHECK (min_occurrences BETWEEN 2 AND 20),
  adaptive_retrieval BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* ── Candidates ─────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS public.bot_learning_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  question TEXT NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 500),
  answer TEXT NOT NULL CHECK (char_length(btrim(answer)) BETWEEN 1 AND 4000),
  question_embedding vector(768),
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'auto_approved', 'rejected', 'stale')),
  grounding TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (grounding IN ('grounded', 'new_fact', 'contradicts', 'unchecked')),
  -- The checks' verdicts (judge, deterministic overlap, figures, Jev), for the
  -- reviewer to read. No visitor text.
  grounding_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_article_ids UUID[] NOT NULL DEFAULT '{}',
  source_knowledge_ids UUID[] NOT NULL DEFAULT '{}',
  occurrences INT NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  conversation_ids UUID[] NOT NULL DEFAULT '{}',
  knowledge_id UUID REFERENCES public.bot_knowledge(id) ON DELETE SET NULL,
  reject_reason TEXT,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_learning_candidates_queue
  ON public.bot_learning_candidates (workspace_id, status, occurrences DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_learning_candidates_embedding
  ON public.bot_learning_candidates USING hnsw (question_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_bot_learning_candidates_articles
  ON public.bot_learning_candidates USING gin (source_article_ids);
CREATE INDEX IF NOT EXISTS idx_bot_learning_candidates_knowledge_sources
  ON public.bot_learning_candidates USING gin (source_knowledge_ids);

-- One row per handed-over visitor message the learner has looked at, so a
-- run never reads (or pays a model for) the same exchange twice.
CREATE TABLE IF NOT EXISTS public.bot_learning_scans (
  visitor_message_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  candidate_id UUID REFERENCES public.bot_learning_candidates(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_learning_scans_workspace
  ON public.bot_learning_scans (workspace_id, created_at DESC);

/* ── Where a Bot knowledge entry came from ──────────────────────────────── */

ALTER TABLE public.bot_knowledge
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS learning_candidate_id UUID REFERENCES public.bot_learning_candidates(id) ON DELETE SET NULL;

ALTER TABLE public.bot_knowledge DROP CONSTRAINT IF EXISTS bot_knowledge_origin_check;
ALTER TABLE public.bot_knowledge ADD CONSTRAINT bot_knowledge_origin_check
  CHECK (origin IN ('manual', 'learned'));

-- Only the learner (service role) marks an entry as learned: a person
-- writing an entry by hand cannot pass it off as verified, and editing a
-- learned entry by hand makes it the person's own.
CREATE OR REPLACE FUNCTION public.fn_bot_knowledge_origin_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.fn_is_direct_user_write() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.origin := 'manual';
      NEW.learning_candidate_id := NULL;
    ELSIF NEW.title IS DISTINCT FROM OLD.title OR NEW.content IS DISTINCT FROM OLD.content THEN
      NEW.origin := 'manual';
      NEW.learning_candidate_id := OLD.learning_candidate_id;
    ELSE
      NEW.origin := OLD.origin;
      NEW.learning_candidate_id := OLD.learning_candidate_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bot_knowledge_origin_guard ON public.bot_knowledge;
CREATE TRIGGER trg_bot_knowledge_origin_guard
  BEFORE INSERT OR UPDATE ON public.bot_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.fn_bot_knowledge_origin_guard();

/* ── Withdrawing learned answers when their sources change ──────────────── */

-- Deletes the learned entries checked against the given article or entry and
-- marks their candidates stale. Runs with definer rights because the editor
-- of an article may not be allowed to delete Bot knowledge rows themselves;
-- the bot must stop using the answer either way.
CREATE OR REPLACE FUNCTION public.fn_bot_learning_withdraw(p_workspace_id UUID, p_article_id UUID, p_knowledge_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids UUID[];
BEGIN
  SELECT array_agg(id) INTO v_ids
    FROM public.bot_learning_candidates
   WHERE workspace_id = p_workspace_id
     AND status IN ('approved', 'auto_approved')
     AND ((p_article_id IS NOT NULL AND p_article_id = ANY (source_article_ids))
       OR (p_knowledge_id IS NOT NULL AND p_knowledge_id = ANY (source_knowledge_ids)));

  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  -- Stale first: deleting the entries fires fn_bot_learning_knowledge_changed,
  -- which would otherwise read this as a person removing them.
  UPDATE public.bot_learning_candidates
     SET status = 'stale', knowledge_id = NULL, checked_at = NULL, reject_reason = NULL
   WHERE id = ANY (v_ids);

  DELETE FROM public.bot_knowledge
   WHERE workspace_id = p_workspace_id
     AND origin = 'learned'
     AND learning_candidate_id = ANY (v_ids);

  RETURN array_length(v_ids, 1);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_bot_learning_withdraw(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bot_learning_withdraw(UUID, UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bot_learning_article_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.fn_bot_learning_withdraw(OLD.workspace_id, OLD.id, NULL);
    RETURN NULL;
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.fn_bot_learning_withdraw(OLD.workspace_id, OLD.id, NULL);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_bot_learning_article_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bot_learning_article_changed ON public.articles;
CREATE TRIGGER trg_bot_learning_article_changed
  AFTER UPDATE OR DELETE ON public.articles
  FOR EACH ROW EXECUTE FUNCTION public.fn_bot_learning_article_changed();

-- A manual entry a learned answer was checked against. A learned entry being
-- deleted or edited only concerns its own candidate (handled below).
CREATE OR REPLACE FUNCTION public.fn_bot_learning_knowledge_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.origin = 'manual' THEN
      PERFORM public.fn_bot_learning_withdraw(OLD.workspace_id, NULL, OLD.id);
    ELSIF OLD.learning_candidate_id IS NOT NULL THEN
      -- A person deleted a learned entry: the bot must not learn it again
      -- from the next conversation that says the same thing.
      UPDATE public.bot_learning_candidates
         SET status = 'rejected', knowledge_id = NULL,
             reject_reason = coalesce(reject_reason, 'Removed from Bot knowledge')
       WHERE id = OLD.learning_candidate_id AND status IN ('approved', 'auto_approved');
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.content_version <> OLD.content_version THEN
    IF OLD.origin = 'manual' THEN
      PERFORM public.fn_bot_learning_withdraw(OLD.workspace_id, NULL, OLD.id);
    ELSIF NEW.origin = 'manual' AND NEW.learning_candidate_id IS NOT NULL THEN
      -- Edited by hand: it is the team's own entry now.
      UPDATE public.bot_learning_candidates
         SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
       WHERE id = NEW.learning_candidate_id AND status = 'auto_approved';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_bot_learning_knowledge_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bot_learning_knowledge_changed ON public.bot_knowledge;
CREATE TRIGGER trg_bot_learning_knowledge_changed
  AFTER UPDATE OR DELETE ON public.bot_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.fn_bot_learning_knowledge_changed();

/* ── Finding repeats of a question ──────────────────────────────────────── */

-- The closest open or learned candidate for this question, if it is close
-- enough to count as the same question. Rejected candidates are matched too,
-- so a rejected answer is not proposed again every time it comes up.
CREATE OR REPLACE FUNCTION public.fn_bot_learning_match(
  p_workspace_id UUID,
  p_embedding vector(768),
  p_question TEXT,
  p_threshold FLOAT8 DEFAULT 0.88
)
RETURNS TABLE (id UUID, status TEXT, grounding TEXT, similarity FLOAT8)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_norm TEXT := btrim(regexp_replace(lower(coalesce(p_question, '')), '[^a-z0-9 ]+', ' ', 'g'));
BEGIN
  IF p_embedding IS NOT NULL THEN
    RETURN QUERY
      SELECT c.id, c.status, c.grounding, (1 - (c.question_embedding <=> p_embedding))::float8
        FROM public.bot_learning_candidates c
       WHERE c.workspace_id = p_workspace_id
         AND c.question_embedding IS NOT NULL
         AND 1 - (c.question_embedding <=> p_embedding) >= p_threshold
       ORDER BY c.question_embedding <=> p_embedding
       LIMIT 1;
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;
  RETURN QUERY
    SELECT c.id, c.status, c.grounding, 1.0::float8
      FROM public.bot_learning_candidates c
     WHERE c.workspace_id = p_workspace_id
       AND btrim(regexp_replace(lower(c.question), '[^a-z0-9 ]+', ' ', 'g')) = v_norm
     LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_bot_learning_match(UUID, vector, TEXT, FLOAT8) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bot_learning_match(UUID, vector, TEXT, FLOAT8) TO service_role;

/* ── Retrieval policy (bandit) ──────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS public.bot_policy_arms (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  arm TEXT NOT NULL CHECK (arm IN ('strict', 'standard', 'open')),
  alpha FLOAT8 NOT NULL DEFAULT 1 CHECK (alpha > 0),
  beta FLOAT8 NOT NULL DEFAULT 1 CHECK (beta > 0),
  pulls INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, arm)
);

-- One row per bot reply to a help-centre question, with the arm that was in
-- force. `reward` is filled in once what happened next is known.
CREATE TABLE IF NOT EXISTS public.bot_policy_outcomes (
  message_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  arm TEXT NOT NULL CHECK (arm IN ('strict', 'standard', 'open')),
  kind TEXT NOT NULL CHECK (kind IN ('answer', 'handover')),
  reward FLOAT8 CHECK (reward IS NULL OR (reward >= 0 AND reward <= 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scored_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bot_policy_outcomes_pending
  ON public.bot_policy_outcomes (created_at) WHERE reward IS NULL;

-- Scores an outcome once and folds it into the arm's Beta posterior in the
-- same transaction, so a retried cron cannot count a reply twice. Old
-- evidence decays (x0.995 per update, floored at the prior) so a workspace
-- whose help centre changed is not stuck with last year's verdict.
CREATE OR REPLACE FUNCTION public.fn_bot_policy_reward(p_message_id UUID, p_reward FLOAT8)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.bot_policy_outcomes%ROWTYPE;
  v_reward FLOAT8 := LEAST(1, GREATEST(0, p_reward));
BEGIN
  UPDATE public.bot_policy_outcomes
     SET reward = v_reward, scored_at = now()
   WHERE message_id = p_message_id AND reward IS NULL
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.bot_policy_arms (workspace_id, arm, alpha, beta, pulls)
  VALUES (v_row.workspace_id, v_row.arm, 1 + v_reward, 1 + (1 - v_reward), 1)
  ON CONFLICT (workspace_id, arm) DO UPDATE
     SET alpha = GREATEST(1, bot_policy_arms.alpha * 0.995) + v_reward,
         beta = GREATEST(1, bot_policy_arms.beta * 0.995) + (1 - v_reward),
         pulls = bot_policy_arms.pulls + 1,
         updated_at = now();
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_bot_policy_reward(UUID, FLOAT8) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bot_policy_reward(UUID, FLOAT8) TO service_role;

/* ── Access ─────────────────────────────────────────────────────────────── */

ALTER TABLE public.bot_learning_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_learning_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_learning_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_policy_arms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_policy_outcomes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.bot_learning_settings, public.bot_learning_candidates, public.bot_learning_scans,
  public.bot_policy_arms, public.bot_policy_outcomes FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.bot_learning_settings, public.bot_learning_candidates,
  public.bot_learning_scans, public.bot_policy_arms, public.bot_policy_outcomes FROM authenticated;
-- Scans and outcomes are bookkeeping: service role only.
REVOKE ALL ON public.bot_learning_scans, public.bot_policy_outcomes FROM authenticated;
GRANT SELECT ON public.bot_learning_settings, public.bot_learning_candidates, public.bot_policy_arms TO authenticated;
GRANT ALL ON public.bot_learning_settings, public.bot_learning_candidates, public.bot_learning_scans,
  public.bot_policy_arms, public.bot_policy_outcomes TO service_role;

DROP POLICY IF EXISTS bot_learning_settings_select ON public.bot_learning_settings;
CREATE POLICY bot_learning_settings_select ON public.bot_learning_settings FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'view'));

DROP POLICY IF EXISTS bot_learning_candidates_select ON public.bot_learning_candidates;
CREATE POLICY bot_learning_candidates_select ON public.bot_learning_candidates FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'));

DROP POLICY IF EXISTS bot_policy_arms_select ON public.bot_policy_arms;
CREATE POLICY bot_policy_arms_select ON public.bot_policy_arms FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_settings'));

/* ── Schedule ───────────────────────────────────────────────────────────── */

-- Hourly, through the same pg_cron → pg_net bridge as the other jobs
-- (20261104090000). Skipped where pg_cron is not installed (local tests).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_call_app_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'zentry-bot-learning';
    PERFORM cron.schedule('zentry-bot-learning', '23 * * * *', 'SELECT public.fn_call_app_cron(''/api/cron/bot-learning'')');
  END IF;
END $$;
