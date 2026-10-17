-- ============================================================================
-- Quote-reply: point a message at the one it answers
--
-- Threads with several questions in flight were ambiguous — an agent's "yes,
-- that's right" could refer to any of the last four messages, and neither the
-- visitor nor the next agent to open the conversation could tell which.
--
-- ON DELETE SET NULL rather than CASCADE: deleting a quoted message must not
-- delete the replies to it. The reply simply stops showing a quote.
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID
    REFERENCES public.messages(id) ON DELETE SET NULL;

-- Loading a thread asks "which messages quote something?", and rendering asks
-- "what did this one quote?"; both are served by this.
CREATE INDEX IF NOT EXISTS messages_reply_to_idx
  ON public.messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

COMMENT ON COLUMN public.messages.reply_to_message_id IS
  'The message this one is a reply to, shown as a quote above the reply.';
