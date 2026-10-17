-- Trader data lookup: the bot's lookup specialists read the firm's own records.
--
-- Account status, KYC status, Order lookup, Affiliate stats and Coupon check
-- (src/lib/ai/sub-agents.ts) could only explain the usual cause and hand the
-- trader to a person, because the bot cannot see the firm's systems. A
-- workspace can now connect its trader data (Settings -> AI bot -> Trader
-- data), which the bot reads from our servers to fetch the record the
-- question is about (src/lib/ai/trader-data/, docs/TRADER_DATA.md). Every
-- firm runs the same prop-firm backend on its own Supabase project, so the
-- usual connection is that project's URL and service-role key ('supabase'),
-- read with fixed, read-only queries that never select passwords. A firm on
-- another backend can give an HTTPS endpoint instead ('http').
--
-- The key is encrypted before it is stored (AES-256-GCM with
-- CHANNEL_ENCRYPTION_KEY, src/lib/channels/crypto.ts), like channel
-- credentials: a service-role key opens the firm's whole database, so a
-- leaked backup of ours must not.
--
-- A record is personal data, and anyone can type someone else's email into a
-- chat. So, apart from a coupon code, nothing is looked up until the visitor
-- has proved the email in this conversation: the bot sends a 6-digit code to
-- it and the visitor types the code back in the chat. Only that verified
-- email is ever sent to the endpoint; an account number or order id the
-- visitor types is passed as a hint, and the endpoint must check it belongs
-- to the email.
--
-- Both tables are server-side only: RLS on, no policies, so anon and signed-in
-- members reach nothing, and the service role (the auto-respond route and the
-- settings actions, after their own guards) does the reading and writing.
--   trader_data_connections        one per workspace; the key is never sent
--                                  to the browser (the settings screen
--                                  learns only whether one is set)
--   trader_identity_verifications  one per conversation: waiting for the
--                                  email, waiting for the code, or verified.
--                                  Only a hash of the code is stored.

CREATE TABLE IF NOT EXISTS public.trader_data_connections (
  workspace_id UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  kind TEXT NOT NULL DEFAULT 'supabase',
  -- The firm's Supabase project URL, or its HTTPS endpoint.
  url TEXT,
  -- The service-role key, or the endpoint's bearer key: encrypted, "v1:…".
  secret_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trader_data_connections_kind_check CHECK (kind IN ('supabase', 'http'))
);

ALTER TABLE public.trader_data_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trader_data_connections FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.trader_data_connections TO service_role;

CREATE TABLE IF NOT EXISTS public.trader_identity_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'awaiting_email',
  email TEXT,
  code_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  codes_sent INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ,
  code_expires_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  -- The question that started it, answered once the code is right.
  pending_question TEXT,
  pending_sub_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trader_identity_verifications_status_check
    CHECK (status IN ('awaiting_email', 'awaiting_code', 'verified'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trader_identity_verifications_conversation
  ON public.trader_identity_verifications (conversation_id);
-- The per-email send limit looks across conversations.
CREATE INDEX IF NOT EXISTS idx_trader_identity_verifications_email
  ON public.trader_identity_verifications (lower(email), last_sent_at DESC)
  WHERE email IS NOT NULL;

ALTER TABLE public.trader_identity_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trader_identity_verifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.trader_identity_verifications TO service_role;
