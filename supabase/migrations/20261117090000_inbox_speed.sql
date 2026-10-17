-- ============================================================================
-- Inbox speed
--
-- 1. The inbox list (30 conversations) showed each one's last message and
--    unread count by downloading EVERY message of those 30 conversations,
--    full text included, up to 1,000 rows, on every refresh (page load, tab
--    focus, realtime reconnect, the 'r' key). fn_inbox_summaries returns one
--    small row per conversation instead.
--
--    SECURITY INVOKER: it runs with the caller's rights, so RLS on messages
--    decides what an agent sees, exactly as the old queries did.
--
-- 2. Indexes for the queries the dashboard and help center run all the time.
--    The existing ones cover a single column (conversations.updated_at,
--    messages.conversation_id), so "this workspace's newest conversations"
--    and "this conversation's messages in order" walked far more rows than
--    they return.
--
-- Safe for the deployed app: one new function and new indexes; nothing that
-- exists changes. The tables are small enough today that a plain CREATE INDEX
-- is quick (apply_migration runs in a transaction, so CONCURRENTLY is not
-- available). Undo:
--   DROP FUNCTION IF EXISTS public.fn_inbox_summaries(uuid[]);
--   DROP INDEX IF EXISTS idx_conversations_workspace_updated, idx_messages_conversation_created,
--     idx_messages_unread_visitor, idx_articles_workspace_published;
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_conversations_workspace_updated
  ON public.conversations (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON public.messages (conversation_id, created_at DESC);

-- Unread counts only ever look at visitor messages nobody has read.
CREATE INDEX IF NOT EXISTS idx_messages_unread_visitor
  ON public.messages (conversation_id)
  WHERE sender_type = 'visitor' AND read_at IS NULL;

-- The public help center lists a workspace's published articles in order.
-- (articles predates the repo's migrations, hence the existence check.)
DO $$
BEGIN
  IF to_regclass('public.articles') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_articles_workspace_published
      ON public.articles (workspace_id, order_index, created_at)
      WHERE status = 'published';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_inbox_summaries(p_conversation_ids UUID[])
RETURNS TABLE (
  conversation_id UUID,
  last_message JSONB,
  unread_count INT,
  has_visitor_message BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.id,
    (SELECT to_jsonb(m) FROM public.messages m
      WHERE m.conversation_id = c.id
      ORDER BY m.created_at DESC
      LIMIT 1),
    (SELECT count(*)::int FROM public.messages m
      WHERE m.conversation_id = c.id AND m.sender_type = 'visitor' AND m.read_at IS NULL),
    EXISTS (SELECT 1 FROM public.messages m
      WHERE m.conversation_id = c.id AND m.sender_type = 'visitor')
  -- A page is 30 conversations; the cap keeps a bad call cheap.
  FROM unnest(p_conversation_ids[1:200]) AS c(id);
$$;

REVOKE ALL ON FUNCTION public.fn_inbox_summaries(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_inbox_summaries(UUID[]) TO authenticated, service_role;
