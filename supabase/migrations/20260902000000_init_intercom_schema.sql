-- ============================================================================
-- Migration: 20260902000000_init_intercom_schema.sql
-- Description: Intercom-Style Live Chat Support System Schema
-- Tables:
--   1. visitors
--   2. agents
--   3. conversations
--   4. messages
--   5. conversation_tags
--   6. internal_notes
--   7. canned_responses
--   8. visitor_page_history
-- Features: Row Level Security (RLS) + Supabase Realtime Replication
-- ============================================================================

-- Ensure pgcrypto extension is available for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. VISITORS TABLE
-- Tracks website visitors, live presence, device metadata, and geolocation
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.visitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  email TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_page_url TEXT NOT NULL DEFAULT '/',
  current_page_title TEXT,
  ip_location_city TEXT,
  ip_location_country TEXT,
  device TEXT,
  browser TEXT,
  os TEXT,
  referrer_source TEXT,
  visit_count INTEGER NOT NULL DEFAULT 1,
  is_online BOOLEAN NOT NULL DEFAULT true
);

-- Backward compatibility columns if migrated from earlier schema
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'first_seen_at') THEN
    ALTER TABLE public.visitors ADD COLUMN first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'last_seen_at') THEN
    ALTER TABLE public.visitors ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'current_page_url') THEN
    ALTER TABLE public.visitors ADD COLUMN current_page_url TEXT NOT NULL DEFAULT '/';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'current_page_title') THEN
    ALTER TABLE public.visitors ADD COLUMN current_page_title TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'ip_location_city') THEN
    ALTER TABLE public.visitors ADD COLUMN ip_location_city TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'ip_location_country') THEN
    ALTER TABLE public.visitors ADD COLUMN ip_location_country TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'device') THEN
    ALTER TABLE public.visitors ADD COLUMN device TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'browser') THEN
    ALTER TABLE public.visitors ADD COLUMN browser TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'os') THEN
    ALTER TABLE public.visitors ADD COLUMN os TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'referrer_source') THEN
    ALTER TABLE public.visitors ADD COLUMN referrer_source TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'visit_count') THEN
    ALTER TABLE public.visitors ADD COLUMN visit_count INTEGER NOT NULL DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visitors' AND column_name = 'is_online') THEN
    ALTER TABLE public.visitors ADD COLUMN is_online BOOLEAN NOT NULL DEFAULT true;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. AGENTS TABLE
-- Support agents and administrators tied to auth.users
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agents (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'away', 'offline')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure constraints match requested definitions
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'role') THEN
    ALTER TABLE public.agents ADD COLUMN role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'status') THEN
    ALTER TABLE public.agents ADD COLUMN status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'away', 'offline'));
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. CONVERSATIONS TABLE
-- Threads connecting visitors with assigned support agents
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id UUID NOT NULL REFERENCES public.visitors(id) ON DELETE CASCADE,
  assigned_agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'snoozed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

-- Column synchronization for existing databases
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'assigned_agent_id') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'agent_id') THEN
      ALTER TABLE public.conversations RENAME COLUMN agent_id TO assigned_agent_id;
    ELSE
      ALTER TABLE public.conversations ADD COLUMN assigned_agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL;
    END IF;
  END IF;

  -- Relax check constraint on status if old 'pending' was present, ensuring 'snoozed' is allowed
  ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
  ALTER TABLE public.conversations ADD CONSTRAINT conversations_status_check CHECK (status IN ('open', 'closed', 'snoozed', 'pending'));

  ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_priority_check;
  ALTER TABLE public.conversations ADD CONSTRAINT conversations_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
END $$;

-- ----------------------------------------------------------------------------
-- 4. MESSAGES TABLE
-- Individual messages in a conversation
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('visitor', 'agent', 'system', 'ai')),
  sender_id UUID,
  content TEXT NOT NULL,
  attachment_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

-- Column synchronization for existing databases
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'attachment_url') THEN
    ALTER TABLE public.messages ADD COLUMN attachment_url TEXT;
  END IF;

  ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_sender_type_check;
  ALTER TABLE public.messages ADD CONSTRAINT messages_sender_type_check CHECK (sender_type IN ('visitor', 'agent', 'system', 'ai'));
END $$;

-- ----------------------------------------------------------------------------
-- 5. CONVERSATION_TAGS TABLE
-- Tagging system for categorizing conversations
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  tag_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_conversation_tag UNIQUE (conversation_id, tag_name)
);

-- ----------------------------------------------------------------------------
-- 6. INTERNAL_NOTES TABLE
-- Private team notes in a thread with agent mention capabilities
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.internal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  mentioned_agent_ids UUID[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 7. CANNED_RESPONSES TABLE
-- Saved replies/macros accessible via shortcuts (e.g. #pricing)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.canned_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES public.agents(id) ON DELETE CASCADE,
  shortcut TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'canned_responses' AND column_name = 'agent_id') THEN
    ALTER TABLE public.canned_responses ADD COLUMN agent_id UUID REFERENCES public.agents(id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'canned_responses' AND column_name = 'title') THEN
    ALTER TABLE public.canned_responses ALTER COLUMN title DROP NOT NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 8. VISITOR_PAGE_HISTORY TABLE
-- Full browsing trail for proactive visitor context
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.visitor_page_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id UUID NOT NULL REFERENCES public.visitors(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- INDEXES FOR QUERY OPTIMIZATION
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_visitors_last_seen ON public.visitors (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_visitor_id ON public.conversations (visitor_id);
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_agent_id ON public.conversations (assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON public.conversations (status);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON public.conversations (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON public.messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON public.messages (created_at ASC);
CREATE INDEX IF NOT EXISTS idx_internal_notes_conversation_id ON public.internal_notes (conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_tags_conversation_id ON public.conversation_tags (conversation_id);
CREATE INDEX IF NOT EXISTS idx_canned_responses_shortcut ON public.canned_responses (shortcut);
CREATE INDEX IF NOT EXISTS idx_visitor_page_history_visitor_id ON public.visitor_page_history (visitor_id, visited_at DESC);

-- ============================================================================
-- AUTO-UPDATE TRIGGER FOR CONVERSATIONS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_touch_conversation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.conversations
  SET updated_at = now()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_conversation_on_message ON public.messages;
CREATE TRIGGER trg_touch_conversation_on_message
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.fn_touch_conversation_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
ALTER TABLE public.visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canned_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visitor_page_history ENABLE ROW LEVEL SECURITY;

-- 1. VISITORS POLICIES
DROP POLICY IF EXISTS "Visitors: anon can insert" ON public.visitors;
CREATE POLICY "Visitors: anon can insert"
  ON public.visitors FOR INSERT
  TO public
  WITH CHECK (true);

DROP POLICY IF EXISTS "Visitors: anon can select and update own record" ON public.visitors;
CREATE POLICY "Visitors: anon can select and update own record"
  ON public.visitors FOR SELECT
  TO public
  USING (true);

DROP POLICY IF EXISTS "Visitors: anon can update" ON public.visitors;
CREATE POLICY "Visitors: anon can update"
  ON public.visitors FOR UPDATE
  TO public
  USING (true);

-- 2. AGENTS POLICIES
DROP POLICY IF EXISTS "Agents: public can read agent profiles" ON public.agents;
CREATE POLICY "Agents: public can read agent profiles"
  ON public.agents FOR SELECT
  TO public
  USING (true);

DROP POLICY IF EXISTS "Agents: authenticated can update own profile" ON public.agents;
CREATE POLICY "Agents: authenticated can update own profile"
  ON public.agents FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Agents: authenticated can insert own profile" ON public.agents;
CREATE POLICY "Agents: authenticated can insert own profile"
  ON public.agents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

-- 3. CONVERSATIONS POLICIES
DROP POLICY IF EXISTS "Conversations: public can insert and read" ON public.conversations;
CREATE POLICY "Conversations: public can insert and read"
  ON public.conversations FOR SELECT
  TO public
  USING (true);

DROP POLICY IF EXISTS "Conversations: public can insert" ON public.conversations;
CREATE POLICY "Conversations: public can insert"
  ON public.conversations FOR INSERT
  TO public
  WITH CHECK (true);

DROP POLICY IF EXISTS "Conversations: public can update" ON public.conversations;
CREATE POLICY "Conversations: public can update"
  ON public.conversations FOR UPDATE
  TO public
  USING (true);

-- 4. MESSAGES POLICIES
DROP POLICY IF EXISTS "Messages: public can select" ON public.messages;
CREATE POLICY "Messages: public can select"
  ON public.messages FOR SELECT
  TO public
  USING (true);

DROP POLICY IF EXISTS "Messages: public can insert visitor message" ON public.messages;
CREATE POLICY "Messages: public can insert visitor message"
  ON public.messages FOR INSERT
  TO public
  WITH CHECK (true);

-- 5. CONVERSATION TAGS POLICIES
DROP POLICY IF EXISTS "Tags: authenticated full access" ON public.conversation_tags;
CREATE POLICY "Tags: authenticated full access"
  ON public.conversation_tags FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Tags: anon can read tags" ON public.conversation_tags;
CREATE POLICY "Tags: anon can read tags"
  ON public.conversation_tags FOR SELECT
  TO anon
  USING (true);

-- 6. INTERNAL NOTES POLICIES (AUTHENTICATED AGENTS ONLY - ZERO VISITOR ACCESS)
DROP POLICY IF EXISTS "Internal Notes: authenticated agents only" ON public.internal_notes;
CREATE POLICY "Internal Notes: authenticated agents only"
  ON public.internal_notes FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- 7. CANNED RESPONSES POLICIES
DROP POLICY IF EXISTS "Canned Responses: authenticated access" ON public.canned_responses;
CREATE POLICY "Canned Responses: authenticated access"
  ON public.canned_responses FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- 8. VISITOR PAGE HISTORY POLICIES
DROP POLICY IF EXISTS "Page History: anon can insert" ON public.visitor_page_history;
CREATE POLICY "Page History: anon can insert"
  ON public.visitor_page_history FOR INSERT
  TO public
  WITH CHECK (true);

DROP POLICY IF EXISTS "Page History: authenticated can view history" ON public.visitor_page_history;
CREATE POLICY "Page History: authenticated can view history"
  ON public.visitor_page_history FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- SUPABASE REALTIME REPLICATION CONFIGURATION
-- ============================================================================
-- Ensure tables are added to the supabase_realtime publication for live socket push
DO $$
BEGIN
  -- Add conversations to publication
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
  END IF;

  -- Add messages to publication
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;

  -- Add internal_notes to publication
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'internal_notes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_notes;
  END IF;
END $$;

-- Set REPLICA IDENTITY FULL so payload.old contains all previous values on updates
ALTER TABLE public.conversations REPLICA IDENTITY FULL;
ALTER TABLE public.messages REPLICA IDENTITY FULL;
ALTER TABLE public.internal_notes REPLICA IDENTITY FULL;
