-- ============================================================================
-- Test-only: the parts of a Supabase project that migrations rely on.
--
-- Not a migration. scripts/test-db.sh loads this into a throwaway Postgres
-- before the real migrations, so row level security and triggers can be
-- tested against the SQL that ships, not a mock of it.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supabase reads the caller from the JWT claims PostgREST puts in settings.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT nullif(
    coalesce(
      current_setting('request.jwt.claim.role', true),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    ),
    ''
  )
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Supabase grants table privileges to these roles by default; RLS decides.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- Created outside the migrations in production (docs/AUDIT.md M-13).
CREATE TABLE IF NOT EXISTS public.workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID REFERENCES auth.users(id),
  slug TEXT,
  website_url TEXT,
  brand_color TEXT DEFAULT '#2563eb',
  greeting_title TEXT,
  greeting_message TEXT,
  auto_assignment JSONB,
  ai_settings JSONB,
  smtp_settings JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
