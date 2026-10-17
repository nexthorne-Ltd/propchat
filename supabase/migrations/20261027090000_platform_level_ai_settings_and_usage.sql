-- ============================================================================
-- Migration: 20261027090000_platform_level_ai_settings_and_usage.sql
-- Description: Move AI model API configuration from workspace level to platform
--              level. Adds platform_ai_settings, ai_enabled and
--              ai_monthly_reply_limit on platform_plans, and workspace_ai_usage.
-- ============================================================================

-- 1. Create platform-level table platform_ai_settings (single row)
CREATE TABLE IF NOT EXISTS public.platform_ai_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  provider TEXT NOT NULL DEFAULT 'anthropic',
  base_url TEXT,
  model TEXT DEFAULT 'claude-3-5-sonnet',
  api_key TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Seed initial row if absent
INSERT INTO public.platform_ai_settings (id, provider, model, is_enabled)
VALUES (TRUE, 'anthropic', 'claude-3-5-sonnet', FALSE)
ON CONFLICT (id) DO NOTHING;

-- RLS: No access for normal users. Only service_role can read or write.
ALTER TABLE public.platform_ai_settings ENABLE ROW LEVEL SECURITY;

-- 2. Add to platform_plans & platform_plan_versions
ALTER TABLE public.platform_plans
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ai_monthly_reply_limit INTEGER DEFAULT NULL;

ALTER TABLE public.platform_plan_versions
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ai_monthly_reply_limit INTEGER DEFAULT NULL;

-- 3. Create workspace_ai_usage table
CREATE TABLE IF NOT EXISTS public.workspace_ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  replies_used INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_workspace_ai_usage_period UNIQUE (workspace_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_workspace_ai_usage_lookup
ON public.workspace_ai_usage(workspace_id, period_start);

ALTER TABLE public.workspace_ai_usage ENABLE ROW LEVEL SECURITY;

-- Workspace members can read their own usage row
DROP POLICY IF EXISTS "Workspace members can read own ai usage" ON public.workspace_ai_usage;
CREATE POLICY "Workspace members can read own ai usage"
ON public.workspace_ai_usage
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.agents
    WHERE agents.workspace_id = workspace_ai_usage.workspace_id
      AND agents.id = auth.uid()
  )
);

-- Platform super admins can view all usage
DROP POLICY IF EXISTS "Super admins can view all ai usage" ON public.workspace_ai_usage;
CREATE POLICY "Super admins can view all ai usage"
ON public.workspace_ai_usage
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.platform_access
    WHERE platform_access.user_id = auth.uid()
      AND platform_access.role IN ('owner', 'admin')
  )
);

-- 4. Atomic Increment Function
CREATE OR REPLACE FUNCTION public.fn_increment_workspace_ai_usage(
  p_workspace_id UUID,
  p_period_start DATE,
  p_replies INTEGER DEFAULT 1,
  p_tokens_in INTEGER DEFAULT 0,
  p_tokens_out INTEGER DEFAULT 0
)
RETURNS public.workspace_ai_usage
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row public.workspace_ai_usage;
BEGIN
  INSERT INTO public.workspace_ai_usage (
    workspace_id,
    period_start,
    replies_used,
    tokens_in,
    tokens_out,
    updated_at
  )
  VALUES (
    p_workspace_id,
    p_period_start,
    GREATEST(0, p_replies),
    GREATEST(0, p_tokens_in),
    GREATEST(0, p_tokens_out),
    now()
  )
  ON CONFLICT (workspace_id, period_start)
  DO UPDATE SET
    replies_used = public.workspace_ai_usage.replies_used + GREATEST(0, p_replies),
    tokens_in = public.workspace_ai_usage.tokens_in + GREATEST(0, p_tokens_in),
    tokens_out = public.workspace_ai_usage.tokens_out + GREATEST(0, p_tokens_out),
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;
