-- ============================================================================
-- Message delivery receipts (WhatsApp-style ticks)
--
-- The UI needs three distinct facts, and until now only had one:
--   sent      — the row exists (created_at)
--   delivered — it actually reached the other side's client (NEW)
--   read      — the other side looked at it (read_at)
--
-- Before this, "delivered" was inferred in the dashboard from whether the
-- visitor's heartbeat was recent. That is a guess, not a receipt: a visitor can
-- be on the page with the messenger closed, and the agent would still be shown
-- a double tick claiming the message had arrived.
--
-- Additive only — no existing column or function is altered.
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Receipt writes always target "the messages I did NOT send", so they filter on
-- sender_type alongside the conversation.
CREATE INDEX IF NOT EXISTS messages_delivery_idx
  ON public.messages (conversation_id, sender_type, delivered_at, read_at);

-- ----------------------------------------------------------------------------
-- Mark every inbound message in a conversation as delivered.
--
-- SECURITY DEFINER because the widget runs as `anon`: it must be able to
-- acknowledge receipt without being able to write message rows generally.
-- `p_exclude_sender` is the caller's own side, so nobody can mark their own
-- messages delivered and fake a receipt.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_mark_messages_delivered(
  p_conversation_id UUID,
  p_exclude_sender TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.messages
     SET delivered_at = now()
   WHERE conversation_id = p_conversation_id
     AND sender_type <> p_exclude_sender
     AND delivered_at IS NULL;
$$;

-- ----------------------------------------------------------------------------
-- Mark inbound messages as read. Also backfills delivered_at: something you
-- have read was necessarily delivered, and without this a fast reader can
-- produce a read receipt with no delivery receipt behind it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_mark_messages_read(
  p_conversation_id UUID,
  p_exclude_sender TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.messages
     SET read_at = COALESCE(read_at, now()),
         delivered_at = COALESCE(delivered_at, now())
   WHERE conversation_id = p_conversation_id
     AND sender_type <> p_exclude_sender
     AND read_at IS NULL;
$$;

GRANT EXECUTE ON FUNCTION public.fn_mark_messages_delivered(UUID, TEXT)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mark_messages_read(UUID, TEXT)
  TO anon, authenticated;
