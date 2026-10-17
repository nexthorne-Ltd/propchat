-- ============================================================================
-- Undo for 20261107090000_widget_anon_lockdown.sql. Emergency use only.
--
-- Puts back exactly the anon access the lockdown removed, so a widget build
-- older than the session functions works again. It also reopens H-3; apply
-- the lockdown again once the cause is fixed.
-- ============================================================================

GRANT ALL ON TABLE
  public.conversations,
  public.messages,
  public.visitors,
  public.visitor_page_history,
  public.internal_notes,
  public.conversation_tags,
  public.agents
TO anon;

DROP POLICY IF EXISTS "Allow anon to insert conversations" ON public.conversations;
CREATE POLICY "Allow anon to insert conversations" ON public.conversations FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "Allow anon to read conversations" ON public.conversations;
CREATE POLICY "Allow anon to read conversations" ON public.conversations FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Allow anon to update conversations" ON public.conversations;
CREATE POLICY "Allow anon to update conversations" ON public.conversations FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon to read public messages" ON public.messages;
CREATE POLICY "Allow anon to read public messages" ON public.messages FOR SELECT TO anon USING (is_internal IS NOT TRUE);
DROP POLICY IF EXISTS "Allow anon to insert visitor messages" ON public.messages;
CREATE POLICY "Allow anon to insert visitor messages" ON public.messages FOR INSERT TO anon WITH CHECK (sender_type = 'visitor');
DROP POLICY IF EXISTS "Allow anon to update message read_at" ON public.messages;
CREATE POLICY "Allow anon to update message read_at" ON public.messages FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon to insert visitors" ON public.visitors;
CREATE POLICY "Allow anon to insert visitors" ON public.visitors FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "Allow anon to select visitors" ON public.visitors;
CREATE POLICY "Allow anon to select visitors" ON public.visitors FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Allow anon to update visitors" ON public.visitors;
CREATE POLICY "Allow anon to update visitors" ON public.visitors FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon read agents for widget" ON public.agents;
CREATE POLICY "Allow anon read agents for widget" ON public.agents FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "visitor_page_history_anon_insert" ON public.visitor_page_history;
CREATE POLICY "visitor_page_history_anon_insert" ON public.visitor_page_history FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "Tags: anon can read tags" ON public.conversation_tags;
CREATE POLICY "Tags: anon can read tags" ON public.conversation_tags FOR SELECT TO anon USING (true);

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
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', r.sig);
  END LOOP;
END $$;
