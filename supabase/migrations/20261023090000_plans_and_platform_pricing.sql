-- ============================================================================
-- Migration: 20261023090000_plans_and_platform_pricing.sql
-- Description: Dynamic Plan & Pricing Management, Subscriptions, Usage Tracking,
--              Coupons, and Server-Enforced Limits for ZenTry Platform Owner
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Create platform_plans Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  monthly_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  yearly_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  currency TEXT NOT NULL DEFAULT 'USD',
  trial_days INTEGER NOT NULL DEFAULT 14,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden', 'custom')),
  custom_workspace_id UUID REFERENCES public.workspaces(id) ON DELETE SET NULL,
  is_popular BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,

  -- Resource Limits (NULL = Unlimited)
  max_agents INTEGER,
  max_tickets_per_month INTEGER,
  max_ai_bot_replies_per_month INTEGER,
  max_channels_connected INTEGER,
  max_articles INTEGER,
  max_automations INTEGER,
  max_storage_mb INTEGER,
  max_api_requests_per_month INTEGER,

  -- Feature Flags JSONB
  features JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_plans_lookup
ON public.platform_plans(visibility, is_archived, sort_order);

-- ----------------------------------------------------------------------------
-- 2. Create platform_plan_versions Table (Snapshotting Plan Revisions)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_plan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES public.platform_plans(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  monthly_price NUMERIC(10, 2) NOT NULL,
  yearly_price NUMERIC(10, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  max_agents INTEGER,
  max_tickets_per_month INTEGER,
  max_ai_bot_replies_per_month INTEGER,
  max_channels_connected INTEGER,
  max_articles INTEGER,
  max_automations INTEGER,
  max_storage_mb INTEGER,
  max_api_requests_per_month INTEGER,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, version)
);

-- ----------------------------------------------------------------------------
-- 3. Create workspace_subscriptions Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL UNIQUE REFERENCES public.workspaces(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES public.platform_plans(id) ON DELETE RESTRICT,
  plan_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'suspended')),
  billing_period TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_period IN ('monthly', 'yearly')),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  trial_ends_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,

  -- Workspace-Specific Overrides granted by Platform Owner
  custom_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_features JSONB NOT NULL DEFAULT '{}'::jsonb,
  admin_note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_ws
ON public.workspace_subscriptions(workspace_id);

CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_plan
ON public.workspace_subscriptions(plan_id);

-- ----------------------------------------------------------------------------
-- 4. Create workspace_usage Table (Billing Period Resource Tracking)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,

  tickets_count INTEGER NOT NULL DEFAULT 0,
  ai_bot_replies_count INTEGER NOT NULL DEFAULT 0,
  api_requests_count INTEGER NOT NULL DEFAULT 0,
  storage_bytes BIGINT NOT NULL DEFAULT 0,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_workspace_usage_period
ON public.workspace_usage(workspace_id, period_start, period_end);

-- ----------------------------------------------------------------------------
-- 5. Create platform_coupons Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value NUMERIC(10, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ,
  max_redemptions INTEGER,
  redemptions_count INTEGER NOT NULL DEFAULT 0,
  allowed_plan_ids UUID[],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_coupons_code
ON public.platform_coupons(code);

-- ----------------------------------------------------------------------------
-- 6. Seed Default Plans & The "Legacy" Plan
-- ----------------------------------------------------------------------------
-- (A) Legacy Plan (Internal, all unlimited, for grandfathered workspaces)
INSERT INTO public.platform_plans (
  slug, name, description, monthly_price, yearly_price, currency, trial_days,
  visibility, is_popular, is_archived, is_default, sort_order, version,
  max_agents, max_tickets_per_month, max_ai_bot_replies_per_month,
  max_channels_connected, max_articles, max_automations, max_storage_mb, max_api_requests_per_month,
  features
) VALUES (
  'legacy',
  'Legacy (Unlimited)',
  'Grandfathered plan for existing platform workspaces with unlimited resources.',
  0.00, 0.00, 'USD', 0,
  'hidden', FALSE, FALSE, FALSE, 0, 1,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  '{
    "channel_email": true,
    "channel_whatsapp": true,
    "channel_instagram": true,
    "channel_x": true,
    "channel_linkedin": true,
    "channel_tiktok": true,
    "channel_threads": true,
    "ai_bot": true,
    "sla": true,
    "macros": true,
    "automations": true,
    "csat_reports": true,
    "custom_help_center_domain": true,
    "visitor_tracking": true,
    "roles_groups": true,
    "remove_branding": true,
    "api_webhooks": true
  }'::jsonb
) ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  features = EXCLUDED.features;

-- (B) Starter Plan
INSERT INTO public.platform_plans (
  slug, name, description, monthly_price, yearly_price, currency, trial_days,
  visibility, is_popular, is_archived, is_default, sort_order, version,
  max_agents, max_tickets_per_month, max_ai_bot_replies_per_month,
  max_channels_connected, max_articles, max_automations, max_storage_mb, max_api_requests_per_month,
  features
) VALUES (
  'starter',
  'Starter',
  'Essential omnichannel messaging and AI assistance for small growing teams.',
  29.00, 290.00, 'USD', 14,
  'public', FALSE, FALSE, TRUE, 1, 1,
  3, 500, 200, 2, 25, 5, 1024, 1000,
  '{
    "channel_email": true,
    "channel_whatsapp": true,
    "channel_instagram": false,
    "channel_x": false,
    "channel_linkedin": false,
    "channel_tiktok": false,
    "channel_threads": false,
    "ai_bot": true,
    "sla": false,
    "macros": true,
    "automations": false,
    "csat_reports": false,
    "custom_help_center_domain": false,
    "visitor_tracking": true,
    "roles_groups": false,
    "remove_branding": false,
    "api_webhooks": false
  }'::jsonb
) ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  monthly_price = EXCLUDED.monthly_price,
  yearly_price = EXCLUDED.yearly_price,
  trial_days = EXCLUDED.trial_days,
  is_default = EXCLUDED.is_default;

-- (C) Pro Plan
INSERT INTO public.platform_plans (
  slug, name, description, monthly_price, yearly_price, currency, trial_days,
  visibility, is_popular, is_archived, is_default, sort_order, version,
  max_agents, max_tickets_per_month, max_ai_bot_replies_per_month,
  max_channels_connected, max_articles, max_automations, max_storage_mb, max_api_requests_per_month,
  features
) VALUES (
  'pro',
  'Pro',
  'Advanced omnichannel automation, custom roles, SLA policies, and full AI copilot.',
  79.00, 790.00, 'USD', 14,
  'public', TRUE, FALSE, FALSE, 2, 1,
  10, 2500, 1000, 10, 100, 25, 10240, 10000,
  '{
    "channel_email": true,
    "channel_whatsapp": true,
    "channel_instagram": true,
    "channel_x": true,
    "channel_linkedin": true,
    "channel_tiktok": false,
    "channel_threads": true,
    "ai_bot": true,
    "sla": true,
    "macros": true,
    "automations": true,
    "csat_reports": true,
    "custom_help_center_domain": false,
    "visitor_tracking": true,
    "roles_groups": true,
    "remove_branding": false,
    "api_webhooks": true
  }'::jsonb
) ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  monthly_price = EXCLUDED.monthly_price,
  yearly_price = EXCLUDED.yearly_price,
  is_popular = EXCLUDED.is_popular;

-- (D) Enterprise Plan
INSERT INTO public.platform_plans (
  slug, name, description, monthly_price, yearly_price, currency, trial_days,
  visibility, is_popular, is_archived, is_default, sort_order, version,
  max_agents, max_tickets_per_month, max_ai_bot_replies_per_month,
  max_channels_connected, max_articles, max_automations, max_storage_mb, max_api_requests_per_month,
  features
) VALUES (
  'enterprise',
  'Enterprise',
  'Maximum performance, unbranded white-labeling, custom domains, and dedicated scale.',
  199.00, 1990.00, 'USD', 0,
  'public', FALSE, FALSE, FALSE, 3, 1,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  '{
    "channel_email": true,
    "channel_whatsapp": true,
    "channel_instagram": true,
    "channel_x": true,
    "channel_linkedin": true,
    "channel_tiktok": true,
    "channel_threads": true,
    "ai_bot": true,
    "sla": true,
    "macros": true,
    "automations": true,
    "csat_reports": true,
    "custom_help_center_domain": true,
    "visitor_tracking": true,
    "roles_groups": true,
    "remove_branding": true,
    "api_webhooks": true
  }'::jsonb
) ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  monthly_price = EXCLUDED.monthly_price,
  yearly_price = EXCLUDED.yearly_price;

-- Seed Initial Plan Versions
INSERT INTO public.platform_plan_versions (
  plan_id, version, monthly_price, yearly_price, currency,
  max_agents, max_tickets_per_month, max_ai_bot_replies_per_month,
  max_channels_connected, max_articles, max_automations, max_storage_mb, max_api_requests_per_month,
  features
)
SELECT
  id, version, monthly_price, yearly_price, currency,
  max_agents, max_tickets_per_month, max_ai_bot_replies_per_month,
  max_channels_connected, max_articles, max_automations, max_storage_mb, max_api_requests_per_month,
  features
FROM public.platform_plans
ON CONFLICT (plan_id, version) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 7. Migration Safety: Grandfather All Existing Workspaces into Legacy Plan
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_legacy_plan_id UUID;
BEGIN
  SELECT id INTO v_legacy_plan_id FROM public.platform_plans WHERE slug = 'legacy' LIMIT 1;

  IF v_legacy_plan_id IS NOT NULL THEN
    -- Assign legacy subscription to any workspace without an active subscription
    INSERT INTO public.workspace_subscriptions (
      workspace_id,
      plan_id,
      plan_version,
      status,
      billing_period,
      current_period_start,
      current_period_end,
      admin_note
    )
    SELECT
      w.id,
      v_legacy_plan_id,
      1,
      'active',
      'yearly',
      now(),
      now() + interval '10 years',
      'Grandfathered into Legacy Plan upon system initialization.'
    FROM public.workspaces w
    WHERE NOT EXISTS (
      SELECT 1 FROM public.workspace_subscriptions ws WHERE ws.workspace_id = w.id
    )
    ON CONFLICT (workspace_id) DO NOTHING;

    -- Keep workspaces.plan column aligned
    UPDATE public.workspaces
    SET plan = 'legacy'
    WHERE plan IS NULL OR plan = '' OR plan = 'Free' OR plan = 'starter';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 8. Enable Row Level Security (RLS)
-- ----------------------------------------------------------------------------
ALTER TABLE public.platform_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_coupons ENABLE ROW LEVEL SECURITY;

-- (A) RLS Policies for platform_plans
DROP POLICY IF EXISTS "Public can view public plans" ON public.platform_plans;
CREATE POLICY "Public can view public plans"
ON public.platform_plans
FOR SELECT
TO anon, authenticated
USING (visibility = 'public' AND is_archived = FALSE);

DROP POLICY IF EXISTS "Workspace members can view their assigned plan" ON public.platform_plans;
CREATE POLICY "Workspace members can view their assigned plan"
ON public.platform_plans
FOR SELECT
TO authenticated
USING (
  id IN (
    SELECT plan_id FROM public.workspace_subscriptions
    WHERE workspace_id IN (SELECT current_user_workspace_ids())
  )
  OR public.is_current_user_super_admin()
);

DROP POLICY IF EXISTS "Platform super admins can manage plans" ON public.platform_plans;
CREATE POLICY "Platform super admins can manage plans"
ON public.platform_plans
FOR ALL
TO authenticated
USING (public.is_current_user_super_admin())
WITH CHECK (public.is_current_user_super_admin());

-- (B) RLS Policies for platform_plan_versions
DROP POLICY IF EXISTS "Authenticated can view plan versions" ON public.platform_plan_versions;
CREATE POLICY "Authenticated can view plan versions"
ON public.platform_plan_versions
FOR SELECT
TO authenticated
USING (TRUE);

DROP POLICY IF EXISTS "Super admins can manage plan versions" ON public.platform_plan_versions;
CREATE POLICY "Super admins can manage plan versions"
ON public.platform_plan_versions
FOR ALL
TO authenticated
USING (public.is_current_user_super_admin())
WITH CHECK (public.is_current_user_super_admin());

-- (C) RLS Policies for workspace_subscriptions
DROP POLICY IF EXISTS "Workspace members can view own subscription" ON public.workspace_subscriptions;
CREATE POLICY "Workspace members can view own subscription"
ON public.workspace_subscriptions
FOR SELECT
TO authenticated
USING (
  workspace_id IN (SELECT current_user_workspace_ids())
  OR public.is_current_user_super_admin()
);

DROP POLICY IF EXISTS "Super admins can manage workspace subscriptions" ON public.workspace_subscriptions;
CREATE POLICY "Super admins can manage workspace subscriptions"
ON public.workspace_subscriptions
FOR ALL
TO authenticated
USING (public.is_current_user_super_admin())
WITH CHECK (public.is_current_user_super_admin());

-- (D) RLS Policies for workspace_usage
DROP POLICY IF EXISTS "Workspace members can view own usage" ON public.workspace_usage;
CREATE POLICY "Workspace members can view own usage"
ON public.workspace_usage
FOR SELECT
TO authenticated
USING (
  workspace_id IN (SELECT current_user_workspace_ids())
  OR public.is_current_user_super_admin()
);

DROP POLICY IF EXISTS "Super admins can manage workspace usage" ON public.workspace_usage;
CREATE POLICY "Super admins can manage workspace usage"
ON public.workspace_usage
FOR ALL
TO authenticated
USING (public.is_current_user_super_admin())
WITH CHECK (public.is_current_user_super_admin());

-- (E) RLS Policies for platform_coupons
DROP POLICY IF EXISTS "Authenticated users can inspect active coupons" ON public.platform_coupons;
CREATE POLICY "Authenticated users can inspect active coupons"
ON public.platform_coupons
FOR SELECT
TO authenticated
USING (is_active = TRUE OR public.is_current_user_super_admin());

DROP POLICY IF EXISTS "Super admins can manage platform coupons" ON public.platform_coupons;
CREATE POLICY "Super admins can manage platform coupons"
ON public.platform_coupons
FOR ALL
TO authenticated
USING (public.is_current_user_super_admin())
WITH CHECK (public.is_current_user_super_admin());
