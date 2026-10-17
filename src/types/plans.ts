import { PlanFeatureKey, PlanLimitKey } from '@/lib/plans/features';

export interface PlatformPlan {
  id: string;
  slug: string;
  name: string;
  description: string;
  monthly_price: number;
  yearly_price: number;
  currency: string;
  trial_days: number;
  visibility: 'public' | 'hidden' | 'custom';
  custom_workspace_id: string | null;
  is_popular: boolean;
  is_archived: boolean;
  is_default: boolean;
  sort_order: number;
  version: number;

  // Limits (null = unlimited)
  max_agents: number | null;
  max_tickets_per_month: number | null;
  max_ai_bot_replies_per_month: number | null;
  max_channels_connected: number | null;
  max_articles: number | null;
  max_automations: number | null;
  max_storage_mb: number | null;
  max_api_requests_per_month: number | null;

  ai_enabled: boolean;
  ai_monthly_reply_limit: number | null;

  features: Record<PlanFeatureKey, boolean>;

  created_at: string;
  updated_at: string;
}

export interface PlatformPlanVersion {
  id: string;
  plan_id: string;
  version: number;
  monthly_price: number;
  yearly_price: number;
  currency: string;
  max_agents: number | null;
  max_tickets_per_month: number | null;
  max_ai_bot_replies_per_month: number | null;
  max_channels_connected: number | null;
  max_articles: number | null;
  max_automations: number | null;
  max_storage_mb: number | null;
  max_api_requests_per_month: number | null;
  ai_enabled: boolean;
  ai_monthly_reply_limit: number | null;
  features: Record<PlanFeatureKey, boolean>;
  created_at: string;
}

export interface WorkspaceAiUsage {
  id: string;
  workspace_id: string;
  period_start: string;
  replies_used: number;
  tokens_in: number;
  tokens_out: number;
  created_at: string;
  updated_at: string;
}

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'suspended';

export type BillingPeriod = 'monthly' | 'yearly';

export interface WorkspaceSubscription {
  id: string;
  workspace_id: string;
  plan_id: string;
  plan_version: number;
  status: SubscriptionStatus;
  billing_period: BillingPeriod;
  current_period_start: string;
  current_period_end: string;
  trial_ends_at: string | null;
  canceled_at: string | null;
  custom_limits: Partial<Record<PlanLimitKey, number | null>>;
  custom_features: Partial<Record<PlanFeatureKey, boolean>>;
  admin_note: string | null;
  created_at: string;
  updated_at: string;
  plan?: PlatformPlan;
}

export interface WorkspaceUsageRecord {
  id: string;
  workspace_id: string;
  period_start: string;
  period_end: string;
  tickets_count: number;
  ai_bot_replies_count: number;
  api_requests_count: number;
  storage_bytes: number;
  updated_at: string;
}

export interface PlatformCoupon {
  id: string;
  code: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  currency: string;
  valid_from: string;
  valid_until: string | null;
  max_redemptions: number | null;
  redemptions_count: number;
  allowed_plan_ids: string[] | null;
  is_active: boolean;
  created_at: string;
}

export interface WorkspaceUsageMetric {
  key: PlanLimitKey;
  name: string;
  unit: string;
  currentUsage: number;
  limit: number | null;
  isUnlimited: boolean;
  isNearLimit: boolean; // >= 80%
  percentage: number;
}

export interface WorkspaceFeatureItem {
  key: PlanFeatureKey;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}

export interface WorkspaceBillingOverview {
  subscription: WorkspaceSubscription;
  plan: PlatformPlan;
  limits: WorkspaceUsageMetric[];
  features: WorkspaceFeatureItem[];
  trialDaysRemaining: number | null;
  isTrialExpired: boolean;
  canManageBilling: boolean;
}
