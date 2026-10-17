-- ============================================================================
-- Bot resumes after a conversation is resolved
--
-- Rule: once a human agent replies, the assistant stays silent until the
-- conversation is resolved (or an agent turns autopilot back on).
--
-- That rule could never fire. Every visitor message runs handle_new_message,
-- which reopens the conversation and clears closed_at, so by the time the
-- auto-respond route looked, there was no trace that the conversation had ever
-- been resolved — and ai_mode stayed 'disabled' forever after the first human
-- reply.
--
-- last_resolved_at is a timestamp that is set when a conversation is closed and
-- is never cleared. On reopen, an assistant that was only switched off for the
-- previous (now resolved) exchange is switched back on.
-- ============================================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_resolved_at TIMESTAMPTZ;

UPDATE public.conversations
   SET last_resolved_at = closed_at
 WHERE last_resolved_at IS NULL
   AND closed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_conversation_resolution_bookkeeping()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Closing: remember when.
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    NEW.closed_at := COALESCE(NEW.closed_at, now());
    NEW.last_resolved_at := now();
  END IF;

  -- Reopening (normally a new visitor message): a fresh exchange starts, so
  -- the assistant gets its turn again — unless this same update set ai_mode
  -- on purpose.
  IF OLD.status = 'closed'
     AND NEW.status IS DISTINCT FROM 'closed'
     AND NEW.ai_mode = 'disabled'
     AND OLD.ai_mode = 'disabled' THEN
    NEW.ai_mode := 'autopilot';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_resolution_bookkeeping ON public.conversations;
CREATE TRIGGER trg_conversation_resolution_bookkeeping
BEFORE UPDATE OF status ON public.conversations
FOR EACH ROW
EXECUTE FUNCTION public.fn_conversation_resolution_bookkeeping();

CREATE INDEX IF NOT EXISTS idx_conversations_last_resolved_at
  ON public.conversations (last_resolved_at);

-- ============================================================================
-- Live visitor updates in the dashboard
--
-- The dashboard subscribes to visitors (online status, current page, location)
-- but the table was never added to the realtime publication, so those changes
-- only appeared after a manual refresh.
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'visitors'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.visitors;
  END IF;
END $$;
