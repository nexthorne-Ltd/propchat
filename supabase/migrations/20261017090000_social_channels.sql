-- ============================================================================
-- X, LinkedIn, TikTok and Threads on the channel framework
--
-- These four channels differ from WhatsApp and Instagram in one way that
-- matters to the database: most of what arrives is *public* (a post that
-- mentions the company, a reply, a comment), and so is the answer. Nothing
-- new is needed to store that:
--
--   * An inbound item goes through fn_channel_ingest_inbound like any other
--     message. Its sender id carries the audience: "pub:<author>" for a
--     public item, the bare id for a direct message. The conversation is
--     looked up by (visitor, channel), and the visitor by channel_user_id, so
--     a person's DMs and their public posts become two separate tickets and
--     an agent can never answer a DM with a public reply by accident.
--   * The item's details (kind, post, permalink) live in messages.metadata
--     under channel_public; the outbound worker reads them to know what to
--     reply to.
--   * None of these channels has a customer-service window, so the existing
--     window rule (fn_channel_template_required) stays "never required".
--
-- So this migration only teaches the two channel lists (and the shape of a
-- channel id: "x" is one letter) about the new ids.
-- The lists are the single place the ticket constraint and the outbound
-- queue read from; the functions below are the earlier definitions with the
-- four ids added, nothing else changed. No tables, so no new policies.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_is_ticket_channel(p_channel TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_channel IN ('chat', 'email', 'web_form', 'whatsapp', 'instagram', 'x', 'linkedin', 'tiktok', 'threads');
$$;

CREATE OR REPLACE FUNCTION public.fn_channel_has_outbound(p_channel TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(p_channel IN ('whatsapp', 'instagram', 'email', 'x', 'linkedin', 'tiktok', 'threads'), false);
$$;

-- Channel ids on connections had to be at least two letters, and X is one.
ALTER TABLE public.channel_connections DROP CONSTRAINT IF EXISTS channel_connections_channel_check;
ALTER TABLE public.channel_connections ADD CONSTRAINT channel_connections_channel_check CHECK (channel ~ '^[a-z][a-z_]{0,31}$');

-- The constraint calls fn_is_ticket_channel, which is looked up when a row is
-- written, so existing rows and the constraint need no change. Re-validating
-- is harmless and keeps this migration honest about what it relies on.
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_channel_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_channel_check CHECK (public.fn_is_ticket_channel(channel)) NOT VALID;
ALTER TABLE public.tickets VALIDATE CONSTRAINT tickets_channel_check;
