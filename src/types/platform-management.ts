import { PlanLimitKey, PlanFeatureKey } from '@/lib/plans/features';
import { PlatformPlan, SubscriptionStatus, BillingPeriod } from './plans';

export type PlatformStaffRole = 'owner' | 'support' | 'finance';

export interface WorkspaceInvoice {
  id: string;
  workspace_id: string;
  subscription_id?: string | null;
  invoice_number: string;
  amount: number;
  currency: string;
  status: 'paid' | 'open' | 'void' | 'uncollectible';
  billing_reason: 'subscription_cycle' | 'subscription_create' | 'subscription_update' | 'manual_payment';
  payment_method: 'lemonsqueezy' | 'manual_bank_transfer' | 'manual_crypto' | 'manual_check' | 'manual_other';
  payment_reference?: string | null;
  hosted_invoice_url?: string | null;
  pdf_url?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  paid_at?: string | null;
  created_at: string;
}

export interface SupportSession {
  id: string;
  admin_user_id: string;
  admin_email: string;
  workspace_id: string;
  workspace_name: string;
  session_token: string;
  reason: string;
  started_at: string;
  expires_at: string;
  ended_at?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  created_at: string;
}

export interface PlatformFeatureFlag {
  id: string;
  key: string;
  name: string;
  description: string;
  is_enabled_globally: boolean;
  enabled_plan_ids: string[];
  enabled_workspace_ids: string[];
  disabled_workspace_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface PlatformAnnouncement {
  id: string;
  title: string;
  message: string;
  display_type: 'banner' | 'modal' | 'card';
  tone: 'info' | 'warning' | 'success' | 'urgent';
  target_audience: 'all' | 'plans' | 'workspaces';
  target_plan_ids: string[];
  target_workspace_ids: string[];
  start_date: string;
  end_date?: string | null;
  is_dismissible: boolean;
  is_active: boolean;
  created_at: string;
}

export interface PlatformSettings {
  id: string;
  default_plan_slug: string;
  default_trial_days: number;
  signup_mode: 'open' | 'invite_only';
  default_ai_model: string;
  default_ai_monthly_token_limit: number;
  email_sender_name: string;
  email_sender_address: string;
  email_brand_color: string;
  email_logo_url?: string | null;
  email_footer_text: string;
  is_maintenance_mode: boolean;
  maintenance_message: string;
  maintenance_bypass_emails: string[];
  default_limits?: Record<string, number | null>;
  default_features?: Record<string, boolean>;
  default_ai_settings?: Record<string, any>;
  default_allowed_channels?: string[];
  default_require_2fa?: boolean;
  default_data_retention_days?: number | null;
  default_widget_settings?: Record<string, any>;
  updated_at: string;
}

export type EmailTemplateKey = 'welcome' | 'trial_ending' | 'payment_failed' | 'limit_reached';

export interface PlatformEmailTemplate {
  id: string;
  template_key: EmailTemplateKey;
  name: string;
  subject: string;
  body_text: string;
  body_html: string;
  available_variables: string[];
  updated_at: string;
}

export interface WorkspaceAiUsageDaily {
  id: string;
  workspace_id: string;
  usage_date: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  requests_count: number;
  model_breakdown: Record<string, { prompt: number; completion: number; cost: number }>;
  created_at: string;
}

export interface PlatformBlockedDomain {
  id: string;
  domain: string;
  reason: string;
  blocked_by?: string | null;
  created_at: string;
}

export interface RevenueMetrics {
  mrr: number;
  arr: number;
  newMrr30d: number;
  churnedMrr30d: number;
  planBreakdown: Array<{
    planId: string;
    planName: string;
    subscriberCount: number;
    mrr: number;
  }>;
}

export interface PlatformStaffMember {
  id: string;
  name: string;
  email: string;
  role: PlatformStaffRole;
  is_active: boolean;
  is_platform_owner: boolean;
  created_at: string;
}

export interface PlatformAiSettings {
  id: boolean;
  provider: 'anthropic' | 'openai' | 'google' | 'deepseek' | 'compatible';
  base_url: string | null;
  model: string | null;
  api_key: string | null;
  is_enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

export interface PlatformAiSettingsDTO {
  provider: 'anthropic' | 'openai' | 'google' | 'deepseek' | 'compatible';
  base_url: string | null;
  model: string | null;
  is_enabled: boolean;
  has_key: boolean;
  key_last4: string | null;
  updated_at: string;
}
