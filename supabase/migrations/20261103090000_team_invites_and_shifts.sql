-- Team invitations from the workspace's own address, and member shifts.
--
-- 1. Invitations. Inviting a member used Supabase Auth's invite mail: it came
--    from the platform's generic sender, not from the business the person is
--    joining, and the agent row was created before they had agreed to
--    anything. Now an invitation is a row here; the email goes out through the
--    workspace's own SMTP with a one-time link, and the person sets their own
--    password on /invite/<token>. Only the SHA-256 of the token is stored. The
--    agent row is created when they accept, not before.
--
-- 2. Shifts. A member can have weekly shift hours (in the workspace's
--    timezone). While anyone's shift is running, team emails (handover, a
--    customer waiting) go only to the members on shift. Members without shift
--    hours are not limited. The choice of recipients is made in
--    src/lib/team/shifts.ts; the hours live here.
--
-- Both tables are written only by server actions (service role) and by
-- fn_set_member_shifts, which checks the caller's role itself.

/* ── Invitations ────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS public.workspace_invitations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email        TEXT NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  name         TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 120),
  role         TEXT NOT NULL CHECK (role IN ('admin', 'agent', 'light_agent')),
  group_ids    UUID[] NOT NULL DEFAULT '{}',
  token_hash   TEXT NOT NULL UNIQUE,
  invited_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  last_sent_at TIMESTAMPTZ,
  send_error   TEXT,
  accepted_at  TIMESTAMPTZ,
  accepted_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at   TIMESTAMPTZ
);

-- One open invitation per person per workspace: inviting again resends it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_invitations_open
  ON public.workspace_invitations (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_invitations FROM anon;

-- Readable by the people who manage the team; written only by the server.
-- token_hash is useless without the token, but it is not shown anyway.
DROP POLICY IF EXISTS workspace_invitations_select ON public.workspace_invitations;
CREATE POLICY workspace_invitations_select ON public.workspace_invitations FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'manage_team'));

/* ── Shifts ─────────────────────────────────────────────────────────────── */

-- weekday: 0 = Sunday … 6 = Saturday. Minutes from midnight, workspace time.
-- An end at or before the start means the shift runs past midnight.
CREATE TABLE IF NOT EXISTS public.agent_shifts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  weekday      SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   SMALLINT NOT NULL CHECK (end_minute BETWEEN 0 AND 1439),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_shifts_not_empty CHECK (start_minute <> end_minute)
);

CREATE INDEX IF NOT EXISTS idx_agent_shifts_workspace ON public.agent_shifts (workspace_id, agent_id);

ALTER TABLE public.agent_shifts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_shifts FROM anon;

-- Everyone on the team can see who is on shift; changes go through the function below.
DROP POLICY IF EXISTS agent_shifts_select ON public.agent_shifts;
CREATE POLICY agent_shifts_select ON public.agent_shifts FOR SELECT TO authenticated
  USING (public.fn_role_can(workspace_id, 'view'));

-- Replaces one member's weekly shifts. p_shifts:
--   [{ "weekday": 1, "start_minute": 540, "end_minute": 1020 }, ...]
-- An empty array clears them (the member then gets team emails at any time).
CREATE OR REPLACE FUNCTION public.fn_set_member_shifts(
  p_workspace_id UUID,
  p_agent_id UUID,
  p_shifts JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.fn_role_can(p_workspace_id, 'manage_team') THEN
    RAISE EXCEPTION 'Forbidden: only owners and admins set shifts.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agents a
     WHERE a.id = p_agent_id AND a.workspace_id = p_workspace_id
  ) AND NOT EXISTS (
    SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace_id AND w.owner_id = p_agent_id
  ) THEN
    RAISE EXCEPTION 'That person is not on this team.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(coalesce(p_shifts, '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(p_shifts, '[]'::jsonb)) > 21 THEN
    RAISE EXCEPTION 'Shifts must be a list of at most 21 entries.' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.agent_shifts WHERE workspace_id = p_workspace_id AND agent_id = p_agent_id;

  INSERT INTO public.agent_shifts (workspace_id, agent_id, weekday, start_minute, end_minute)
  SELECT p_workspace_id, p_agent_id,
         (s ->> 'weekday')::smallint,
         (s ->> 'start_minute')::smallint,
         (s ->> 'end_minute')::smallint
    FROM jsonb_array_elements(coalesce(p_shifts, '[]'::jsonb)) AS s;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_set_member_shifts(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_set_member_shifts(UUID, UUID, JSONB) TO authenticated, service_role;

/* ── Team email log ─────────────────────────────────────────────────────── */

-- Every team alert sent or attempted. Used to avoid emailing the same person
-- about the same conversation more than once in a few minutes (a customer who
-- sends five lines in a row is one alert), and to see why an alert failed.
-- Service role only: no policy.
CREATE TABLE IF NOT EXISTS public.team_email_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
  agent_id        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email           TEXT NOT NULL,
  event           TEXT NOT NULL CHECK (event IN ('handover', 'customer_reply')),
  status          TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_email_log_recent
  ON public.team_email_log (conversation_id, agent_id, created_at DESC);

ALTER TABLE public.team_email_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_email_log FROM anon, authenticated;
