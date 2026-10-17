-- ============================================================================
-- Team chat: members of a workspace talk to each other inside the dashboard.
--
-- Agents asked each other things over WhatsApp or another app, outside the
-- product, losing the link to the customer chat they were asking about. Now:
--   - one "General" channel per workspace that every member can read and
--     write;
--   - direct messages between two members, private to them;
--   - a message can point at a customer conversation of the same workspace
--     ("can you look at this one?") and can @mention people.
--
-- Who may do what is decided here, like every other rule:
--   - Only current members (fn_workspace_role IS NOT NULL: active, of this
--     workspace) see or write anything. Light agents are members: they can
--     talk to the team, which is most of what they are for.
--   - Direct threads are visible to their two members only.
--   - Messages are written only as yourself, only to threads you can see.
--     Threads and read markers are written only through the functions below.
--   - A shared conversation must belong to the same workspace, or the link
--     is dropped.
--
-- Realtime: team_messages joins the supabase_realtime publication; delivery
-- follows the SELECT policies, so nobody receives a thread they cannot read.
--
-- Safe for the deployed app: new tables and functions only. Undo:
--   DROP TABLE IF EXISTS public.team_messages, public.team_thread_members, public.team_threads CASCADE;
--   DROP FUNCTION IF EXISTS public.fn_team_general(uuid), public.fn_team_open_direct(uuid, uuid),
--     public.fn_team_mark_read(uuid), public.fn_team_inbox(uuid), public.fn_team_can_see(uuid),
--     public.fn_team_delete_message(uuid), public.fn_team_message_defaults();
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.team_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'direct')),
  name TEXT CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 60),
  -- 'lower-agent-id:higher-agent-id' for a direct thread, so a pair has one.
  direct_key TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,
  CONSTRAINT team_threads_direct_key CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS team_threads_direct_unique ON public.team_threads (workspace_id, direct_key) WHERE direct_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS team_threads_general_unique ON public.team_threads (workspace_id) WHERE kind = 'channel' AND name = 'General';
CREATE INDEX IF NOT EXISTS team_threads_workspace ON public.team_threads (workspace_id, last_message_at DESC);

-- Direct threads: their two members. Any thread: where each reader got to.
CREATE TABLE IF NOT EXISTS public.team_thread_members (
  thread_id UUID NOT NULL REFERENCES public.team_threads(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Direct-thread participant (true) or just a channel reader's marker.
  is_participant BOOLEAN NOT NULL DEFAULT false,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, agent_id)
);
CREATE INDEX IF NOT EXISTS team_thread_members_agent ON public.team_thread_members (agent_id, workspace_id);

CREATE TABLE IF NOT EXISTS public.team_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.team_threads(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL,
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  mentions UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS team_messages_thread_created ON public.team_messages (thread_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Visibility
-- ----------------------------------------------------------------------------

-- The caller may read (and so write to) this thread.
CREATE OR REPLACE FUNCTION public.fn_team_can_see(p_thread_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_threads t
    WHERE t.id = p_thread_id
      AND public.fn_workspace_role(t.workspace_id) IS NOT NULL
      AND (
        t.kind = 'channel'
        OR EXISTS (
          SELECT 1 FROM public.team_thread_members m
          WHERE m.thread_id = t.id AND m.agent_id = auth.uid() AND m.is_participant
        )
      )
  );
$$;
REVOKE ALL ON FUNCTION public.fn_team_can_see(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_team_can_see(UUID) TO authenticated, service_role;

ALTER TABLE public.team_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_thread_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_threads, public.team_thread_members, public.team_messages FROM anon;

DROP POLICY IF EXISTS team_threads_select ON public.team_threads;
CREATE POLICY team_threads_select ON public.team_threads FOR SELECT TO authenticated
  USING (public.fn_team_can_see(id));

DROP POLICY IF EXISTS team_thread_members_select ON public.team_thread_members;
CREATE POLICY team_thread_members_select ON public.team_thread_members FOR SELECT TO authenticated
  USING (public.fn_team_can_see(thread_id));

DROP POLICY IF EXISTS team_messages_select ON public.team_messages;
CREATE POLICY team_messages_select ON public.team_messages FOR SELECT TO authenticated
  USING (public.fn_team_can_see(thread_id));

DROP POLICY IF EXISTS team_messages_insert ON public.team_messages;
CREATE POLICY team_messages_insert ON public.team_messages FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid() AND deleted_at IS NULL AND public.fn_team_can_see(thread_id));

-- ----------------------------------------------------------------------------
-- A new message: workspace from its thread, a shared conversation only from
-- the same workspace, mentions only of the workspace's people, and the
-- thread moves to the top.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_team_message_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT t.workspace_id INTO NEW.workspace_id FROM public.team_threads t WHERE t.id = NEW.thread_id;
  NEW.content := btrim(NEW.content);
  NEW.created_at := now();

  IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.conversations c WHERE c.id = NEW.conversation_id AND c.workspace_id = NEW.workspace_id
  ) THEN
    NEW.conversation_id := NULL;
  END IF;

  NEW.mentions := coalesce((
    SELECT array_agg(DISTINCT m)
    FROM unnest(coalesce(NEW.mentions, '{}')) AS m
    WHERE EXISTS (SELECT 1 FROM public.agents a WHERE a.id = m AND a.workspace_id = NEW.workspace_id)
       OR EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = NEW.workspace_id AND w.owner_id = m)
  ), '{}');

  UPDATE public.team_threads SET last_message_at = NEW.created_at WHERE id = NEW.thread_id;
  -- Writing in a thread means having read it.
  INSERT INTO public.team_thread_members (thread_id, agent_id, workspace_id, last_read_at)
  VALUES (NEW.thread_id, NEW.sender_id, NEW.workspace_id, NEW.created_at)
  ON CONFLICT (thread_id, agent_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_message_defaults ON public.team_messages;
CREATE TRIGGER team_message_defaults BEFORE INSERT ON public.team_messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_team_message_defaults();

-- ----------------------------------------------------------------------------
-- Functions the dashboard calls
-- ----------------------------------------------------------------------------

-- The workspace's General channel, created on first use.
CREATE OR REPLACE FUNCTION public.fn_team_general(p_workspace_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF public.fn_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Forbidden: not a member of this workspace.' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_id FROM public.team_threads WHERE workspace_id = p_workspace_id AND kind = 'channel' AND name = 'General';
  IF v_id IS NULL THEN
    INSERT INTO public.team_threads (workspace_id, kind, name, created_by)
    VALUES (p_workspace_id, 'channel', 'General', auth.uid())
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.team_threads WHERE workspace_id = p_workspace_id AND kind = 'channel' AND name = 'General';
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

-- The caller's direct thread with a teammate, created on first use. Both must
-- be current members of the workspace.
CREATE OR REPLACE FUNCTION public.fn_team_open_direct(p_workspace_id UUID, p_agent_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me UUID := auth.uid();
  v_key TEXT;
  v_id UUID;
BEGIN
  IF public.fn_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Forbidden: not a member of this workspace.' USING ERRCODE = '42501';
  END IF;
  IF p_agent_id IS NULL OR p_agent_id = v_me THEN
    RAISE EXCEPTION 'Pick a teammate to message.' USING ERRCODE = '22023';
  END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM public.agents a WHERE a.id = p_agent_id AND a.workspace_id = p_workspace_id AND a.is_active IS NOT FALSE)
    OR EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.owner_id = p_agent_id)
  ) THEN
    RAISE EXCEPTION 'That person is not on this team.' USING ERRCODE = '42501';
  END IF;

  v_key := least(v_me::text, p_agent_id::text) || ':' || greatest(v_me::text, p_agent_id::text);
  SELECT id INTO v_id FROM public.team_threads WHERE workspace_id = p_workspace_id AND direct_key = v_key;
  IF v_id IS NULL THEN
    INSERT INTO public.team_threads (workspace_id, kind, direct_key, created_by)
    VALUES (p_workspace_id, 'direct', v_key, v_me)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.team_threads WHERE workspace_id = p_workspace_id AND direct_key = v_key;
    END IF;
  END IF;

  INSERT INTO public.team_thread_members (thread_id, agent_id, workspace_id, is_participant)
  VALUES (v_id, v_me, p_workspace_id, true), (v_id, p_agent_id, p_workspace_id, true)
  ON CONFLICT (thread_id, agent_id) DO UPDATE SET is_participant = true;
  RETURN v_id;
END;
$$;

-- The caller has read the thread up to now.
CREATE OR REPLACE FUNCTION public.fn_team_mark_read(p_thread_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.fn_team_can_see(p_thread_id) THEN
    RAISE EXCEPTION 'Forbidden.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.team_thread_members (thread_id, agent_id, workspace_id, last_read_at)
  SELECT p_thread_id, auth.uid(), t.workspace_id, now() FROM public.team_threads t WHERE t.id = p_thread_id
  ON CONFLICT (thread_id, agent_id) DO UPDATE SET last_read_at = now();
END;
$$;

-- Your own message, taken back. Nobody else's.
CREATE OR REPLACE FUNCTION public.fn_team_delete_message(p_message_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.team_messages
     SET deleted_at = now(), content = '…'
   WHERE id = p_message_id AND sender_id = auth.uid() AND deleted_at IS NULL
     AND public.fn_team_can_see(thread_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That message cannot be deleted.' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- The caller's threads in a workspace: the General channel, other channels
-- and their direct threads, with the other person, the last message and how
-- many messages from others came after their read marker.
CREATE OR REPLACE FUNCTION public.fn_team_inbox(p_workspace_id UUID)
RETURNS TABLE (
  thread_id UUID,
  kind TEXT,
  name TEXT,
  other_agent_id UUID,
  last_message_at TIMESTAMPTZ,
  last_message JSONB,
  unread INT,
  mentions_me INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH mine AS (
    SELECT t.* FROM public.team_threads t
    WHERE t.workspace_id = p_workspace_id
      AND public.fn_workspace_role(p_workspace_id) IS NOT NULL
      AND (t.kind = 'channel' OR EXISTS (
        SELECT 1 FROM public.team_thread_members m WHERE m.thread_id = t.id AND m.agent_id = auth.uid() AND m.is_participant))
  )
  SELECT
    t.id,
    t.kind,
    t.name,
    CASE WHEN t.kind = 'direct' THEN
      (SELECT m.agent_id FROM public.team_thread_members m WHERE m.thread_id = t.id AND m.agent_id <> auth.uid() AND m.is_participant LIMIT 1)
    END,
    t.last_message_at,
    (SELECT jsonb_build_object('content', tm.content, 'sender_id', tm.sender_id, 'created_at', tm.created_at, 'deleted', tm.deleted_at IS NOT NULL)
       FROM public.team_messages tm WHERE tm.thread_id = t.id ORDER BY tm.created_at DESC LIMIT 1),
    (SELECT count(*)::int FROM public.team_messages tm
      WHERE tm.thread_id = t.id AND tm.sender_id <> auth.uid() AND tm.deleted_at IS NULL
        AND tm.created_at > coalesce(
          (SELECT r.last_read_at FROM public.team_thread_members r WHERE r.thread_id = t.id AND r.agent_id = auth.uid()),
          -- A channel reader with no marker yet: only the last day counts as new.
          now() - interval '1 day')),
    (SELECT count(*)::int FROM public.team_messages tm
      WHERE tm.thread_id = t.id AND tm.sender_id <> auth.uid() AND tm.deleted_at IS NULL AND auth.uid() = ANY (tm.mentions)
        AND tm.created_at > coalesce(
          (SELECT r.last_read_at FROM public.team_thread_members r WHERE r.thread_id = t.id AND r.agent_id = auth.uid()),
          now() - interval '1 day'))
  FROM mine t
  ORDER BY t.kind = 'channel' DESC, t.last_message_at DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.fn_team_general(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_team_open_direct(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_team_mark_read(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_team_delete_message(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_team_inbox(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_team_message_defaults() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_team_general(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_team_open_direct(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_team_mark_read(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_team_delete_message(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_team_inbox(UUID) TO authenticated, service_role;

GRANT SELECT, INSERT ON public.team_messages TO authenticated;
GRANT SELECT ON public.team_threads, public.team_thread_members TO authenticated;

-- Live delivery to the dashboard.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'team_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.team_messages;
  END IF;
END;
$$;
