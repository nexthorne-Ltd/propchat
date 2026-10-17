-- ============================================================================
-- Jev moves to the platform level, next to the DeepSeek key
--
-- 20261109090000 set Jev up per workspace. The generative model is not per
-- workspace: the super admin sets one provider and key for the whole platform
-- (platform_ai_settings, Super admin → Platform AI), and Jev belongs beside
-- it. One TypeSafe key and one mode for every workspace's bot.
--
--   * platform_ai_settings.jev_settings: mode ('off' | 'shadow' | 'live') and
--     which decisions Jev makes.
--   * platform_ai_settings.jev_api_key: the TypeSafe key. The table has RLS
--     on and no policy (service role only), like the DeepSeek key beside it.
--
-- A key someone already saved on a workspace is carried over (when the
-- platform has none yet); the mode is not, so Jev stays off until the super
-- admin turns it on. Then the per-workspace columns are dropped.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.platform_ai_settings') IS NULL THEN
    RAISE NOTICE 'platform_ai_settings does not exist; run 20261027090000 first.';
    RETURN;
  END IF;

  ALTER TABLE public.platform_ai_settings
    ADD COLUMN IF NOT EXISTS jev_api_key TEXT,
    ADD COLUMN IF NOT EXISTS jev_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

  INSERT INTO public.platform_ai_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'workspace_secrets' AND column_name = 'jev_api_key'
  ) THEN
    EXECUTE $carry$
      UPDATE public.platform_ai_settings
         SET jev_api_key = (
               SELECT s.jev_api_key FROM public.workspace_secrets s
                WHERE coalesce(btrim(s.jev_api_key), '') <> ''
                ORDER BY s.updated_at DESC
                LIMIT 1
             )
       WHERE id = TRUE AND coalesce(btrim(jev_api_key), '') = ''
    $carry$;
  END IF;
END $$;

ALTER TABLE IF EXISTS public.workspace_secrets DROP COLUMN IF EXISTS jev_api_key;
ALTER TABLE public.workspaces DROP COLUMN IF EXISTS jev_settings;

-- The summary on the admin screen reads every workspace's Jev decisions.
DROP INDEX IF EXISTS public.idx_ai_reply_events_jev;
CREATE INDEX IF NOT EXISTS idx_ai_reply_events_jev_recent
  ON public.ai_reply_events (created_at DESC)
  WHERE event IN ('jev_intent', 'jev_grounding');
