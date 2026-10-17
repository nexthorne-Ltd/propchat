-- ============================================================================
-- Teams and roles
--
-- Until now a workspace member was either an admin or not, and nothing
-- outside a few server actions looked at the difference: the inbox writes to
-- Supabase straight from the browser, so any member could do anything the
-- table policies allowed. This adds:
--
--   roles        owner, admin, agent, light_agent. A light agent can read
--                tickets and conversations and add internal notes, nothing
--                else. Enforced here, by triggers and policies, so it holds
--                for the old inbox, the ticket screens, server actions and
--                API routes alike.
--   deactivation agents.is_active. A deactivated agent keeps their history
--                but loses all access; their open tickets can be reassigned.
--   capacity     agents.max_open_tickets, respected by round-robin.
--   groups       ticket_group_members: agents belong to any number of groups.
--                A ticket in a group can only be assigned to a member of it,
--                and a group can hand out tickets round-robin.
--   presence     ticket_presence: who is viewing or replying to a ticket.
--
-- One capability matrix (fn_role_can) decides everything. src/lib/team/
-- permissions.ts mirrors it for the UI, and a test keeps the two equal.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Agent columns
-- ----------------------------------------------------------------------------

-- The role constraint has had different names in different environments.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.agents'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.agents DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.agents
  ADD CONSTRAINT agents_role_check CHECK (role IN ('owner', 'admin', 'agent', 'light_agent'));

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_open_tickets INTEGER
    CHECK (max_open_tickets IS NULL OR (max_open_tickets > 0 AND max_open_tickets <= 1000));

-- ----------------------------------------------------------------------------
-- 2. Who the caller is in a workspace, and what that lets them do
-- ----------------------------------------------------------------------------

-- 'owner' | 'admin' | 'agent' | 'light_agent', or NULL for non-members and
-- deactivated agents. Platform super admins act as admins.
CREATE OR REPLACE FUNCTION public.fn_workspace_role(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_workspace_id IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.owner_id = auth.uid()) THEN 'owner'
    ELSE coalesce(
      (SELECT a.role FROM public.agents a
        WHERE a.id = auth.uid() AND a.workspace_id = p_workspace_id AND a.is_active),
      (SELECT 'admin' FROM public.agents a WHERE a.id = auth.uid() AND a.is_super_admin AND a.is_active)
    )
  END;
$$;

-- The capability matrix. Keep in step with src/lib/team/permissions.ts.
-- Never NULL: no role (a non-member) has no capabilities.
CREATE OR REPLACE FUNCTION public.fn_role_has(p_role TEXT, p_capability TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_role IS NOT NULL AND CASE p_capability
    WHEN 'view'            THEN p_role IN ('owner', 'admin', 'agent', 'light_agent')
    WHEN 'add_note'        THEN p_role IN ('owner', 'admin', 'agent', 'light_agent')
    WHEN 'reply'           THEN p_role IN ('owner', 'admin', 'agent')
    WHEN 'edit_ticket'     THEN p_role IN ('owner', 'admin', 'agent')
    WHEN 'edit_content'    THEN p_role IN ('owner', 'admin', 'agent')
    WHEN 'manage_groups'   THEN p_role IN ('owner', 'admin')
    WHEN 'manage_team'     THEN p_role IN ('owner', 'admin')
    WHEN 'manage_settings' THEN p_role IN ('owner', 'admin')
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.fn_role_can(p_workspace_id UUID, p_capability TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.fn_role_has(public.fn_workspace_role(p_workspace_id), p_capability), false);
$$;

REVOKE EXECUTE ON FUNCTION public.fn_workspace_role(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_role_can(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_workspace_role(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_role_can(UUID, TEXT) TO authenticated, service_role;

-- True when a signed-in user (not the service role, not a trigger acting on
-- someone's behalf) issued the statement now running.
CREATE OR REPLACE FUNCTION public.fn_is_direct_user_write()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT auth.uid() IS NOT NULL
     AND coalesce(auth.role(), '') <> 'service_role'
     AND pg_trigger_depth() <= 1;
$$;

-- ----------------------------------------------------------------------------
-- 3. Deactivated agents lose membership everywhere
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_user_workspace_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT workspace_id FROM public.agents WHERE id = auth.uid() AND workspace_id IS NOT NULL AND is_active
  UNION
  SELECT id FROM public.workspaces WHERE owner_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.fn_is_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.fn_workspace_role(p_workspace_id) IS NOT NULL OR public.is_current_user_super_admin();
$$;

CREATE OR REPLACE FUNCTION public.fn_is_workspace_admin(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.fn_role_can(p_workspace_id, 'manage_settings') OR public.is_current_user_super_admin();
$$;

CREATE OR REPLACE FUNCTION public.fn_ticket_member(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.fn_workspace_role(p_workspace_id) IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.fn_ticket_admin(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.fn_role_can(p_workspace_id, 'manage_groups');
$$;

-- ----------------------------------------------------------------------------
-- 4. Agents may not grant themselves roles, capacity or reactivation
--
-- Extends the H-4 guard: a user may still link themselves as owner of a
-- workspace they own (onboarding) and edit their name, avatar and status.
-- Everything else about membership is done by an admin through the team
-- functions below, or by trusted server code with the service role.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_guard_agent_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_owns BOOLEAN;
BEGIN
  IF v_uid IS NULL OR coalesce(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;
  -- The owner role belongs to the workspace's owner and nobody else.
  -- (Onboarding creates the founder's row as owner before the workspace exists.)
  IF NEW.role = 'owner' AND NEW.workspace_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.role IS DISTINCT FROM 'owner' OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id)
     AND NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = NEW.workspace_id AND owner_id = NEW.id) THEN
    RAISE EXCEPTION 'Forbidden: only the workspace owner has the owner role.' USING ERRCODE = '42501';
  END IF;
  -- The team functions below have already checked the caller.
  IF coalesce(current_setting('zentry.team_change', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.agents WHERE id = v_uid AND is_super_admin AND is_active) THEN
    RETURN NEW;
  END IF;

  v_owns := NEW.workspace_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.workspaces WHERE id = NEW.workspace_id AND owner_id = v_uid);

  IF TG_OP = 'INSERT' THEN
    IF NEW.workspace_id IS NOT NULL AND NOT v_owns THEN
      RAISE EXCEPTION 'Forbidden: workspace membership and roles are granted by a workspace admin.' USING ERRCODE = '42501';
    END IF;
    IF NOT NEW.is_active OR NEW.max_open_tickets IS NOT NULL THEN
      RAISE EXCEPTION 'Forbidden: only an admin can set an agent''s capacity or status.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id AND NEW.workspace_id IS NOT NULL AND NOT v_owns)
     OR (NEW.role IS DISTINCT FROM OLD.role AND NEW.workspace_id IS NOT NULL AND NOT v_owns) THEN
    RAISE EXCEPTION 'Forbidden: workspace membership and roles are granted by a workspace admin.' USING ERRCODE = '42501';
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
     OR (NEW.max_open_tickets IS DISTINCT FROM OLD.max_open_tickets AND NOT v_owns) THEN
    RAISE EXCEPTION 'Forbidden: only an admin can change an agent''s capacity or deactivate them.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_agent_membership ON public.agents;
CREATE TRIGGER trg_guard_agent_membership
  BEFORE INSERT OR UPDATE OF workspace_id, role, is_active, deactivated_at, max_open_tickets ON public.agents
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_agent_membership();

-- ----------------------------------------------------------------------------
-- 5. Light agents: read and add internal notes, nothing else
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_guard_message_permissions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws UUID;
  v_role TEXT;
  v_row public.messages := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  IF NOT public.fn_is_direct_user_write() THEN
    RETURN v_row;
  END IF;
  SELECT workspace_id INTO v_ws FROM public.conversations WHERE id = v_row.conversation_id;
  v_role := public.fn_workspace_role(v_ws);
  IF v_role IS NULL THEN
    -- Not a member: the table policies decide (and refuse).
    RETURN v_row;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Nobody writes as somebody else.
    IF NEW.sender_type = 'agent' AND NEW.sender_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Forbidden: messages are sent as yourself.' USING ERRCODE = '42501';
    END IF;
    IF v_role = 'light_agent' AND NOT (coalesce(NEW.is_internal, false) AND NEW.sender_type = 'agent') THEN
      RAISE EXCEPTION 'Forbidden: light agents can only add internal notes.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF v_role = 'light_agent' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Forbidden: light agents cannot delete messages.' USING ERRCODE = '42501';
    END IF;
    -- Read and delivery receipts only.
    IF NEW.content IS DISTINCT FROM OLD.content
       OR NEW.is_internal IS DISTINCT FROM OLD.is_internal
       OR NEW.sender_type IS DISTINCT FROM OLD.sender_type
       OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
       OR NEW.attachment_url IS DISTINCT FROM OLD.attachment_url
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
       OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
      RAISE EXCEPTION 'Forbidden: light agents cannot edit messages.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN v_row;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_message_permissions ON public.messages;
CREATE TRIGGER trg_guard_message_permissions
  BEFORE INSERT OR UPDATE OR DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_message_permissions();

-- Conversations: a light agent may not change who has it, its state, or move
-- it. Bookkeeping the inbox does when anyone writes a note (updated_at) and
-- per-viewer preferences in channel_metadata stay allowed.
CREATE OR REPLACE FUNCTION public.fn_guard_conversation_permissions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
BEGIN
  IF NOT public.fn_is_direct_user_write() OR public.fn_workspace_role(v_ws) IS DISTINCT FROM 'light_agent' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP <> 'UPDATE'
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
     OR NEW.priority IS DISTINCT FROM OLD.priority
     OR NEW.tags IS DISTINCT FROM OLD.tags
     OR NEW.ai_mode IS DISTINCT FROM OLD.ai_mode
     OR NEW.visitor_id IS DISTINCT FROM OLD.visitor_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.current_ticket_id IS DISTINCT FROM OLD.current_ticket_id
     OR NEW.snoozed_until IS DISTINCT FROM OLD.snoozed_until
     OR NEW.merged_into IS DISTINCT FROM OLD.merged_into THEN
    RAISE EXCEPTION 'Forbidden: light agents can view conversations and add internal notes only.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_conversation_permissions ON public.conversations;
CREATE TRIGGER trg_guard_conversation_permissions
  BEFORE INSERT OR UPDATE OR DELETE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_conversation_permissions();

-- Workspace content: only roles with `edit_content` (or more) write it.
CREATE OR REPLACE FUNCTION public.fn_guard_content_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws UUID := ((to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)) ->> 'workspace_id')::uuid;
  v_role TEXT;
BEGIN
  IF NOT public.fn_is_direct_user_write() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_role := public.fn_workspace_role(v_ws);
  IF v_role IS NOT NULL AND NOT public.fn_role_has(v_role, TG_ARGV[0]) THEN
    RAISE EXCEPTION 'Forbidden: your role (%) cannot change %.', replace(v_role, '_', ' '), TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('visitors', 'edit_content'),
      ('articles', 'edit_content'),
      ('help_sections', 'edit_content'),
      ('knowledge_notes', 'edit_content'),
      ('unanswered_questions', 'edit_content'),
      ('canned_responses', 'edit_content')
    ) AS v(tbl, capability)
  LOOP
    IF to_regclass('public.' || t.tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_guard_content_write ON public.%I', t.tbl);
      EXECUTE format(
        'CREATE TRIGGER trg_guard_content_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.fn_guard_content_write(%L)',
        t.tbl, t.capability
      );
    END IF;
  END LOOP;
END $$;

-- Tickets: editing fields needs `edit_ticket`. Notes from light agents still
-- touch the ticket through the message triggers, which run one level deeper
-- and are not the user's own statement.
DROP POLICY IF EXISTS tickets_update ON public.tickets;
CREATE POLICY tickets_update ON public.tickets FOR UPDATE TO authenticated
  USING (public.fn_role_can(workspace_id, 'edit_ticket'))
  WITH CHECK (public.fn_role_can(workspace_id, 'edit_ticket'));

CREATE OR REPLACE FUNCTION public.fn_guard_ticket_edit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Merge and team functions run with definer rights, so RLS does not see
  -- them; check the caller here too.
  IF public.fn_is_direct_user_write() AND NOT public.fn_role_can(NEW.workspace_id, 'edit_ticket') THEN
    RAISE EXCEPTION 'Forbidden: your role cannot change tickets.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_a_guard_edit ON public.tickets;
CREATE TRIGGER trg_ticket_a_guard_edit
  BEFORE UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_ticket_edit();

-- ----------------------------------------------------------------------------
-- 6. Groups: membership and round-robin
-- ----------------------------------------------------------------------------

ALTER TABLE public.ticket_groups
  ADD COLUMN IF NOT EXISTS round_robin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rr_last_agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.ticket_group_members (
  group_id     UUID NOT NULL REFERENCES public.ticket_groups(id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, agent_id)
);
CREATE INDEX IF NOT EXISTS ticket_group_members_agent ON public.ticket_group_members (agent_id);

-- A membership row must not join a group to an agent of another workspace.
CREATE OR REPLACE FUNCTION public.fn_group_member_same_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT workspace_id INTO NEW.workspace_id FROM public.ticket_groups WHERE id = NEW.group_id;
  IF NOT EXISTS (SELECT 1 FROM public.agents WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'That agent is not in this workspace.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_member_same_workspace ON public.ticket_group_members;
CREATE TRIGGER trg_group_member_same_workspace
  BEFORE INSERT OR UPDATE ON public.ticket_group_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_group_member_same_workspace();

ALTER TABLE public.ticket_group_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_group_members_select ON public.ticket_group_members;
CREATE POLICY ticket_group_members_select ON public.ticket_group_members FOR SELECT TO authenticated
  USING (public.fn_ticket_member(workspace_id));
DROP POLICY IF EXISTS ticket_group_members_write ON public.ticket_group_members;
CREATE POLICY ticket_group_members_write ON public.ticket_group_members FOR ALL TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_groups'))
  WITH CHECK (public.fn_role_can(workspace_id, 'manage_groups'));

-- Who can take tickets at all: active, not a light agent.
CREATE OR REPLACE FUNCTION public.fn_agent_assignable(p_agent_id UUID, p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agents
     WHERE id = p_agent_id AND workspace_id = p_workspace_id AND is_active AND role <> 'light_agent'
  );
$$;

-- Tickets that count against an agent's capacity: the ones waiting on them.
CREATE OR REPLACE FUNCTION public.fn_agent_open_tickets(p_agent_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::int FROM public.tickets WHERE assignee_id = p_agent_id AND status IN ('new', 'open');
$$;

-- The next member of a group to receive a ticket: online, active, not a light
-- agent, under capacity; the one after whoever got the last ticket, wrapping
-- around. NULL when nobody qualifies (the ticket then waits unassigned).
-- Away counts as not available: it means "not taking new work right now".
CREATE OR REPLACE FUNCTION public.fn_next_round_robin_agent(p_group_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group public.ticket_groups;
  v_next UUID;
BEGIN
  -- Serialises concurrent assignments within a group.
  SELECT * INTO v_group FROM public.ticket_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  WITH eligible AS (
    SELECT a.id
      FROM public.ticket_group_members m
      JOIN public.agents a ON a.id = m.agent_id
     WHERE m.group_id = p_group_id
       AND a.workspace_id = v_group.workspace_id
       AND a.is_active
       AND a.role <> 'light_agent'
       AND a.status = 'online'
       AND (a.max_open_tickets IS NULL OR public.fn_agent_open_tickets(a.id) < a.max_open_tickets)
  )
  SELECT id INTO v_next FROM eligible
   ORDER BY (v_group.rr_last_agent_id IS NOT NULL AND id <= v_group.rr_last_agent_id), id
   LIMIT 1;

  IF v_next IS NOT NULL THEN
    UPDATE public.ticket_groups SET rr_last_agent_id = v_next WHERE id = p_group_id;
  END IF;
  RETURN v_next;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_next_round_robin_agent(UUID) FROM PUBLIC, anon, authenticated;

-- Assignment rules, before the ticket lifecycle trigger so that an assignment
-- made here still moves a new ticket to open.
CREATE OR REPLACE FUNCTION public.fn_ticket_assignment_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_changed BOOLEAN := TG_OP = 'INSERT' OR NEW.group_id IS DISTINCT FROM OLD.group_id;
  v_assignee_changed BOOLEAN := TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id;
  v_member BOOLEAN;
  v_direct BOOLEAN := public.fn_is_direct_user_write();
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'closed' THEN
    RETURN NEW; -- the lifecycle trigger refuses it
  END IF;

  IF NEW.assignee_id IS NOT NULL AND v_assignee_changed
     AND NOT public.fn_agent_assignable(NEW.assignee_id, NEW.workspace_id) THEN
    RAISE EXCEPTION 'That person cannot be assigned tickets (deactivated, a light agent, or not in this workspace).'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.group_id IS NOT NULL AND NEW.assignee_id IS NOT NULL THEN
    v_member := EXISTS (SELECT 1 FROM public.ticket_group_members WHERE group_id = NEW.group_id AND agent_id = NEW.assignee_id);
    IF NOT v_member THEN
      IF v_group_changed AND NOT v_assignee_changed THEN
        -- Moved to a group its assignee is not in: back to the group's queue.
        NEW.assignee_id := NULL;
      ELSIF v_direct THEN
        RAISE EXCEPTION 'That agent is not in the ticket''s group. Change the group or pick one of its members.'
          USING ERRCODE = '23514';
      END IF;
      -- Writes from the conversation sync (old inbox, bot handover) are kept:
      -- they predate groups, and refusing them would break the chat.
    END IF;
  END IF;

  IF NEW.group_id IS NOT NULL AND NEW.assignee_id IS NULL AND v_group_changed
     AND NEW.status IN ('new', 'open', 'pending', 'on_hold')
     AND EXISTS (SELECT 1 FROM public.ticket_groups WHERE id = NEW.group_id AND round_robin) THEN
    NEW.assignee_id := public.fn_next_round_robin_agent(NEW.group_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_assignment_rules ON public.tickets;
CREATE TRIGGER trg_ticket_assignment_rules
  BEFORE INSERT OR UPDATE OF group_id, assignee_id ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ticket_assignment_rules();

-- Conversation-level auto-assignment (new chats) now skips light agents,
-- deactivated agents and anyone at capacity.
CREATE OR REPLACE FUNCTION public.fn_auto_assign_conversation_on_create()
RETURNS TRIGGER AS $$
DECLARE
  v_auto_assign jsonb;
  v_enabled boolean;
  v_chosen_agent_id uuid;
BEGIN
  IF NEW.assigned_agent_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS NULL AND NEW.visitor_id IS NOT NULL THEN
    SELECT workspace_id INTO NEW.workspace_id FROM public.visitors WHERE id = NEW.visitor_id;
  END IF;
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT auto_assignment INTO v_auto_assign FROM public.workspaces WHERE id = NEW.workspace_id;
  v_enabled := COALESCE((v_auto_assign->>'enabled')::boolean, true);
  IF NOT v_enabled THEN
    RETURN NEW;
  END IF;

  SELECT a.id INTO v_chosen_agent_id
    FROM public.agents a
   WHERE a.workspace_id = NEW.workspace_id
     AND a.status = 'online'
     AND a.is_active
     AND a.role <> 'light_agent'
     AND (a.max_open_tickets IS NULL OR public.fn_agent_open_tickets(a.id) < a.max_open_tickets)
   ORDER BY public.fn_agent_open_tickets(a.id) ASC, a.created_at ASC
   LIMIT 1;

  IF v_chosen_agent_id IS NOT NULL THEN
    NEW.assigned_agent_id := v_chosen_agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 7. Team management, checked here so no path can skip the rules
--
-- Rules: owners and admins manage the team. Nobody changes their own role or
-- deactivates themselves. The owner's membership is never changed here.
-- Only the owner grants the admin role or manages other admins.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_assert_can_manage_member(p_workspace_id UUID, p_agent_id UUID)
RETURNS public.agents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller TEXT := public.fn_workspace_role(p_workspace_id);
  v_target public.agents;
BEGIN
  IF NOT public.fn_role_has(v_caller, 'manage_team') THEN
    RAISE EXCEPTION 'Forbidden: only owners and admins manage the team.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_target FROM public.agents WHERE id = p_agent_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That person is not in this workspace.' USING ERRCODE = '42501';
  END IF;
  IF p_agent_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot change your own role or deactivate yourself.' USING ERRCODE = '42501';
  END IF;
  IF v_target.role = 'owner'
     OR EXISTS (SELECT 1 FROM public.workspaces WHERE id = p_workspace_id AND owner_id = p_agent_id) THEN
    RAISE EXCEPTION 'The workspace owner cannot be changed here.' USING ERRCODE = '42501';
  END IF;
  IF v_target.role = 'admin' AND v_caller IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the owner can manage admins.' USING ERRCODE = '42501';
  END IF;
  RETURN v_target;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_member_role(p_workspace_id UUID, p_agent_id UUID, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_assert_can_manage_member(p_workspace_id, p_agent_id);
  IF p_role NOT IN ('admin', 'agent', 'light_agent') THEN
    RAISE EXCEPTION 'Choose admin, agent or light agent.' USING ERRCODE = '22023';
  END IF;
  IF p_role = 'admin' AND public.fn_workspace_role(p_workspace_id) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the owner can make someone an admin.' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('zentry.team_change', 'on', true);
  UPDATE public.agents SET role = p_role WHERE id = p_agent_id AND workspace_id = p_workspace_id;
  IF p_role = 'light_agent' THEN
    -- Light agents cannot take tickets; their current ones go back to the queue.
    UPDATE public.tickets SET assignee_id = NULL
     WHERE workspace_id = p_workspace_id AND assignee_id = p_agent_id AND status NOT IN ('solved', 'closed');
  END IF;
  PERFORM set_config('zentry.team_change', '', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_member_capacity(p_workspace_id UUID, p_agent_id UUID, p_max_open INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Capacity is a workload setting: admins set it for anyone, including themselves.
  IF NOT public.fn_role_can(p_workspace_id, 'manage_team') THEN
    RAISE EXCEPTION 'Forbidden: only owners and admins set capacity.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.agents WHERE id = p_agent_id AND workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'That person is not in this workspace.' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('zentry.team_change', 'on', true);
  UPDATE public.agents SET max_open_tickets = p_max_open WHERE id = p_agent_id AND workspace_id = p_workspace_id;
  PERFORM set_config('zentry.team_change', '', true);
END;
$$;

-- Deactivates an agent and moves their open tickets:
--   p_mode 'agent'      to p_reassign_to (an active, non-light member)
--   p_mode 'round_robin' back to each ticket's group (round-robin if enabled)
--   p_mode 'unassign'   to nobody
-- Returns how many tickets moved.
CREATE OR REPLACE FUNCTION public.fn_deactivate_member(
  p_workspace_id UUID, p_agent_id UUID, p_mode TEXT, p_reassign_to UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_moved INTEGER := 0;
  t RECORD;
  v_prev TEXT;
BEGIN
  PERFORM public.fn_assert_can_manage_member(p_workspace_id, p_agent_id);
  IF p_mode NOT IN ('agent', 'round_robin', 'unassign') THEN
    RAISE EXCEPTION 'Choose how to reassign their tickets.' USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'agent' AND (p_reassign_to IS NULL OR p_reassign_to = p_agent_id
                           OR NOT public.fn_agent_assignable(p_reassign_to, p_workspace_id)) THEN
    RAISE EXCEPTION 'Pick an active agent to take over their tickets.' USING ERRCODE = '22023';
  END IF;

  v_prev := public.fn_ticket_set_actor('agent', auth.uid());
  PERFORM set_config('zentry.team_change', 'on', true);
  UPDATE public.agents
     SET is_active = false, deactivated_at = now(), status = 'offline'
   WHERE id = p_agent_id AND workspace_id = p_workspace_id;

  FOR t IN
    SELECT id, group_id FROM public.tickets
     WHERE workspace_id = p_workspace_id AND assignee_id = p_agent_id AND status NOT IN ('solved', 'closed')
     ORDER BY number
  LOOP
    IF p_mode = 'agent' THEN
      -- The new assignee may not be in the ticket's group; keep the person and
      -- drop the group rather than leave the ticket stranded.
      UPDATE public.tickets
         SET assignee_id = p_reassign_to,
             group_id = CASE WHEN group_id IS NULL OR EXISTS (
                               SELECT 1 FROM public.ticket_group_members
                                WHERE group_id = tickets.group_id AND agent_id = p_reassign_to)
                             THEN group_id ELSE NULL END
       WHERE id = t.id;
    ELSE
      UPDATE public.tickets SET assignee_id = NULL WHERE id = t.id;
      IF p_mode = 'round_robin' AND t.group_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.ticket_groups WHERE id = t.group_id AND round_robin) THEN
        UPDATE public.tickets SET assignee_id = public.fn_next_round_robin_agent(t.group_id) WHERE id = t.id;
      END IF;
    END IF;
    v_moved := v_moved + 1;
  END LOOP;

  PERFORM set_config('zentry.team_change', '', true);
  PERFORM public.fn_ticket_restore_actor(v_prev);
  RETURN v_moved;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_reactivate_member(p_workspace_id UUID, p_agent_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.fn_assert_can_manage_member(p_workspace_id, p_agent_id);
  PERFORM set_config('zentry.team_change', 'on', true);
  UPDATE public.agents SET is_active = true, deactivated_at = NULL WHERE id = p_agent_id AND workspace_id = p_workspace_id;
  PERFORM set_config('zentry.team_change', '', true);
END;
$$;

-- Replaces a group's members in one step.
CREATE OR REPLACE FUNCTION public.fn_set_group_members(p_group_id UUID, p_agent_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws UUID;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.ticket_groups WHERE id = p_group_id;
  IF v_ws IS NULL OR NOT public.fn_role_can(v_ws, 'manage_groups') THEN
    RAISE EXCEPTION 'Forbidden: only owners and admins manage groups.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(coalesce(p_agent_ids, '{}')) AS x(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.agents a WHERE a.id = x.id AND a.workspace_id = v_ws)
  ) THEN
    RAISE EXCEPTION 'Every member must be in this workspace.' USING ERRCODE = '23514';
  END IF;
  DELETE FROM public.ticket_group_members WHERE group_id = p_group_id AND NOT (agent_id = ANY (coalesce(p_agent_ids, '{}')));
  INSERT INTO public.ticket_group_members (group_id, agent_id, workspace_id)
  SELECT p_group_id, x.id, v_ws FROM unnest(coalesce(p_agent_ids, '{}')) AS x(id)
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_assert_can_manage_member(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_set_member_role(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_set_member_capacity(UUID, UUID, INTEGER) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_deactivate_member(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_reactivate_member(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_set_group_members(UUID, UUID[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_agent_open_tickets(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_agent_assignable(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_set_member_role(UUID, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_set_member_capacity(UUID, UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_deactivate_member(UUID, UUID, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_reactivate_member(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_set_group_members(UUID, UUID[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_open_tickets(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_assignable(UUID, UUID) TO authenticated, service_role;

-- Merging needs the right to edit tickets, not just to see them.
DO $$
BEGIN
  -- fn_merge_tickets checks fn_ticket_member; the ticket edit guard above now
  -- refuses its updates for roles without edit_ticket, so a light agent's
  -- merge fails before anything moves.
  NULL;
END $$;

-- ----------------------------------------------------------------------------
-- 8. Presence: who is looking at or replying to a ticket
--
-- A row per agent per ticket, refreshed by the ticket screen every few
-- seconds. Rows older than a minute are stale and ignored. Kept in the
-- database rather than a broadcast channel so row level security decides who
-- can see it, and nobody can pose as someone else.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ticket_presence (
  ticket_id    UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  state        TEXT NOT NULL DEFAULT 'viewing' CHECK (state IN ('viewing', 'replying', 'noting')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, agent_id)
);

CREATE OR REPLACE FUNCTION public.fn_ticket_presence_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT workspace_id INTO NEW.workspace_id FROM public.tickets WHERE id = NEW.ticket_id;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_presence_scope ON public.ticket_presence;
CREATE TRIGGER trg_ticket_presence_scope
  BEFORE INSERT OR UPDATE ON public.ticket_presence
  FOR EACH ROW EXECUTE FUNCTION public.fn_ticket_presence_scope();

ALTER TABLE public.ticket_presence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_presence_select ON public.ticket_presence;
CREATE POLICY ticket_presence_select ON public.ticket_presence FOR SELECT TO authenticated
  USING (public.fn_ticket_member(workspace_id));
DROP POLICY IF EXISTS ticket_presence_write ON public.ticket_presence;
CREATE POLICY ticket_presence_write ON public.ticket_presence FOR ALL TO authenticated
  USING (agent_id = auth.uid() AND public.fn_ticket_member(workspace_id))
  WITH CHECK (
    agent_id = auth.uid() AND public.fn_ticket_member(workspace_id)
    -- Replying is for those who may reply.
    AND (state <> 'replying' OR public.fn_role_can(workspace_id, 'reply'))
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ticket_presence'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ticket_presence;
  END IF;
END $$;
