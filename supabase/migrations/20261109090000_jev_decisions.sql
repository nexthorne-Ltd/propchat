-- ============================================================================
-- Jev (TypeSafe System One model) next to the bot's DeepSeek model
--
-- DeepSeek writes the replies. Jev makes the small typed decisions around
-- them, fast and in a fixed shape: which intent a message has, and whether a
-- drafted answer is actually supported by the articles it came from.
--
--   * workspaces.jev_settings: mode ('off' | 'shadow' | 'live') and which
--     decisions Jev makes. 'shadow' runs Jev beside DeepSeek and only records
--     what it would have decided, so a workspace can compare before trusting
--     it. Not secret, so it lives on the workspace row.
--   * workspace_secrets.jev_api_key: the workspace's TypeSafe key. That
--     table has no policy (service role only), like the SMTP password; the
--     settings screen only ever learns whether a key is saved.
--
-- Decisions are logged in ai_reply_events (events 'jev_intent' and
-- 'jev_grounding'), decisions only, never message text.
-- ============================================================================

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS jev_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Created by 20261104090000; repeated here so this file stands on its own.
CREATE TABLE IF NOT EXISTS public.workspace_secrets (
  workspace_id UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  smtp_pass    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.workspace_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_secrets FROM anon, authenticated;

ALTER TABLE public.workspace_secrets
  ADD COLUMN IF NOT EXISTS jev_api_key TEXT;

-- Members (owners/admins through the settings screen) read the stats below;
-- the events are already readable by the workspace's members (RLS on
-- ai_reply_events). This index keeps the 14-day summary cheap.
CREATE INDEX IF NOT EXISTS idx_ai_reply_events_jev
  ON public.ai_reply_events (workspace_id, created_at DESC)
  WHERE event IN ('jev_intent', 'jev_grounding');
