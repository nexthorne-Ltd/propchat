-- ============================================================================
-- Public chat API: API keys for /api/v1
--
-- Customers want to put the chat (and the bot) inside their own systems: a
-- mobile app, a CRM, a backend that relays messages. Until now the only way
-- in was the widget, which talks to Supabase with the anon key from a
-- browser.
--
-- /api/v1 is a server-to-server API authenticated by a workspace API key.
-- A key is shown once when it is created; only its SHA-256 hash is stored, so
-- a leaked database row is not a working key. Keys are created and revoked by
-- server actions (service role) after a manage_settings check; the team can
-- list them, never read them back.
--
-- Conversations started through the API carry channel_metadata.source = 'api'
-- and the key's id. A key only reaches conversations of its own workspace
-- that were started through the API, so a key handed to one integration
-- cannot read the widget's or the inbox's other chats.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.workspace_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  -- The first characters of the key, so people can tell their keys apart.
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workspace_api_keys_workspace
  ON public.workspace_api_keys (workspace_id, created_at DESC);

ALTER TABLE public.workspace_api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Settings managers list API keys" ON public.workspace_api_keys;
CREATE POLICY "Settings managers list API keys" ON public.workspace_api_keys
  FOR SELECT TO authenticated
  USING (public.fn_role_has(public.fn_workspace_role(workspace_id), 'manage_settings'));

-- No write policies: keys are created and revoked by server actions only.
REVOKE ALL ON public.workspace_api_keys FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.workspace_api_keys FROM authenticated;
GRANT SELECT ON public.workspace_api_keys TO authenticated;
GRANT ALL ON public.workspace_api_keys TO service_role;

CREATE INDEX IF NOT EXISTS idx_conversations_api_source
  ON public.conversations ((channel_metadata ->> 'source'), workspace_id)
  WHERE channel_metadata ->> 'source' = 'api';
