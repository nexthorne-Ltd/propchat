-- ============================================================================
-- AI Reply & Handover Idempotency Guards
--
-- Prevents duplicate AI replies or duplicate handover internal notes
-- for the same visitor message.
-- ============================================================================

-- Exactly one public bot reply per visitor message
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique_ai_reply_per_visitor_msg
  ON public.messages (conversation_id, reply_to_message_id)
  WHERE sender_type = 'ai' AND is_internal = false AND reply_to_message_id IS NOT NULL;

-- Exactly one internal AI handover note per visitor message
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique_ai_handover_per_visitor_msg
  ON public.messages (conversation_id, reply_to_message_id)
  WHERE sender_type = 'ai' AND is_internal = true AND reply_to_message_id IS NOT NULL;
