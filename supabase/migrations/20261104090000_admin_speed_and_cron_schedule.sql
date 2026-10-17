-- Admin speed, and the cron jobs nothing was running.
--
-- 1. fn_admin_workspaces_table. The super-admin Workspaces page loaded every
--    workspace (select *, secrets included), every agent and every ticket of
--    the last 30 days into the server on each page view, then filtered,
--    sorted and paged in memory. PostgREST also caps a response at 1000 rows,
--    so past that the counts were silently wrong. This does the filter, sort,
--    counts and page in one query. Service role only: the action checks
--    platform_access before calling it.
--
-- 2. Cron schedule. vercel.json only ran two jobs, once a day (a Hobby plan
--    limit), so SLA timers, automations, social polling, customer unread
--    emails, domain verification and outbound retries did not run on their
--    own. pg_cron calls the app's /api/cron/* routes through pg_net instead,
--    on any Vercel plan. The app URL and CRON_SECRET are read from Supabase
--    Vault (secrets 'zentry_app_url' and 'zentry_cron_secret'); until both
--    exist the jobs do nothing, so applying this migration is safe before
--    they are set.

/* ── 1. Workspaces table ────────────────────────────────────────────────── */

CREATE OR REPLACE FUNCTION public.fn_admin_workspaces_table(
  p_search TEXT DEFAULT '',
  p_status TEXT DEFAULT 'all',
  p_plan TEXT DEFAULT 'all',
  p_channel TEXT DEFAULT 'all',
  p_sort TEXT DEFAULT 'created_at',
  p_order TEXT DEFAULT 'desc',
  p_limit INT DEFAULT 15,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  website_url TEXT,
  is_suspended BOOLEAN,
  suspended_at TIMESTAMPTZ,
  suspension_reason TEXT,
  deleted_at TIMESTAMPTZ,
  plan TEXT,
  brand_color TEXT,
  logo_url TEXT,
  owner_email TEXT,
  agents_count INT,
  tickets_30d_count INT,
  connected_channels TEXT[],
  last_activity_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  total_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH q AS (
    SELECT '%' || replace(replace(replace(coalesce(btrim(p_search), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pattern,
           coalesce(btrim(p_search), '') <> '' AS searching
  ),
  base AS (
    SELECT
      w.id,
      w.name,
      w.website_url,
      coalesce(w.is_suspended, false) AS is_suspended,
      w.suspended_at,
      w.suspension_reason,
      w.deleted_at,
      coalesce(w.plan, 'free') AS plan,
      coalesce(w.brand_color, '#2563eb') AS brand_color,
      w.logo_url,
      (SELECT a.email FROM public.agents a WHERE a.id = w.owner_id) AS owner_email,
      (SELECT count(*) FROM public.agents a WHERE a.workspace_id = w.id)::int AS agents_count,
      (SELECT count(*) FROM public.tickets t
        WHERE t.workspace_id = w.id AND t.created_at >= now() - interval '30 days')::int AS tickets_30d_count,
      ARRAY(
        SELECT DISTINCT c.channel::text FROM public.channel_connections c
         WHERE c.workspace_id = w.id AND c.status <> 'disconnected'
      ) AS channels,
      coalesce(w.updated_at, w.created_at) AS last_activity_at,
      w.created_at
    FROM public.workspaces w
    WHERE w.deleted_at IS NULL
  ),
  filtered AS (
    SELECT b.*
      FROM base b, q
     WHERE (NOT q.searching
            OR b.name ILIKE q.pattern
            OR b.website_url ILIKE q.pattern
            OR b.owner_email ILIKE q.pattern
            OR b.id::text ILIKE q.pattern)
       AND (p_status = 'all' OR (p_status = 'suspended') = b.is_suspended)
       AND (p_plan = 'all' OR lower(b.plan) = lower(p_plan))
       AND (p_channel = 'all' OR p_channel = 'chat' OR p_channel = ANY (b.channels))
  )
  SELECT f.id, f.name, f.website_url, f.is_suspended, f.suspended_at, f.suspension_reason, f.deleted_at,
         f.plan, f.brand_color, f.logo_url, f.owner_email, f.agents_count, f.tickets_30d_count,
         f.channels, f.last_activity_at, f.created_at,
         count(*) OVER () AS total_count
    FROM filtered f
   ORDER BY
     CASE WHEN p_sort = 'name' AND p_order = 'asc' THEN lower(f.name) END ASC,
     CASE WHEN p_sort = 'name' AND p_order <> 'asc' THEN lower(f.name) END DESC,
     CASE WHEN p_sort = 'tickets_30d_count' AND p_order = 'asc' THEN f.tickets_30d_count END ASC,
     CASE WHEN p_sort = 'tickets_30d_count' AND p_order <> 'asc' THEN f.tickets_30d_count END DESC,
     CASE WHEN p_sort = 'agents_count' AND p_order = 'asc' THEN f.agents_count END ASC,
     CASE WHEN p_sort = 'agents_count' AND p_order <> 'asc' THEN f.agents_count END DESC,
     CASE WHEN p_sort = 'last_activity_at' AND p_order = 'asc' THEN f.last_activity_at END ASC,
     CASE WHEN p_sort = 'last_activity_at' AND p_order <> 'asc' THEN f.last_activity_at END DESC,
     CASE WHEN p_order = 'asc' THEN f.created_at END ASC,
     f.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 15), 200))
  OFFSET greatest(0, coalesce(p_offset, 0));
$$;

REVOKE EXECUTE ON FUNCTION public.fn_admin_workspaces_table(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_admin_workspaces_table(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT) TO service_role;

-- The counts above and the dashboard's visitor list lean on these.
CREATE INDEX IF NOT EXISTS idx_tickets_workspace_created ON public.tickets (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON public.agents (workspace_id);
CREATE INDEX IF NOT EXISTS idx_visitors_workspace_last_seen ON public.visitors (workspace_id, last_seen DESC);

/* ── 2. Cron schedule ───────────────────────────────────────────────────── */

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Calls one /api/cron route with the shared secret. Does nothing (and says
-- so in the Postgres log) until the two Vault secrets exist.
CREATE OR REPLACE FUNCTION public.fn_call_app_cron(p_path TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url TEXT;
  v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'zentry_app_url' LIMIT 1;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'zentry_cron_secret' LIMIT 1;
  IF coalesce(v_url, '') = '' OR coalesce(v_secret, '') = '' THEN
    RAISE LOG 'fn_call_app_cron(%): vault secrets zentry_app_url / zentry_cron_secret are not set', p_path;
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := rtrim(v_url, '/') || p_path,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_call_app_cron(TEXT) FROM PUBLIC, anon, authenticated;

-- (Re)schedule by name, so running this migration twice changes nothing.
DO $$
DECLARE
  j RECORD;
BEGIN
  FOR j IN
    SELECT * FROM (VALUES
      ('zentry-sla',                  '*/5 * * * *',  '/api/cron/sla'),
      ('zentry-run-automations',      '7 * * * *',    '/api/cron/run-automations'),
      ('zentry-channel-outbound',     '*/2 * * * *',  '/api/cron/channel-outbound'),
      ('zentry-channel-poll',         '*/5 * * * *',  '/api/cron/channel-poll'),
      ('zentry-unread-notifications', '*/5 * * * *',  '/api/cron/unread-notifications'),
      ('zentry-verify-domains',       '*/15 * * * *', '/api/cron/verify-domains'),
      ('zentry-close-solved-tickets', '17 3 * * *',   '/api/cron/close-solved-tickets')
    ) AS v(job_name, schedule, path)
  LOOP
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = j.job_name;
    PERFORM cron.schedule(j.job_name, j.schedule, format('SELECT public.fn_call_app_cron(%L)', j.path));
  END LOOP;
END $$;

/* ── 3. SMTP password out of workspaces ─────────────────────────────────── */

-- workspaces.smtp_settings held the SMTP password in plain JSON, and the
-- dashboard reads the workspace row with select('*'), so every member's
-- browser (light agents included) received it. The password now lives in
-- workspace_secrets, which has no policy (service role only). A trigger moves
-- it there on every write, so no writer has to change: smtp_settings keeps
-- the rest of the settings plus has_pass. Saving with an empty password keeps
-- the stored one. Server code reads it through loadWorkspaceSmtp()
-- (src/lib/email/workspace-smtp.ts).
CREATE TABLE IF NOT EXISTS public.workspace_secrets (
  workspace_id UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  smtp_pass    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.workspace_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_secrets FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_workspace_smtp_secret()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pass TEXT;
  v_has BOOLEAN;
BEGIN
  IF NEW.smtp_settings IS NULL OR jsonb_typeof(NEW.smtp_settings) <> 'object' THEN
    RETURN NEW;
  END IF;
  v_pass := NEW.smtp_settings ->> 'pass';
  IF coalesce(v_pass, '') <> '' THEN
    INSERT INTO public.workspace_secrets (workspace_id, smtp_pass, updated_at)
    VALUES (NEW.id, v_pass, now())
    ON CONFLICT (workspace_id) DO UPDATE SET smtp_pass = EXCLUDED.smtp_pass, updated_at = now();
    v_has := true;
  ELSE
    SELECT coalesce(smtp_pass, '') <> '' INTO v_has FROM public.workspace_secrets WHERE workspace_id = NEW.id;
  END IF;
  NEW.smtp_settings := (NEW.smtp_settings - 'pass') || jsonb_build_object('has_pass', coalesce(v_has, false));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_smtp_secret ON public.workspaces;
CREATE TRIGGER trg_workspace_smtp_secret
  BEFORE INSERT OR UPDATE OF smtp_settings ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.fn_workspace_smtp_secret();

-- Move the passwords already stored. Runs the trigger above once per row.
UPDATE public.workspaces
   SET smtp_settings = smtp_settings
 WHERE smtp_settings ? 'pass';
