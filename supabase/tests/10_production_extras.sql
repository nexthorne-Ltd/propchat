-- ============================================================================
-- Test-only: columns, triggers and policies that production has but no
-- migration creates (docs/AUDIT.md M-13). Loaded after the initial schema
-- migration and before the later ones, mirroring production as closely as the
-- application code reveals it.
-- ============================================================================

ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE SET NULL;
ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_role_check;
ALTER TABLE public.agents ADD CONSTRAINT agents_role_check CHECK (role IN ('owner', 'admin', 'agent'));
ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_email_key;

ALTER TABLE public.visitors
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS channel_user_id TEXT,
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS current_url TEXT,
  ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS ip_address TEXT;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS channel_user_id TEXT,
  ADD COLUMN IF NOT EXISTS channel_metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_mode TEXT DEFAULT 'autopilot',
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS csat_rating INT,
  ADD COLUMN IF NOT EXISTS csat_feedback TEXT,
  ADD COLUMN IF NOT EXISTS merged_into UUID,
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS sentiment TEXT;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL;

-- The widget's settings (pre-chat form, FAQ trigger) live here.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS navbar_trigger_config JSONB;

-- Suspension and soft delete, set by super admins; the widget session and
-- server guards refuse such workspaces.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE public.canned_responses
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS title TEXT;

-- handle_new_message's body is in 20261002010000; the trigger is not.
CREATE OR REPLACE FUNCTION public.handle_new_message() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_new_message ON public.messages;
CREATE TRIGGER on_new_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_message();

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Workspace members can view full workspace" ON public.workspaces;
CREATE POLICY "Workspace members can view full workspace" ON public.workspaces
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR id IN (SELECT workspace_id FROM public.agents WHERE id = auth.uid()));
DROP POLICY IF EXISTS "Authenticated users can create workspaces" ON public.workspaces;
CREATE POLICY "Authenticated users can create workspaces" ON public.workspaces
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
