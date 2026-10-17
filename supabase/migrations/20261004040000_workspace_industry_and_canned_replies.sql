-- Migration: 20261004040000_workspace_industry_and_canned_replies.sql
-- Description:
-- 1. Add industry column to workspaces table and public_workspaces view
-- 2. Clean up demo canned responses and seed two generic saved replies (greeting, "we're checking")

BEGIN;

-- 1. Add industry column
ALTER TABLE public.workspaces 
ADD COLUMN IF NOT EXISTS industry text DEFAULT 'generic';

-- Update view to include industry
DROP VIEW IF EXISTS public.public_workspaces;

CREATE VIEW public.public_workspaces AS
SELECT 
  id,
  name,
  website_url,
  brand_color,
  logo_url,
  widget_position,
  greeting_title,
  greeting_message,
  help_center_tab_label,
  show_help_tab,
  help_center_tab_icon,
  slug,
  custom_domain,
  custom_domain_status,
  help_center_title,
  help_center_subtitle,
  help_center_logo_url,
  help_center_header_links,
  help_center_footer_text,
  created_at,
  help_center_layout,
  business_hours,
  slug_changes_count,
  industry
FROM public.workspaces;

-- 2. Clean up demo canned responses
DELETE FROM public.canned_responses WHERE workspace_id IS NULL;
DELETE FROM public.canned_responses WHERE shortcut IN ('pricing', 'solved', '/refund-policy', 'sla_guarantee');

-- 3. Seed two generic saved replies for all existing active workspaces (including Chatify)
DO $$
DECLARE
  ws RECORD;
BEGIN
  FOR ws IN SELECT id FROM public.workspaces WHERE deleted_at IS NULL LOOP
    -- Seed greeting
    IF NOT EXISTS (
      SELECT 1 FROM public.canned_responses 
      WHERE workspace_id = ws.id AND shortcut = 'hello'
    ) THEN
      INSERT INTO public.canned_responses (workspace_id, title, shortcut, content, created_at)
      VALUES (
        ws.id,
        'Greeting',
        'hello',
        'Hi there! Thanks for reaching out. How can I help you today?',
        now()
      );
    ELSE
      UPDATE public.canned_responses
      SET title = 'Greeting',
          content = 'Hi there! Thanks for reaching out. How can I help you today?'
      WHERE workspace_id = ws.id AND shortcut = 'hello';
    END IF;

    -- Seed "we're checking"
    IF NOT EXISTS (
      SELECT 1 FROM public.canned_responses 
      WHERE workspace_id = ws.id AND shortcut = 'checking'
    ) THEN
      INSERT INTO public.canned_responses (workspace_id, title, shortcut, content, created_at)
      VALUES (
        ws.id,
        'We''re checking',
        'checking',
        'Thanks for your patience! I''m looking into this for you right now and will update you shortly.',
        now()
      );
    ELSE
      UPDATE public.canned_responses
      SET title = 'We''re checking',
          content = 'Thanks for your patience! I''m looking into this for you right now and will update you shortly.'
      WHERE workspace_id = ws.id AND shortcut = 'checking';
    END IF;
  END LOOP;
END $$;

COMMIT;
