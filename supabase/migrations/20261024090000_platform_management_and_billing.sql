-- ============================================================================
-- Migration: 20261024090000_platform_management_and_billing.sql
-- Description: Platform Owner Super Admin Infrastructure:
--              1. Billing & Lemon Squeezy Invoicing
--              2. Login As Workspace (Support Sessions)
--              3. Platform Feature Flags
--              4. Announcements System
--              5. Platform Settings & Maintenance
--              6. System Email Templates
--              7. AI Daily Usage & Cost Tracking
--              8. Abuse & Safety (Domain Blacklist, Outbound Blocking, Delayed Deletion)
--              9. Platform Staff Team RBAC (Owner, Support, Finance)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extend workspaces for Abuse, Outbound Blocking, AI Cap, & Deletion
-- ----------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS is_outbound_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS abuse_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS abuse_reason TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_requested_by TEXT,
  ADD COLUMN IF NOT EXISTS ai_monthly_token_cap INTEGER DEFAULT 500000;

-- ----------------------------------------------------------------------------
-- 2. Extend workspace_subscriptions for Lemon Squeezy & Manual Billing
-- ----------------------------------------------------------------------------
ALTER TABLE public.workspace_subscriptions
  ADD COLUMN IF NOT EXISTS lemonsqueezy_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS lemonsqueezy_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS lemonsqueezy_variant_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'manual' CHECK (payment_method IN ('lemonsqueezy', 'manual_bank_transfer', 'manual_crypto', 'manual_check', 'manual')),
  ADD COLUMN IF NOT EXISTS grace_period_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_payment_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_payment_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_ls_sub
ON public.workspace_subscriptions(lemonsqueezy_subscription_id);

-- ----------------------------------------------------------------------------
-- 3. Workspace Invoices Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.workspace_subscriptions(id) ON DELETE SET NULL,
  invoice_number TEXT NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'open', 'void', 'uncollectible')),
  billing_reason TEXT NOT NULL DEFAULT 'subscription_cycle' CHECK (billing_reason IN ('subscription_cycle', 'subscription_create', 'subscription_update', 'manual_payment')),
  payment_method TEXT NOT NULL DEFAULT 'lemonsqueezy' CHECK (payment_method IN ('lemonsqueezy', 'manual_bank_transfer', 'manual_crypto', 'manual_check', 'manual_other')),
  payment_reference TEXT,
  hosted_invoice_url TEXT,
  pdf_url TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  paid_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_invoices_ws
ON public.workspace_invoices(workspace_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 4. Support Sessions (Login as Workspace / Impersonation)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.support_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  workspace_name TEXT NOT NULL,
  session_token TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT 'Customer support investigation',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_sessions_lookup
ON public.support_sessions(session_token, expires_at);

-- ----------------------------------------------------------------------------
-- 5. Platform Feature Flags Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_enabled_globally BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_plan_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled_workspace_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  disabled_workspace_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed initial feature flags
INSERT INTO public.platform_feature_flags (key, name, description, is_enabled_globally)
VALUES
  ('whatsapp_channel', 'WhatsApp Integration', 'Allow workspaces to connect WhatsApp Business API', true),
  ('instagram_channel', 'Instagram Messaging', 'Allow workspaces to connect Instagram DM integration', true),
  ('ai_auto_replies', 'AI Auto Responder', 'Autonomous AI helpdesk replies and intent routing', true),
  ('custom_domains', 'Custom Domains', 'White-labeled customer help center custom CNAME routing', true),
  ('visitor_radar', 'Live Visitor Radar', 'Real-time visitor tracking and live session intelligence', true)
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 6. Announcements System
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  display_type TEXT NOT NULL DEFAULT 'banner' CHECK (display_type IN ('banner', 'modal', 'card')),
  tone TEXT NOT NULL DEFAULT 'info' CHECK (tone IN ('info', 'warning', 'success', 'urgent')),
  target_audience TEXT NOT NULL DEFAULT 'all' CHECK (target_audience IN ('all', 'plans', 'workspaces')),
  target_plan_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_workspace_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  start_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_date TIMESTAMPTZ,
  is_dismissible BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 7. Platform Settings (Single Row Config & Extensions)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  platform_name TEXT DEFAULT 'ZenTry',
  platform_url TEXT DEFAULT 'https://zen-try.site',
  support_email TEXT DEFAULT 'support@zen-try.site',
  smtp_settings JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure all platform governance, AI defaults, and email branding columns exist
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS default_plan_slug TEXT NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS default_trial_days INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS signup_mode TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS default_ai_model TEXT NOT NULL DEFAULT 'claude-3-5-sonnet',
  ADD COLUMN IF NOT EXISTS default_ai_monthly_token_limit INTEGER NOT NULL DEFAULT 500000,
  ADD COLUMN IF NOT EXISTS email_sender_name TEXT NOT NULL DEFAULT 'ZenTry Support',
  ADD COLUMN IF NOT EXISTS email_sender_address TEXT NOT NULL DEFAULT 'support@zentry.io',
  ADD COLUMN IF NOT EXISTS email_brand_color TEXT NOT NULL DEFAULT '#2E5BFF',
  ADD COLUMN IF NOT EXISTS email_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS email_footer_text TEXT NOT NULL DEFAULT '© 2026 ZenTry Inc. All rights reserved.',
  ADD COLUMN IF NOT EXISTS is_maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS maintenance_message TEXT NOT NULL DEFAULT 'ZenTry is currently undergoing scheduled platform upgrades. We will be back online shortly.',
  ADD COLUMN IF NOT EXISTS maintenance_bypass_emails JSONB NOT NULL DEFAULT '["musmanrai372@gmail.com", "raiusman37218@gmail.com", "agent@zentry.io"]'::jsonb;

-- Ensure default settings record exists
INSERT INTO public.platform_settings (id, default_plan_slug, default_trial_days)
VALUES ('default', 'starter', 14)
ON CONFLICT (id) DO UPDATE SET
  default_plan_slug = COALESCE(public.platform_settings.default_plan_slug, EXCLUDED.default_plan_slug),
  default_trial_days = COALESCE(public.platform_settings.default_trial_days, EXCLUDED.default_trial_days);

-- ----------------------------------------------------------------------------
-- 8. System Email Templates
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key TEXT NOT NULL UNIQUE CHECK (template_key IN ('welcome', 'trial_ending', 'payment_failed', 'limit_reached')),
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT NOT NULL,
  available_variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.platform_email_templates (template_key, name, subject, body_text, body_html, available_variables)
VALUES
  (
    'welcome',
    'Workspace Welcome & Setup',
    'Welcome to ZenTry, {{user_name}}!',
    'Hi {{user_name}},\n\nWelcome to {{workspace_name}} on ZenTry. Your {{plan_name}} account has been provisioned.\n\nSign in here: {{login_url}}\n\nBest,\nThe ZenTry Team',
    '<p>Hi {{user_name}},</p><p>Welcome to <strong>{{workspace_name}}</strong> on ZenTry. Your <strong>{{plan_name}}</strong> account has been provisioned.</p><p><a href="{{login_url}}">Sign in to your workspace &rarr;</a></p><p>Best,<br>The ZenTry Team</p>',
    '["user_name", "workspace_name", "plan_name", "login_url"]'::jsonb
  ),
  (
    'trial_ending',
    'Free Trial Ending Soon',
    'Your ZenTry free trial ends in {{trial_days}} days',
    'Hi {{user_name}},\n\nYour free trial of {{plan_name}} for {{workspace_name}} is ending in {{trial_days}} days.\n\nUpgrade your subscription here to keep all features active: {{billing_url}}\n\nBest,\nThe ZenTry Team',
    '<p>Hi {{user_name}},</p><p>Your free trial of <strong>{{plan_name}}</strong> for <strong>{{workspace_name}}</strong> is ending in {{trial_days}} days.</p><p><a href="{{billing_url}}">Choose a paid subscription &rarr;</a></p><p>Best,<br>The ZenTry Team</p>',
    '["user_name", "workspace_name", "plan_name", "trial_days", "billing_url"]'::jsonb
  ),
  (
    'payment_failed',
    'Payment Failed (Grace Period Active)',
    'Action Required: Payment failed for {{workspace_name}}',
    'Hi {{user_name}},\n\nWe could not process the renewal payment for {{workspace_name}}. A {{grace_period_days}}-day grace period is active.\n\nPlease update your billing information here: {{billing_url}}\n\nBest,\nThe ZenTry Team',
    '<p>Hi {{user_name}},</p><p>We could not process the renewal payment for <strong>{{workspace_name}}</strong>. A {{grace_period_days}}-day grace period is active to ensure uninterrupted support.</p><p><a href="{{billing_url}}">Update billing information &rarr;</a></p><p>Best,<br>The ZenTry Team</p>',
    '["user_name", "workspace_name", "grace_period_days", "billing_url"]'::jsonb
  ),
  (
    'limit_reached',
    'Resource Limit Advisory / Exceeded',
    '{{workspace_name}} has reached {{limit_name}} capacity',
    'Hi {{user_name}},\n\nYour workspace {{workspace_name}} has reached or exceeded 80% of its {{limit_name}} capacity.\n\nTo increase capacity, upgrade your plan here: {{billing_url}}\n\nBest,\nThe ZenTry Team',
    '<p>Hi {{user_name}},</p><p>Your workspace <strong>{{workspace_name}}</strong> has reached or exceeded 80% of its <strong>{{limit_name}}</strong> capacity.</p><p><a href="{{billing_url}}">Upgrade your plan &rarr;</a></p><p>Best,<br>The ZenTry Team</p>',
    '["user_name", "workspace_name", "limit_name", "billing_url"]'::jsonb
  )
ON CONFLICT (template_key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 9. AI Usage & Daily Cost Tracking
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_ai_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0.0000,
  requests_count INTEGER NOT NULL DEFAULT 0,
  model_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_workspace_ai_usage_date
ON public.workspace_ai_usage_daily(usage_date DESC);

-- ----------------------------------------------------------------------------
-- 10. Abuse & Safety: Blocked Email Domains List
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_blocked_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT 'Spam or disposable provider',
  blocked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pre-seed known disposable / spam email domains
INSERT INTO public.platform_blocked_domains (domain, reason)
VALUES
  ('mailinator.com', 'Disposable email provider'),
  ('tempmail.com', 'Disposable email provider'),
  ('10minutemail.com', 'Disposable email provider'),
  ('guerrillamail.com', 'Disposable email provider'),
  ('sharklasers.com', 'Disposable email provider'),
  ('yopmail.com', 'Disposable email provider')
ON CONFLICT (domain) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 11. Platform Staff Team RBAC
-- ----------------------------------------------------------------------------
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS platform_staff_role TEXT CHECK (platform_staff_role IN ('owner', 'support', 'finance'));

-- Update existing super admins to 'owner' if not set
UPDATE public.agents
SET platform_staff_role = 'owner'
WHERE is_super_admin = true AND platform_staff_role IS NULL;

-- ----------------------------------------------------------------------------
-- 12. Row Level Security Policies
-- ----------------------------------------------------------------------------
ALTER TABLE public.workspace_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_ai_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_blocked_domains ENABLE ROW LEVEL SECURITY;

-- workspace_invoices: members can view their workspace's invoices
DROP POLICY IF EXISTS "Workspace members can view own invoices" ON public.workspace_invoices;
CREATE POLICY "Workspace members can view own invoices"
ON public.workspace_invoices FOR SELECT
USING (
  workspace_id IN (
    SELECT workspace_id FROM public.agents WHERE id = auth.uid()
  )
);

-- announcements: public read for active announcements
DROP POLICY IF EXISTS "Public can view active announcements" ON public.platform_announcements;
CREATE POLICY "Public can view active announcements"
ON public.platform_announcements FOR SELECT
USING (
  is_active = true AND (end_date IS NULL OR end_date > now())
);

-- platform_settings: anyone can read maintenance state & public branding
DROP POLICY IF EXISTS "Public can view platform settings" ON public.platform_settings;
CREATE POLICY "Public can view platform settings"
ON public.platform_settings FOR SELECT
USING (true);

-- Super admin full access policies
DROP POLICY IF EXISTS "Super admins have full access to platform invoices" ON public.workspace_invoices;
CREATE POLICY "Super admins have full access to platform invoices"
ON public.workspace_invoices FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.agents WHERE id = auth.uid() AND is_super_admin = true
  )
);

DROP POLICY IF EXISTS "Super admins have full access to support sessions" ON public.support_sessions;
CREATE POLICY "Super admins have full access to support sessions"
ON public.support_sessions FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.agents WHERE id = auth.uid() AND is_super_admin = true
  )
);

DROP POLICY IF EXISTS "Super admins have full access to feature flags" ON public.platform_feature_flags;
CREATE POLICY "Super admins have full access to feature flags"
ON public.platform_feature_flags FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.agents WHERE id = auth.uid() AND is_super_admin = true
  )
);

DROP POLICY IF EXISTS "Super admins have full access to announcements" ON public.platform_announcements;
CREATE POLICY "Super admins have full access to announcements"
ON public.platform_announcements FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.agents WHERE id = auth.uid() AND is_super_admin = true
  )
);

DROP POLICY IF EXISTS "Super admins have full access to platform settings" ON public.platform_settings;
CREATE POLICY "Super admins have full access to platform settings"
ON public.platform_settings FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.agents WHERE id = auth.uid() AND is_super_admin = true
  )
);

DROP POLICY IF EXISTS "Super admins have full access to email templates" ON public.platform_email_templates;
CREATE POLICY "Super admins have full access to email templates"
ON public.platform_email_templates FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.agents WHERE id = auth.uid() AND is_super_admin = true
  )
);

DROP POLICY IF EXISTS "Super admins have full access to ai daily usage" ON public.workspace_ai_usage_daily;
CREATE POLICY "Super admins have full access to ai daily usage"
ON public.workspace_ai_usage_daily FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.agents WHERE id = auth.uid() AND is_super_admin = true
  )
);

DROP POLICY IF EXISTS "Super admins have full access to blocked domains" ON public.platform_blocked_domains;
CREATE POLICY "Super admins have full access to blocked domains"
ON public.platform_blocked_domains FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.agents WHERE id = auth.uid() AND is_super_admin = true
  )
);
