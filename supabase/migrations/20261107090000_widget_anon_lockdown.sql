-- ============================================================================
-- Widget anon lockdown (docs/AUDIT.md H-3, step 2 of 2)
--
-- Applied in production on 2026-10-13, after
-- 20261106090000_widget_visitor_sessions.sql and the widget.js that uses the
-- fn_widget_* functions instead of tables had been live. Emergency undo (it
-- reopens the hole): supabase/pending/20261107090000_widget_anon_lockdown_undo.sql.
--
-- What it closes: with the public anon key anyone could read every
-- workspace's conversations, public messages and visitors (names, emails,
-- IPs), update them, and read agent rows. After this the anon role has no
-- table access to them at all; the widget works only through the session
-- functions, which scope everything to the visitor holding the token.
-- Signed-in agents are not affected (their access is the authenticated role).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables. Revoking the privileges is what closes the hole, whatever
--    policies a project has (some were created outside the migrations);
--    dropping the known anon policies keeps the policy list honest.
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE
  public.conversations,
  public.messages,
  public.visitors,
  public.visitor_page_history,
  public.internal_notes,
  public.conversation_tags,
  public.agents
FROM anon;

DROP POLICY IF EXISTS "Allow anon to insert conversations" ON public.conversations;
DROP POLICY IF EXISTS "Allow anon to read conversations" ON public.conversations;
DROP POLICY IF EXISTS "Allow anon to update conversations" ON public.conversations;
DROP POLICY IF EXISTS "Allow anon to read public messages" ON public.messages;
DROP POLICY IF EXISTS "Allow anon to insert visitor messages" ON public.messages;
DROP POLICY IF EXISTS "Allow anon to update message read_at" ON public.messages;
DROP POLICY IF EXISTS "Allow anon to insert visitors" ON public.visitors;
DROP POLICY IF EXISTS "Allow anon to select visitors" ON public.visitors;
DROP POLICY IF EXISTS "Allow anon to update visitors" ON public.visitors;
DROP POLICY IF EXISTS "Allow anon read agents for widget" ON public.agents;
DROP POLICY IF EXISTS "visitor_page_history_anon_insert" ON public.visitor_page_history;
DROP POLICY IF EXISTS "Tags: anon can read tags" ON public.conversation_tags;

-- ----------------------------------------------------------------------------
-- 2. Functions that trusted a bare visitor or conversation id. The widget now
--    reaches them only through fn_widget_* (which check the token first);
--    signed-in agents and server code keep them.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN (
         'fn_get_visitor_conversations',
         'fn_get_or_create_conversation',
         'fn_upsert_visitor',
         'fn_set_conversation_topic',
         'fn_mark_messages_delivered',
         'fn_mark_messages_read',
         'fn_mark_conversation_messages_as_read',
         'fn_expire_stale_visitors'
       )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;
