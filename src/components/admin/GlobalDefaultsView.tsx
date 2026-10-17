'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Settings,
  Shield,
  CreditCard,
  Bot,
  Share2,
  Lock,
  Save,
  RefreshCw,
  AlertTriangle,
  Sliders,
  CheckCircle2,
  Clock,
  Palette,
  Users,
  ArrowRight,
} from 'lucide-react';
import { adminGetGlobalDefaultsAction, adminSaveGlobalDefaultsAction } from '@/app/actions/platform-control';
import { PlatformSettings } from '@/types/platform-management';
import { PlatformPlan } from '@/types/plans';
import { PLAN_FEATURES, PLAN_LIMITS, PlanFeatureKey, PlanLimitKey } from '@/lib/plans/features';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SkeletonBlock, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

export function GlobalDefaultsView() {
  const toast = useToast();

  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [plans, setPlans] = useState<PlatformPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [defaultPlanSlug, setDefaultPlanSlug] = useState('starter');
  const [defaultTrialDays, setDefaultTrialDays] = useState(14);
  const [signupMode, setSignupMode] = useState<'open' | 'invite_only'>('open');
  const [defaultAiModel, setDefaultAiModel] = useState('claude-3-5-sonnet');
  const [defaultAiTokenLimit, setDefaultAiTokenLimit] = useState(500000);
  const [defaultAiReplyCap, setDefaultAiReplyCap] = useState(1000);
  const [defaultAiCostCap, setDefaultAiCostCap] = useState(50.0);
  const [isMaintenanceMode, setIsMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');
  const [defaultRequire2fa, setDefaultRequire2fa] = useState(false);
  const [defaultDataRetentionDays, setDefaultDataRetentionDays] = useState<number | null>(null);

  // Defaults for limits and features
  const [defaultLimits, setDefaultLimits] = useState<Record<string, number | null>>({});
  const [defaultFeatures, setDefaultFeatures] = useState<Record<string, boolean>>({});
  const [allowedChannels, setAllowedChannels] = useState<string[]>([
    'email',
    'whatsapp',
    'instagram',
    'x',
    'threads',
    'linkedin',
    'tiktok',
  ]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminGetGlobalDefaultsAction();
      setSettings(res.settings);
      setPlans(res.plans);

      setDefaultPlanSlug(res.settings.default_plan_slug || 'starter');
      setDefaultTrialDays(res.settings.default_trial_days || 14);
      setSignupMode(res.settings.signup_mode || 'open');
      setDefaultAiModel(res.settings.default_ai_model || 'claude-3-5-sonnet');
      setDefaultAiTokenLimit(res.settings.default_ai_monthly_token_limit || 500000);

      const aiSettings = (res.settings.default_ai_settings || {}) as any;
      setDefaultAiReplyCap(aiSettings.monthly_reply_cap || 1000);
      setDefaultAiCostCap(aiSettings.monthly_cost_cap_usd || 50.0);

      setIsMaintenanceMode(Boolean(res.settings.is_maintenance_mode));
      setMaintenanceMessage(res.settings.maintenance_message || '');
      setDefaultRequire2fa(Boolean(res.settings.default_require_2fa));
      setDefaultDataRetentionDays(res.settings.default_data_retention_days ?? null);

      setDefaultLimits(res.settings.default_limits || {});
      setDefaultFeatures(res.settings.default_features || {});
      if (res.settings.default_allowed_channels) {
        setAllowedChannels(res.settings.default_allowed_channels);
      }
    } catch (err: any) {
      setError(errorMessage(err, 'Failed to load global defaults.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await adminSaveGlobalDefaultsAction({
        default_plan_slug: defaultPlanSlug,
        default_trial_days: defaultTrialDays,
        signup_mode: signupMode,
        default_ai_model: defaultAiModel,
        default_ai_monthly_token_limit: defaultAiTokenLimit,
        default_ai_settings: {
          enabled: true,
          model: defaultAiModel,
          monthly_token_cap: defaultAiTokenLimit,
          monthly_reply_cap: defaultAiReplyCap,
          monthly_cost_cap_usd: defaultAiCostCap,
        },
        is_maintenance_mode: isMaintenanceMode,
        maintenance_message: maintenanceMessage,
        default_require_2fa: defaultRequire2fa,
        default_data_retention_days: defaultDataRetentionDays,
        default_limits: defaultLimits,
        default_features: defaultFeatures,
        default_allowed_channels: allowedChannels,
      });

      if (res.success) {
        toast.success('Global defaults and platform policies saved.');
        await loadData();
      } else {
        toast.error(res.error || 'Failed to save defaults.');
      }
    } catch (err: any) {
      toast.error(errorMessage(err, 'Error saving defaults.'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <SkeletonBlock className="h-8 w-64" />
        <SkeletonBlock className="h-40 rounded-2xl" />
        <SkeletonBlock className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load global defaults"
        message={error}
        onRetry={loadData}
      />
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-6">
      {/* Header */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-ink tracking-tight flex items-center gap-2">
            <span>Global Defaults & Platform Policies</span>
            <Badge tone="accent" className="text-2xs uppercase">Platform Defaults</Badge>
          </h2>
          <p className="text-xs text-ink-3 mt-1">
            Configure platform-wide fallback settings applied to new workspaces and resolved through precedence.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={loadData}
            disabled={saving}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Reset</span>
          </Button>

          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={saving}
          >
            <Save className="w-3.5 h-3.5 mr-1" />
            <span>Save All Defaults</span>
          </Button>
        </div>
      </div>

      {/* 1. Onboarding & Workspace Defaults */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-4">
        <div className="border-b border-line pb-3">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-accent" />
            <span>New Workspace & Signup Defaults</span>
          </h3>
          <p className="text-xs text-ink-3">Default plan tier, trial durations, and platform access control.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
          <div>
            <label className="text-xs font-medium text-ink-2">Default Initial Plan</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={defaultPlanSlug}
              onChange={(e) => setDefaultPlanSlug(e.target.value)}
            >
              {plans.map((p) => (
                <option key={p.id} value={p.slug}>
                  {p.name} (${p.monthly_price}/mo)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-ink-2">Trial Length (Days)</label>
            <input
              type="number"
              className="input input-sm w-full mt-1.5"
              value={defaultTrialDays}
              onChange={(e) => setDefaultTrialDays(Number(e.target.value) || 0)}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-ink-2">Platform Signup Mode</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={signupMode}
              onChange={(e) => setSignupMode(e.target.value as any)}
            >
              <option value="open">Open (Public registration permitted)</option>
              <option value="invite_only">Invite Only (Invitation required)</option>
            </select>
          </div>
        </div>
      </div>

      {/* 2. Platform Maintenance Mode */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-4">
        <div className="border-b border-line pb-3">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warn" />
            <span>Maintenance Mode</span>
          </h3>
          <p className="text-xs text-ink-3">Lock workspace dashboards for maintenance while allowing owner bypass.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          <div>
            <label className="text-xs font-medium text-ink-2">Maintenance Mode Switch</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={isMaintenanceMode ? 'active' : 'inactive'}
              onChange={(e) => setIsMaintenanceMode(e.target.value === 'active')}
            >
              <option value="inactive">Disabled (Normal Operations)</option>
              <option value="active">Active (Platform Maintenance Enabled)</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-ink-2">Maintenance Notice Message</label>
            <input
              type="text"
              className="input input-sm w-full mt-1.5"
              placeholder="e.g. ZenTry is currently undergoing maintenance."
              value={maintenanceMessage}
              onChange={(e) => setMaintenanceMessage(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* 3. Global AI Defaults */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-4">
        <div className="border-b border-line pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <Bot className="w-4 h-4 text-accent" />
              <span>Global AI Defaults & Caps</span>
            </h3>
            <p className="text-xs text-ink-3">Fallback AI models, token allocations, reply caps, and cost limits.</p>
          </div>
          <Link
            href="/admin/ai"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-accent/10 hover:bg-accent/15 border border-accent/20 text-accent font-semibold text-xs transition-colors self-start sm:self-auto"
          >
            <span>Platform AI Credentials & Usage</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 pt-1">
          <div>
            <label className="text-xs font-medium text-ink-2">Default AI Model</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={defaultAiModel}
              onChange={(e) => setDefaultAiModel(e.target.value)}
            >
              <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
              <option value="claude-3-haiku">Claude 3 Haiku</option>
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4o-mini">GPT-4o Mini</option>
              <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-ink-2">Monthly Token Limit</label>
            <input
              type="number"
              className="input input-sm w-full mt-1.5"
              value={defaultAiTokenLimit}
              onChange={(e) => setDefaultAiTokenLimit(Number(e.target.value) || 0)}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-ink-2">Monthly Reply Cap</label>
            <input
              type="number"
              className="input input-sm w-full mt-1.5"
              value={defaultAiReplyCap}
              onChange={(e) => setDefaultAiReplyCap(Number(e.target.value) || 0)}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-ink-2">Monthly Cost Cap ($ USD)</label>
            <input
              type="number"
              className="input input-sm w-full mt-1.5"
              value={defaultAiCostCap}
              onChange={(e) => setDefaultAiCostCap(Number(e.target.value) || 0)}
            />
          </div>
        </div>
      </div>

      {/* 4. Global Security & Retention Defaults */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-4">
        <div className="border-b border-line pb-3">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2">
            <Shield className="w-4 h-4 text-accent" />
            <span>Global Security & Retention Defaults</span>
          </h3>
          <p className="text-xs text-ink-3">Default team two-factor requirements and data lifecycle durations.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          <div>
            <label className="text-xs font-medium text-ink-2">Default 2FA Requirement</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={defaultRequire2fa ? 'required' : 'optional'}
              onChange={(e) => setDefaultRequire2fa(e.target.value === 'required')}
            >
              <option value="optional">Optional for team members</option>
              <option value="required">Strictly required for all team members</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-ink-2">Default Data Retention</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={defaultDataRetentionDays !== null ? String(defaultDataRetentionDays) : 'indefinite'}
              onChange={(e) => {
                const val = e.target.value === 'indefinite' ? null : Number(e.target.value);
                setDefaultDataRetentionDays(val);
              }}
            >
              <option value="indefinite">Indefinite (Keep all history)</option>
              <option value="30">30 Days</option>
              <option value="90">90 Days</option>
              <option value="180">180 Days</option>
              <option value="365">1 Year (365 Days)</option>
            </select>
          </div>
        </div>
      </div>

      {/* 5. Allowed Channels */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-4">
        <div className="border-b border-line pb-3">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2">
            <Share2 className="w-4 h-4 text-accent" />
            <span>Platform-Allowed Channels</span>
          </h3>
          <p className="text-xs text-ink-3">Select which communication channels are enabled across the platform.</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          {['email', 'whatsapp', 'instagram', 'x', 'threads', 'linkedin', 'tiktok'].map((ch) => {
            const isChecked = allowedChannels.includes(ch);
            return (
              <label
                key={ch}
                className={cn(
                  'flex items-center gap-2.5 p-3 rounded-xl border text-xs cursor-pointer select-none transition-colors',
                  isChecked
                    ? 'bg-accent/5 border-accent/30 text-ink font-semibold'
                    : 'bg-surface-2 border-line text-ink-3 hover:text-ink'
                )}
              >
                <input
                  type="checkbox"
                  className="rounded border-line text-accent focus:ring-accent"
                  checked={isChecked}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setAllowedChannels([...allowedChannels, ch]);
                    } else {
                      setAllowedChannels(allowedChannels.filter((c) => c !== ch));
                    }
                  }}
                />
                <span className="capitalize">{ch}</span>
              </label>
            );
          })}
        </div>
      </div>
    </form>
  );
}
