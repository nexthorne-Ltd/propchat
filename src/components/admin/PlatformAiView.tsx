'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Bot,
  Sparkles,
  KeyRound,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Save,
  Layers,
  Search,
  Activity,
  Edit2,
  X,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SkeletonBlock, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import {
  getPlatformAiSettingsAction,
  savePlatformAiSettingsAction,
  testPlatformAiConnectionAction,
  getPlatformAiUsageAction,
  PlatformAiUsageOverview,
} from '@/app/actions/platform-ai';
import { getPlatformPlansAction, savePlanAction } from '@/app/actions/plans';
import { PlatformPlan } from '@/types/plans';
import { PlatformAiSettingsDTO } from '@/types/platform-management';
import { ProviderId, DEFAULT_MODELS, PROVIDER_LABELS } from '@/lib/ai/provider';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';
import { PlatformJevSettings } from './PlatformJevSettings';

export function PlatformAiView() {
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Settings State
  const [settings, setSettings] = useState<PlatformAiSettingsDTO | null>(null);
  const [provider, setProvider] = useState<ProviderId>('anthropic');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isEnabled, setIsEnabled] = useState(false);

  // Connection Test Result
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    model?: string;
    error?: string;
  } | null>(null);

  // Plans & Limits State
  const [plans, setPlans] = useState<PlatformPlan[]>([]);
  const [editingPlan, setEditingPlan] = useState<PlatformPlan | null>(null);
  const [planAiEnabled, setPlanAiEnabled] = useState(true);
  const [planReplyLimit, setPlanReplyLimit] = useState<string>('');
  const [savingPlan, setSavingPlan] = useState(false);

  // Usage Overview State
  const [usageOverview, setUsageOverview] = useState<PlatformAiUsageOverview | null>(null);
  const [usageSearch, setUsageSearch] = useState('');
  const [usageFilter, setUsageFilter] = useState<'all' | 'limit_reached' | 'active' | 'disabled'>('all');

  const loadData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const [settingsRes, usageRes, plansRes] = await Promise.all([
        getPlatformAiSettingsAction(),
        getPlatformAiUsageAction(),
        getPlatformPlansAction(),
      ]);

      if (settingsRes.success && settingsRes.settings) {
        setSettings(settingsRes.settings);
        setProvider(settingsRes.settings.provider || 'anthropic');
        setBaseUrl(settingsRes.settings.base_url || '');
        setModel(settingsRes.settings.model || '');
        setIsEnabled(settingsRes.settings.is_enabled);
        setApiKeyInput(''); // Write-only: blank on load
      }

      if (usageRes.success && usageRes.overview) {
        setUsageOverview(usageRes.overview);
      }

      if (plansRes.plans) {
        setPlans(plansRes.plans);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? errorMessage(err) : String(err);
      setError(msg || 'Failed to load platform AI configuration.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [settingsRes, usageRes, plansRes] = await Promise.all([
          getPlatformAiSettingsAction(),
          getPlatformAiUsageAction(),
          getPlatformPlansAction(),
        ]);
        if (!active) return;

        if (settingsRes.success && settingsRes.settings) {
          setSettings(settingsRes.settings);
          setProvider(settingsRes.settings.provider || 'anthropic');
          setBaseUrl(settingsRes.settings.base_url || '');
          setModel(settingsRes.settings.model || '');
          setIsEnabled(settingsRes.settings.is_enabled);
          setApiKeyInput('');
        }

        if (usageRes.success && usageRes.overview) {
          setUsageOverview(usageRes.overview);
        }

        if (plansRes.plans) {
          setPlans(plansRes.plans);
        }
      } catch (err: unknown) {
        if (!active) return;
        const msg = err instanceof Error ? errorMessage(err) : String(err);
        setError(msg || 'Failed to load platform AI configuration.');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setTestResult(null);

    try {
      const res = await savePlatformAiSettingsAction({
        provider,
        base_url: provider === 'compatible' ? baseUrl : null,
        model: model || null,
        api_key: apiKeyInput ? apiKeyInput.trim() : null,
        is_enabled: isEnabled,
      });

      if (res.success && res.settings) {
        setSettings(res.settings);
        setApiKeyInput('');
        toast.success('Platform AI settings saved successfully.');
      } else {
        toast.error(res.error || 'Failed to save settings.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? errorMessage(err) : String(err);
      toast.error(msg || 'Error saving settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    setTestResult(null);

    try {
      const res = await testPlatformAiConnectionAction({
        provider,
        base_url: provider === 'compatible' ? baseUrl : null,
        model: model || null,
        api_key: apiKeyInput ? apiKeyInput.trim() : undefined,
      });

      setTestResult(res);
      if (res.ok) {
        toast.success(`Connection successful! ${res.model || 'Model'} replied.`);
      } else {
        toast.error(res.error || 'Connection test failed.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? errorMessage(err) : String(err);
      setTestResult({ ok: false, error: msg || 'Connection test failed.' });
      toast.error(msg || 'Connection test failed.');
    } finally {
      setTestingConnection(false);
    }
  };

  const handleOpenPlanEdit = (plan: PlatformPlan) => {
    setEditingPlan(plan);
    setPlanAiEnabled(plan.ai_enabled ?? true);
    setPlanReplyLimit(plan.ai_monthly_reply_limit !== null && plan.ai_monthly_reply_limit !== undefined ? String(plan.ai_monthly_reply_limit) : '');
  };

  const handleSavePlanLimits = async () => {
    if (!editingPlan) return;
    setSavingPlan(true);

    try {
      const parsedLimit = planReplyLimit.trim() === '' ? null : Number(planReplyLimit);
      if (parsedLimit !== null && (isNaN(parsedLimit) || parsedLimit < 0)) {
        toast.error('Monthly reply limit must be a positive integer or empty for unlimited.');
        setSavingPlan(false);
        return;
      }

      const res = await savePlanAction({
        ...editingPlan,
        ai_enabled: planAiEnabled,
        ai_monthly_reply_limit: parsedLimit,
      });

      if (res.success) {
        toast.success(`Plan "${editingPlan.name}" updated successfully.`);
        setEditingPlan(null);
        await loadData();
      } else {
        toast.error(res.error || 'Failed to update plan limits.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? errorMessage(err) : String(err);
      toast.error(msg || 'Error updating plan.');
    } finally {
      setSavingPlan(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <SkeletonBlock className="h-8 w-64" />
        <SkeletonBlock className="h-44 rounded-2xl" />
        <SkeletonBlock className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load Platform AI Settings"
        message={error}
        onRetry={loadData}
      />
    );
  }

  const defaultModelForProvider = DEFAULT_MODELS[provider] || '';

  // Filtered workspace usage list
  const filteredUsage = (usageOverview?.workspaceBreakdown || []).filter((item) => {
    if (usageSearch.trim()) {
      const q = usageSearch.toLowerCase();
      if (!item.workspaceName.toLowerCase().includes(q) && !item.planName.toLowerCase().includes(q)) {
        return false;
      }
    }
    if (usageFilter === 'limit_reached') return item.status === 'limit_reached' || item.status === 'near_limit';
    if (usageFilter === 'active') return item.status === 'normal' || item.status === 'near_limit';
    if (usageFilter === 'disabled') return item.status === 'disabled';
    return true;
  });

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-ink tracking-tight flex items-center gap-2">
              <Bot className="w-5 h-5 text-accent" />
              <span>Platform AI Model & Usage</span>
            </h2>
            <Badge tone="accent" className="text-2xs font-mono">Platform Level</Badge>
          </div>
          <p className="text-xs text-ink-3 mt-1">
            Global LLM API credentials managed exclusively by platform super administration. Workspaces access AI through their plan.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              void loadData(true);
            }}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* ────────────────────────────────────────────────────────────────────────── */}
      {/* 1. AI MODEL CREDENTIALS SECTION */}
      {/* ────────────────────────────────────────────────────────────────────────── */}
      <form onSubmit={handleSaveSettings} className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-line pb-4">
          <div>
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-accent" />
              <span>AI Model Configuration</span>
            </h3>
            <p className="text-xs text-ink-3">
              Write-only API key: only the last 4 characters are shown after saving. Never sent to client browsers.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <span className="text-xs font-semibold text-ink">Enable Platform AI</span>
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={(e) => setIsEnabled(e.target.checked)}
                className="rounded border-line text-accent focus:ring-accent w-4 h-4 cursor-pointer"
              />
            </label>
            <Badge tone={isEnabled ? 'success' : 'neutral'} className="text-2xs">
              {isEnabled ? 'Active' : 'Disabled'}
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Provider */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-ink-2">Model Provider</label>
            <select
              value={provider}
              onChange={(e) => {
                const next = e.target.value as ProviderId;
                setProvider(next);
                setModel(''); // Clear custom model to allow new provider default
              }}
              className="input input-sm w-full"
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google (Gemini)</option>
              <option value="deepseek">DeepSeek</option>
              <option value="compatible">Other — OpenAI-compatible Endpoint</option>
            </select>
            <p className="text-2xs text-ink-3">
              {provider === 'compatible'
                ? 'Compatible with OpenRouter, Groq, Together, vLLM, or local Ollama serving /chat/completions.'
                : `Official ${PROVIDER_LABELS[provider]} API.`}
            </p>
          </div>

          {/* Model Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-ink-2">Model Name</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={defaultModelForProvider || 'e.g. claude-3-5-sonnet'}
              className="input input-sm w-full font-mono text-xs"
            />
            <p className="text-2xs text-ink-3">
              Leave blank to use default ({defaultModelForProvider || 'standard model'}).
            </p>
          </div>

          {/* Base URL (if compatible) */}
          {provider === 'compatible' && (
            <div className="space-y-1.5 md:col-span-2">
              <label className="text-xs font-semibold text-ink-2">Base URL</label>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://openrouter.ai/api/v1"
                className="input input-sm w-full font-mono text-xs"
              />
              <p className="text-2xs text-ink-3">
                Endpoint without the trailing <code className="font-mono">/chat/completions</code> path.
              </p>
            </div>
          )}

          {/* API Key (Write-only) */}
          <div className="space-y-1.5 md:col-span-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-ink-2">Provider API Key</label>
              {settings?.has_key && (
                <span className="text-2xs font-mono text-ink-3 bg-surface-2 px-2 py-0.5 rounded border border-line">
                  Saved Key: ••••••••••••{settings.key_last4}
                </span>
              )}
            </div>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={
                settings?.has_key
                  ? `••••••••••••${settings.key_last4} (Type new key to replace)`
                  : 'Paste platform secret API key'
              }
              className="input input-sm w-full font-mono text-xs"
              autoComplete="new-password"
            />
            <p className="text-2xs text-ink-3">
              Write-only field. Stored server-side in <code className="font-mono">platform_ai_settings</code> with service-role RLS lockdown. Never returned to the client.
            </p>
          </div>
        </div>

        {/* Test Result Display */}
        {testResult && (
          <div
            className={cn(
              'p-3.5 rounded-xl border text-xs flex items-start gap-2.5',
              testResult.ok
                ? 'bg-success/5 border-success/30 text-success'
                : 'bg-danger/5 border-danger/30 text-danger'
            )}
          >
            {testResult.ok ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <div>
              <p className="font-semibold">
                {testResult.ok ? 'Connection Verified' : 'Connection Failed'}
              </p>
              <p className="text-2xs mt-0.5">
                {testResult.ok
                  ? `Successfully contacted provider. Model "${testResult.model}" replied.`
                  : testResult.error}
              </p>
            </div>
          </div>
        )}

        {/* Buttons */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleTestConnection}
            loading={testingConnection}
            disabled={savingSettings || (!apiKeyInput && !settings?.has_key)}
          >
            <Sparkles className="w-3.5 h-3.5 mr-1 text-accent" />
            <span>Test Connection</span>
          </Button>

          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={savingSettings}
          >
            <Save className="w-3.5 h-3.5 mr-1" />
            <span>Save AI Settings</span>
          </Button>
        </div>
      </form>

      {/* Jev (TypeSafe): fast typed decisions beside the model above, for every workspace. */}
      <PlatformJevSettings />

      {/* ────────────────────────────────────────────────────────────────────────── */}
      {/* 2. PLAN AI QUOTAS & LIMITS (Create / Edit Plan AI Limits) */}
      {/* ────────────────────────────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-4">
        <div className="border-b border-line pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <Layers className="w-4 h-4 text-accent" />
              <span>Plan AI Entitlements & Quotas</span>
            </h3>
            <p className="text-xs text-ink-3">
              Configure whether each subscription tier includes AI access and set monthly reply limits.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-1">
          {plans.map((p) => {
            const isAiOn = p.ai_enabled ?? true;
            const replyLimit = p.ai_monthly_reply_limit;

            return (
              <div
                key={p.id}
                className="p-4 rounded-xl border border-line bg-surface-2 flex flex-col justify-between space-y-3"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-ink">{p.name}</span>
                    <Badge tone={isAiOn ? 'success' : 'neutral'} className="text-2xs">
                      {isAiOn ? 'AI Enabled' : 'AI Off'}
                    </Badge>
                  </div>
                  <p className="text-2xs text-ink-3 mt-1">${p.monthly_price}/month</p>

                  <div className="mt-3 pt-3 border-t border-line space-y-1.5">
                    <div className="text-2xs text-ink-3 flex items-center justify-between">
                      <span>Monthly Reply Limit:</span>
                      <strong className="text-ink font-semibold">
                        {replyLimit === null ? 'Unlimited' : `${replyLimit.toLocaleString()} replies`}
                      </strong>
                    </div>
                  </div>
                </div>

                <Button
                  variant="secondary"
                  size="xs"
                  className="w-full mt-2"
                  onClick={() => handleOpenPlanEdit(p)}
                >
                  <Edit2 className="w-3 h-3 mr-1" />
                  <span>Configure AI Limit</span>
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ────────────────────────────────────────────────────────────────────────── */}
      {/* 3. PLATFORM & PER-WORKSPACE AI USAGE VIEW */}
      {/* ────────────────────────────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-line pb-4">
          <div>
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <Activity className="w-4 h-4 text-accent" />
              <span>Platform & Workspace AI Usage</span>
            </h3>
            <p className="text-xs text-ink-3">
              Period: <strong className="text-ink">{usageOverview?.currentPeriodStart || 'Current Month'}</strong>. Replies used vs monthly plan allocation.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                type="text"
                placeholder="Search workspace..."
                value={usageSearch}
                onChange={(e) => setUsageSearch(e.target.value)}
                className="input input-xs pl-8 w-44"
              />
            </div>

            <select
              value={usageFilter}
              onChange={(e) => setUsageFilter(e.target.value as 'all' | 'limit_reached' | 'active' | 'disabled')}
              className="input input-xs"
            >
              <option value="all">All Statuses</option>
              <option value="limit_reached">Near or At Limit</option>
              <option value="active">Active</option>
              <option value="disabled">AI Disabled</option>
            </select>
          </div>
        </div>

        {/* Aggregated Totals */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl border border-line bg-surface-2">
            <span className="text-2xs font-semibold text-ink-3 uppercase tracking-wider">Platform Total AI Replies</span>
            <div className="text-2xl font-bold text-ink mt-1">
              {(usageOverview?.platformTotalReplies || 0).toLocaleString()}
            </div>
            <p className="text-2xs text-ink-4 mt-0.5">Total bot replies generated this month</p>
          </div>

          <div className="p-4 rounded-xl border border-line bg-surface-2">
            <span className="text-2xs font-semibold text-ink-3 uppercase tracking-wider">Avg Tokens Per Reply</span>
            <div className="text-2xl font-bold text-accent mt-1">
              {(usageOverview?.platformAverageTokensPerReply || 0).toLocaleString()}
            </div>
            <p className="text-2xs text-ink-4 mt-0.5">Tokens in + out across all bot calls</p>
          </div>

          <div className="p-4 rounded-xl border border-line bg-surface-2">
            <span className="text-2xs font-semibold text-ink-3 uppercase tracking-wider">Workspaces with AI</span>
            <div className="text-2xl font-bold text-ink mt-1">
              {(usageOverview?.workspacesWithAi || 0).toLocaleString()}
            </div>
            <p className="text-2xs text-ink-4 mt-0.5">Enrolled on plans with active AI access</p>
          </div>

          <div className="p-4 rounded-xl border border-line bg-surface-2">
            <span className="text-2xs font-semibold text-ink-3 uppercase tracking-wider">Workspaces At / Near Limit</span>
            <div className="text-2xl font-bold text-ink mt-1 text-warn">
              {(usageOverview?.workspacesNearOrAtLimit || 0).toLocaleString()}
            </div>
            <p className="text-2xs text-ink-4 mt-0.5">Using &ge;80% of monthly reply ceiling</p>
          </div>
        </div>

        {/* Usage Breakdown Table */}
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-xs text-left">
            <thead className="bg-surface-2 border-b border-line text-ink-3 uppercase font-semibold text-2xs tracking-wider">
              <tr>
                <th className="px-4 py-3">Workspace</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Replies Used / Limit</th>
                <th className="px-4 py-3">Avg / Total Tokens</th>
                <th className="px-4 py-3">Utilization</th>
                <th className="px-4 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line bg-surface">
              {filteredUsage.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-3">
                    No workspace usage records matched the criteria.
                  </td>
                </tr>
              ) : (
                filteredUsage.map((row) => (
                  <tr key={row.workspaceId} className="hover:bg-surface-2/60 transition-colors">
                    <td className="px-4 py-3 font-semibold text-ink">
                      {row.workspaceName}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {row.planName}
                    </td>
                    <td className="px-4 py-3 font-mono">
                      {row.repliesUsed.toLocaleString()} / {row.monthlyLimit === null ? '∞' : row.monthlyLimit.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-ink-2">
                      <div className="flex flex-col">
                        <span>{row.avgTokensPerReply.toLocaleString()} avg</span>
                        <span className="text-2xs text-ink-3">{(row.tokensIn + row.tokensOut).toLocaleString()} total</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 w-48">
                      {row.monthlyLimit !== null ? (
                        <div className="space-y-1">
                          <div className="w-full bg-surface-3 h-1.5 rounded-full overflow-hidden">
                            <div
                              className={cn(
                                'h-full transition-all',
                                row.status === 'limit_reached'
                                  ? 'bg-danger'
                                  : row.status === 'near_limit'
                                  ? 'bg-warn'
                                  : 'bg-accent'
                              )}
                              style={{ width: `${row.percentage}%` }}
                            />
                          </div>
                          <span className="text-2xs text-ink-3 font-mono">{row.percentage}%</span>
                        </div>
                      ) : (
                        <span className="text-2xs text-ink-3 font-mono">Unlimited</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Badge
                        tone={
                          row.status === 'limit_reached'
                            ? 'danger'
                            : row.status === 'near_limit'
                            ? 'warn'
                            : row.status === 'disabled'
                            ? 'neutral'
                            : 'success'
                        }
                        className="text-2xs uppercase"
                      >
                        {row.status.replace('_', ' ')}
                      </Badge>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ────────────────────────────────────────────────────────────────────────── */}
      {/* EDIT PLAN MODAL */}
      {/* ────────────────────────────────────────────────────────────────────────── */}
      {editingPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
          <div className="bg-surface border border-line rounded-2xl p-6 shadow-xl max-w-md w-full space-y-5">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h4 className="text-sm font-bold text-ink flex items-center gap-2">
                <Edit2 className="w-4 h-4 text-accent" />
                <span>Configure AI for {editingPlan.name}</span>
              </h4>
              <button
                type="button"
                onClick={() => setEditingPlan(null)}
                className="text-ink-3 hover:text-ink transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              {/* AI Enabled Toggle */}
              <div className="flex items-center justify-between p-3.5 bg-surface-2 border border-line rounded-xl">
                <div>
                  <span className="text-xs font-semibold text-ink">AI Enabled</span>
                  <p className="text-2xs text-ink-3">Allow workspaces on this plan to use autonomous bot replies.</p>
                </div>
                <input
                  type="checkbox"
                  checked={planAiEnabled}
                  onChange={(e) => setPlanAiEnabled(e.target.checked)}
                  className="rounded border-line text-accent focus:ring-accent w-4 h-4 cursor-pointer"
                />
              </div>

              {/* Monthly Reply Limit */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-ink-2">Monthly AI Reply Limit</label>
                <input
                  type="number"
                  value={planReplyLimit}
                  onChange={(e) => setPlanReplyLimit(e.target.value)}
                  placeholder="Leave blank for Unlimited"
                  className="input input-sm w-full font-mono text-xs"
                />
                <p className="text-2xs text-ink-3">
                  Maximum bot answers permitted per billing cycle. Empty / blank means unlimited.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-line">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEditingPlan(null)}
                disabled={savingPlan}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSavePlanLimits}
                loading={savingPlan}
              >
                <Check className="w-3.5 h-3.5 mr-1" />
                <span>Save Limits</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
