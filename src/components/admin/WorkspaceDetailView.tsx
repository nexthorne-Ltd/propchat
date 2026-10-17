'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Building2,
  Globe,
  Users,
  CreditCard,
  Gauge,
  Sliders,
  Share2,
  Bot,
  Palette,
  BookOpen,
  ShieldAlert,
  Activity,
  ArrowLeft,
  ChevronRight,
  RefreshCw,
  Lock,
  Unlock,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Sparkles,
  ExternalLink,
  DollarSign,
  Download,
  Trash2,
  LogOut,
  UserCheck,
  UserX,
  Mail,
  Zap,
} from 'lucide-react';
import {
  getAdminWorkspaceControlAction,
  adminUpdateWorkspacePlanAction,
  adminRecordManualPaymentAction,
  adminToggleWorkspaceSuspensionAction,
  adminUpdateWorkspaceLimitsAction,
  adminUpdateWorkspaceFeaturesAction,
  adminChangeMemberRoleAction,
  adminToggleMemberActiveAction,
  adminTransferWorkspaceOwnershipAction,
  adminForceLogoutSessionsAction,
  adminToggleChannelDisabledAction,
  adminToggleOutboundBlockedAction,
  adminUpdateAiControlAction,
  adminUpdateWidgetControlAction,
  adminToggleHelpCenterPublishedAction,
  adminApproveCustomDomainAction,
  adminRemoveCustomDomainAction,
  adminUpdateSecurityControlAction,
  adminToggleSettingLockAction,
  AdminWorkspaceControlData,
} from '@/app/actions/platform-control';
import { exportWorkspaceDataAction, scheduleWorkspaceDeletionAction, cancelWorkspaceDeletionAction } from '@/app/actions/platform-management';
import { PLAN_FEATURES, PLAN_LIMITS, PlanFeatureKey, PlanLimitKey } from '@/lib/plans/features';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { Modal } from '@/components/ui/Modal';
import { Tabs } from '@/components/ui/Tabs';
import { Table } from '@/components/ui/Table';
import { SkeletonBlock, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils';
import { SubscriptionStatus, BillingPeriod } from '@/types/plans';
import { errorMessage } from '@/lib/errors/user-error';

interface WorkspaceDetailViewProps {
  workspaceId: string;
}

type ControlTab =
  | 'plan_billing'
  | 'usage_limits'
  | 'features'
  | 'team'
  | 'channels'
  | 'ai_bot'
  | 'widget'
  | 'helpcenter'
  | 'security_data'
  | 'activity';

export function WorkspaceDetailView({ workspaceId }: WorkspaceDetailViewProps) {
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<AdminWorkspaceControlData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Active Tab
  const [activeTab, setActiveTab] = useState<ControlTab>('plan_billing');

  // Modals state
  const [suspendModalOpen, setSuspendModalOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('29');
  const [paymentMethod, setPaymentMethod] = useState<'manual_bank_transfer' | 'manual_crypto' | 'manual_check' | 'manual_other'>('manual_bank_transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentExtendDays, setPaymentExtendDays] = useState('30');
  const [paymentNotes, setPaymentNotes] = useState('');

  const [transferOwnerModalOpen, setTransferOwnerModalOpen] = useState(false);
  const [selectedNewOwnerId, setSelectedNewOwnerId] = useState('');

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleteReason, setDeleteReason] = useState('');

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const res = await getAdminWorkspaceControlAction(workspaceId);
      setData(res);
    } catch (err: any) {
      setError(errorMessage(err, 'Failed to load workspace control center.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Lock Toggle Helper
  const handleToggleLock = async (settingKey: string, currentLocked: boolean) => {
    try {
      const res = await adminToggleSettingLockAction(workspaceId, settingKey, !currentLocked);
      if (!res.success) {
        toast.error(res.error || 'Failed to update lock status.');
      } else {
        toast.success(`Setting ${!currentLocked ? 'locked' : 'unlocked'} successfully.`);
        await loadData(true);
      }
    } catch (err: any) {
      toast.error(errorMessage(err, 'Error toggling lock.'));
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <SkeletonBlock className="h-6 w-64" />
        <SkeletonBlock className="h-28 rounded-xl" />
        <SkeletonBlock className="h-10 w-96" />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <SkeletonBlock className="h-72 rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <ErrorState
        title="Could not load workspace"
        message={error || 'Workspace could not be located.'}
        onRetry={() => loadData()}
      />
    );
  }

  const { resolved, plans, members, channels, usage, invoices, recentActivity } = data;
  const { workspace, subscription, plan, locks, features, limits, ai, channels: channelConfig, widget: widgetConfig, helpCenter: hcConfig, security: secConfig } = resolved;
  const isSuspended = Boolean(workspace.is_suspended);

  const TAB_ITEMS: { id: ControlTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'plan_billing', label: 'Plan & Billing', icon: CreditCard },
    { id: 'usage_limits', label: 'Usage & Limits', icon: Gauge },
    { id: 'features', label: 'Features', icon: Sliders },
    { id: 'team', label: 'Team & Roles', icon: Users },
    { id: 'channels', label: 'Channels', icon: Share2 },
    { id: 'ai_bot', label: 'AI Bot', icon: Bot },
    { id: 'widget', label: 'Widget & Branding', icon: Palette },
    { id: 'helpcenter', label: 'Help Center', icon: BookOpen },
    { id: 'security_data', label: 'Security & Data', icon: ShieldAlert },
    { id: 'activity', label: 'Activity Log', icon: Activity },
  ];

  return (
    <div className="space-y-6">
      {/* Breadcrumb Navigation */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-ink-3">
        <Link href="/admin" className="hover:text-ink transition-colors flex items-center gap-1">
          <Building2 className="w-3.5 h-3.5" />
          <span>Platform Admin</span>
        </Link>
        <ChevronRight className="w-3 h-3" />
        <Link href="/admin/workspaces" className="hover:text-ink transition-colors">
          <span>Workspaces</span>
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-ink font-medium truncate max-w-xs">{workspace.name}</span>
      </nav>

      {/* Top Header Card */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-surface-2 border border-line flex items-center justify-center overflow-hidden shrink-0">
            {workspace.logo_url ? (
              <img src={workspace.logo_url} alt={workspace.name} className="w-full h-full object-cover" />
            ) : (
              <Building2 className="w-7 h-7 text-ink-3" />
            )}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-ink tracking-tight">{workspace.name}</h1>
              <Badge tone={isSuspended ? 'danger' : 'success'} className="text-2xs uppercase">
                {isSuspended ? 'Suspended' : 'Active'}
              </Badge>
              <Badge tone="accent" className="text-2xs capitalize">
                {plan?.name || workspace.plan || 'Free Plan'}
              </Badge>
              {subscription?.status === 'trialing' && (
                <Badge tone="warn" className="text-2xs">Trial</Badge>
              )}
            </div>
            <p className="text-xs text-ink-3 mt-1 flex flex-wrap items-center gap-3">
              <span>ID: <code className="font-mono text-ink-2">{workspace.id}</code></span>
              {workspace.website_url && (
                <a
                  href={workspace.website_url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-accent flex items-center gap-1"
                >
                  <Globe className="w-3 h-3" />
                  <span>{workspace.website_url}</span>
                </a>
              )}
              <span>Created: {new Date(workspace.created_at).toLocaleDateString()}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => loadData(true)}
            disabled={refreshing}
            title="Refresh workspace data"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
            <span>Refresh</span>
          </Button>

          <Button
            variant={isSuspended ? 'primary' : 'danger'}
            size="sm"
            onClick={() => {
              if (isSuspended) {
                adminToggleWorkspaceSuspensionAction({ workspaceId, suspend: false })
                  .then(() => {
                    toast.success('Workspace reactivated.');
                    loadData(true);
                  });
              } else {
                setSuspendReason('');
                setSuspendModalOpen(true);
              }
            }}
          >
            {isSuspended ? 'Reactivate Workspace' : 'Suspend Workspace'}
          </Button>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="border-b border-line">
        <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-none">
          {TAB_ITEMS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  'flex items-center gap-2 px-3.5 py-2.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors',
                  active
                    ? 'bg-accent/10 text-accent font-semibold border border-accent/20'
                    : 'text-ink-2 hover:text-ink hover:bg-surface-2'
                )}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* TAB CONTENT */}

      {/* 1. Plan & Billing */}
      {activeTab === 'plan_billing' && (
        <div className="space-y-6">
          <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-4">
              <div>
                <h3 className="text-md font-bold text-ink">Plan Subscription</h3>
                <p className="text-xs text-ink-3">Manage subscription tier, billing period, and trial extensions.</p>
              </div>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => handleToggleLock('plan_billing', locks['plan_billing'])}
              >
                {locks['plan_billing'] ? <Unlock className="w-3 h-3 text-warn" /> : <Lock className="w-3 h-3 text-ink-3" />}
                <span>{locks['plan_billing'] ? 'Unlock Billing' : 'Lock by Zentry'}</span>
              </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
              <div>
                <label className="text-xs font-medium text-ink-2">Assigned Plan</label>
                <select
                  className="input input-sm w-full mt-1.5"
                  value={subscription?.plan_id || ''}
                  onChange={async (e) => {
                    const planId = e.target.value;
                    const res = await adminUpdateWorkspacePlanAction({ workspaceId, planId });
                    if (res.success) {
                      toast.success('Plan updated.');
                      loadData(true);
                    } else {
                      toast.error(res.error || 'Failed to update plan.');
                    }
                  }}
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (${p.monthly_price}/mo)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-ink-2">Status</label>
                <select
                  className="input input-sm w-full mt-1.5"
                  value={subscription?.status || 'active'}
                  onChange={async (e) => {
                    const status = e.target.value as SubscriptionStatus;
                    const res = await adminUpdateWorkspacePlanAction({
                      workspaceId,
                      planId: subscription?.plan_id || plans[0]?.id,
                      status,
                    });
                    if (res.success) {
                      toast.success('Status updated.');
                      loadData(true);
                    } else {
                      toast.error(res.error || 'Failed to update status.');
                    }
                  }}
                >
                  <option value="active">Active</option>
                  <option value="trialing">Trialing</option>
                  <option value="past_due">Past Due</option>
                  <option value="canceled">Canceled</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-ink-2">Billing Period</label>
                <select
                  className="input input-sm w-full mt-1.5"
                  value={subscription?.billing_period || 'monthly'}
                  onChange={async (e) => {
                    const billingPeriod = e.target.value as BillingPeriod;
                    const res = await adminUpdateWorkspacePlanAction({
                      workspaceId,
                      planId: subscription?.plan_id || plans[0]?.id,
                      billingPeriod,
                    });
                    if (res.success) {
                      toast.success('Billing period updated.');
                      loadData(true);
                    } else {
                      toast.error(res.error || 'Failed.');
                    }
                  }}
                >
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
            </div>

            {/* Trial dates */}
            <div className="p-4 bg-surface-2 border border-line rounded-xl flex items-center justify-between">
              <div>
                <span className="text-xs font-medium text-ink">Trial Status</span>
                <p className="text-2xs text-ink-3">
                  {subscription?.trial_ends_at
                    ? `Expires on ${new Date(subscription.trial_ends_at).toLocaleDateString()}`
                    : 'No active trial recorded.'}
                </p>
              </div>
              <Button
                variant="secondary"
                size="xs"
                onClick={async () => {
                  const res = await adminUpdateWorkspacePlanAction({
                    workspaceId,
                    planId: subscription?.plan_id || plans[0]?.id,
                    extendTrialDays: 14,
                  });
                  if (res.success) {
                    toast.success('Trial extended by 14 days.');
                    loadData(true);
                  } else toast.error('Failed to extend trial.');
                }}
              >
                +14 Days Extension
              </Button>
            </div>
          </div>

          {/* Invoices and Payments */}
          <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-md font-bold text-ink">Invoices & Payment Records</h3>
                <p className="text-xs text-ink-3">Payment history and manual payment recording.</p>
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setPaymentModalOpen(true)}
              >
                <DollarSign className="w-3.5 h-3.5 mr-1" />
                <span>Record Manual Payment</span>
              </Button>
            </div>

            {invoices.length === 0 ? (
              <p className="text-xs text-ink-3 py-4 text-center">No invoices recorded for this workspace.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-line text-ink-3">
                      <th className="py-2.5 px-3">Invoice #</th>
                      <th className="py-2.5 px-3">Amount</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Reason</th>
                      <th className="py-2.5 px-3">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv: any) => (
                      <tr key={inv.id} className="border-b border-line/50 hover:bg-surface-2/50">
                        <td className="py-2.5 px-3 font-mono text-ink font-medium">{inv.invoice_number}</td>
                        <td className="py-2.5 px-3 font-semibold text-ink">${inv.amount} {inv.currency}</td>
                        <td className="py-2.5 px-3">
                          <Badge tone={inv.status === 'paid' ? 'success' : 'warn'} className="text-2xs capitalize">
                            {inv.status}
                          </Badge>
                        </td>
                        <td className="py-2.5 px-3 text-ink-3 capitalize">{inv.billing_reason || 'subscription'}</td>
                        <td className="py-2.5 px-3 text-ink-3">{new Date(inv.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. Usage & Limits */}
      {activeTab === 'usage_limits' && (
        <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <h3 className="text-md font-bold text-ink">Live Usage & Limit Overrides</h3>
              <p className="text-xs text-ink-3">
                Monitor resource consumption and apply per-workspace overrides that take precedence over the plan.
              </p>
            </div>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => handleToggleLock('usage_limits', locks['usage_limits'])}
            >
              {locks['usage_limits'] ? <Unlock className="w-3 h-3 text-warn" /> : <Lock className="w-3 h-3 text-ink-3" />}
              <span>{locks['usage_limits'] ? 'Unlock Limits' : 'Lock by Zentry'}</span>
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {PLAN_LIMITS.map((limitDef) => {
              const currentUsageInfo = usage[limitDef.id] || { current: 0, limit: null, percentage: 0 };
              const currentLimitVal = limits[limitDef.id]?.value ?? null;
              const source = limits[limitDef.id]?.source || 'plan';

              return (
                <div key={limitDef.id} className="p-4 bg-surface-2 border border-line rounded-xl space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="text-xs font-bold text-ink">{limitDef.name}</h4>
                      <p className="text-2xs text-ink-3">{limitDef.description}</p>
                    </div>
                    <Badge tone={source === 'override' ? 'accent' : 'neutral'} className="text-2xs">
                      {source === 'override' ? 'Owner Override' : 'Plan Default'}
                    </Badge>
                  </div>

                  {/* Progress bar */}
                  <div>
                    <div className="flex items-center justify-between text-2xs mb-1">
                      <span className="font-semibold text-ink">
                        {currentUsageInfo.current} {limitDef.unit} used
                      </span>
                      <span className="text-ink-3">
                        Limit: {currentLimitVal !== null ? `${currentLimitVal} ${limitDef.unit}` : 'Unlimited'}
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-surface border border-line overflow-hidden">
                      <div
                        className={cn(
                          'h-full transition-all',
                          currentUsageInfo.percentage >= 90 ? 'bg-danger' : currentUsageInfo.percentage >= 75 ? 'bg-warn' : 'bg-accent'
                        )}
                        style={{ width: `${Math.min(100, currentUsageInfo.percentage)}%` }}
                      />
                    </div>
                  </div>

                  {/* Override input */}
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="number"
                      placeholder="Unlimited (empty)"
                      className="input input-xs flex-1 text-xs"
                      defaultValue={currentLimitVal !== null ? currentLimitVal : ''}
                      onBlur={async (e) => {
                        const val = e.target.value.trim() === '' ? null : Number(e.target.value);
                        if (val !== currentLimitVal) {
                          const res = await adminUpdateWorkspaceLimitsAction(workspaceId, { [limitDef.id]: val });
                          if (res.success) {
                            toast.success(`Updated ${limitDef.name}.`);
                            loadData(true);
                          } else toast.error('Failed to update limit.');
                        }
                      }}
                    />
                    <span className="text-2xs text-ink-3">{limitDef.unit}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Features Switchboard */}
      {activeTab === 'features' && (
        <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <h3 className="text-md font-bold text-ink">Workspace Feature Switches</h3>
              <p className="text-xs text-ink-3">
                Explicitly enable, disable, or inherit features from the plan. Overrides strictly take precedence.
              </p>
            </div>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => handleToggleLock('features', locks['features'])}
            >
              {locks['features'] ? <Unlock className="w-3 h-3 text-warn" /> : <Lock className="w-3 h-3 text-ink-3" />}
              <span>{locks['features'] ? 'Unlock Features' : 'Lock by Zentry'}</span>
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {PLAN_FEATURES.map((feat) => {
              const currentFeat = features[feat.id] || { enabled: false, source: 'plan' };
              const isOverride = currentFeat.source === 'override';

              return (
                <div key={feat.id} className="p-3.5 bg-surface-2 border border-line rounded-xl flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-ink">{feat.name}</span>
                      <Badge tone={isOverride ? 'accent' : 'neutral'} className="text-2xs">
                        {isOverride ? 'Override' : 'Plan'}
                      </Badge>
                    </div>
                    <p className="text-2xs text-ink-3 truncate mt-0.5">{feat.description}</p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <select
                      className="input input-xs text-2xs"
                      value={isOverride ? (currentFeat.enabled ? 'force_on' : 'force_off') : 'inherit'}
                      onChange={async (e) => {
                        const val = e.target.value;
                        const overrideVal = val === 'inherit' ? null : val === 'force_on';
                        const res = await adminUpdateWorkspaceFeaturesAction(workspaceId, { [feat.id]: overrideVal });
                        if (res.success) {
                          toast.success(`Updated ${feat.name}.`);
                          loadData(true);
                        } else toast.error('Failed to update feature.');
                      }}
                    >
                      <option value="inherit">Inherit Plan ({currentFeat.enabled ? 'Enabled' : 'Disabled'})</option>
                      <option value="force_on">Force Enable</option>
                      <option value="force_off">Force Disable</option>
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 4. Team & Roles */}
      {activeTab === 'team' && (
        <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <h3 className="text-md font-bold text-ink">Team Members & Access</h3>
              <p className="text-xs text-ink-3">Manage agent roles, capacity, activations, and transfer ownership.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="xs"
                onClick={async () => {
                  const res = await adminForceLogoutSessionsAction(workspaceId);
                  if (res.success) toast.success('Forced logout command dispatched for all members.');
                }}
              >
                <LogOut className="w-3 h-3 mr-1" />
                <span>Force Logout Sessions</span>
              </Button>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => handleToggleLock('team', locks['team'])}
              >
                {locks['team'] ? <Unlock className="w-3 h-3 text-warn" /> : <Lock className="w-3 h-3 text-ink-3" />}
                <span>{locks['team'] ? 'Unlock Team' : 'Lock by Zentry'}</span>
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-line text-ink-3">
                  <th className="py-2.5 px-3">Member</th>
                  <th className="py-2.5 px-3">Role</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const isCurrentOwner = m.role === 'owner';
                  return (
                    <tr key={m.id} className="border-b border-line/50 hover:bg-surface-2/50">
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={m.name || m.email} size="sm" />
                          <div>
                            <div className="font-semibold text-ink flex items-center gap-1.5">
                              <span>{m.name || 'Agent'}</span>
                              {isCurrentOwner && <Badge tone="accent" className="text-2xs">Owner</Badge>}
                            </div>
                            <div className="text-2xs text-ink-3 font-mono">{m.email}</div>
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <select
                          className="input input-xs"
                          value={m.role}
                          disabled={isCurrentOwner}
                          onChange={async (e) => {
                            const newRole = e.target.value as any;
                            const res = await adminChangeMemberRoleAction(workspaceId, m.id, newRole);
                            if (res.success) {
                              toast.success('Role updated.');
                              loadData(true);
                            } else toast.error(res.error || 'Failed.');
                          }}
                        >
                          <option value="owner">Owner</option>
                          <option value="admin">Admin</option>
                          <option value="agent">Agent</option>
                          <option value="light_agent">Light Agent</option>
                        </select>
                      </td>

                      <td className="py-3 px-3">
                        <Badge tone={m.is_active ? 'success' : 'neutral'} className="text-2xs capitalize">
                          {m.is_active ? 'Active' : 'Deactivated'}
                        </Badge>
                      </td>

                      <td className="py-3 px-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={async () => {
                              const res = await adminToggleMemberActiveAction(workspaceId, m.id, !m.is_active);
                              if (res.success) {
                                toast.success(m.is_active ? 'Deactivated' : 'Reactivated');
                                loadData(true);
                              } else toast.error('Failed.');
                            }}
                          >
                            {m.is_active ? 'Deactivate' : 'Activate'}
                          </Button>

                          {!isCurrentOwner && (
                            <Button
                              variant="secondary"
                              size="xs"
                              onClick={() => {
                                setSelectedNewOwnerId(m.id);
                                setTransferOwnerModalOpen(true);
                              }}
                            >
                              Transfer Ownership
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 5. Channels */}
      {activeTab === 'channels' && (
        <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <h3 className="text-md font-bold text-ink">Customer Channels</h3>
              <p className="text-xs text-ink-3">Inspect status, disable problematic channels, and emergency kill switches.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={channelConfig.isOutboundBlocked ? 'primary' : 'danger'}
                size="xs"
                onClick={async () => {
                  const res = await adminToggleOutboundBlockedAction(workspaceId, !channelConfig.isOutboundBlocked);
                  if (res.success) {
                    toast.success(channelConfig.isOutboundBlocked ? 'Outbound unblocked.' : 'Outbound blocked.');
                    loadData(true);
                  } else toast.error('Failed.');
                }}
              >
                {channelConfig.isOutboundBlocked ? 'Unblock Outbound' : 'Emergency Block Outbound'}
              </Button>

              <Button
                variant="secondary"
                size="xs"
                onClick={() => handleToggleLock('channels', locks['channels'])}
              >
                {locks['channels'] ? <Unlock className="w-3 h-3 text-warn" /> : <Lock className="w-3 h-3 text-ink-3" />}
                <span>{locks['channels'] ? 'Unlock Channels' : 'Lock by Zentry'}</span>
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {['email', 'whatsapp', 'instagram', 'x', 'threads', 'linkedin', 'tiktok'].map((ch) => {
              const conn = channels.find((c: any) => c.channel === ch);
              const isOverriddenDisabled = channelConfig.disabledOverrides[ch] === true;

              return (
                <div key={ch} className="p-4 bg-surface-2 border border-line rounded-xl space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-ink capitalize">{ch} Channel</span>
                      <Badge tone={conn ? 'success' : 'neutral'} className="text-2xs capitalize">
                        {conn ? (conn.status || 'connected') : 'Not Connected'}
                      </Badge>
                      {isOverriddenDisabled && (
                        <Badge tone="danger" className="text-2xs">Admin Disabled</Badge>
                      )}
                    </div>

                    <Button
                      variant={isOverriddenDisabled ? 'primary' : 'secondary'}
                      size="xs"
                      onClick={async () => {
                        const res = await adminToggleChannelDisabledAction(workspaceId, ch, !isOverriddenDisabled);
                        if (res.success) {
                          toast.success(`Channel ${!isOverriddenDisabled ? 'disabled' : 'enabled'}.`);
                          loadData(true);
                        } else toast.error('Failed.');
                      }}
                    >
                      {isOverriddenDisabled ? 'Re-enable' : 'Disable'}
                    </Button>
                  </div>

                  {conn?.last_error && (
                    <div className="p-2.5 rounded-lg bg-danger/10 border border-danger/20 text-2xs text-danger">
                      <strong>Last Error:</strong> {conn.last_error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 6. AI Bot */}
      {activeTab === 'ai_bot' && (
        <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <h3 className="text-md font-bold text-ink">Autonomous AI Bot Control</h3>
              <p className="text-xs text-ink-3">Enforce AI models, monthly reply caps, and cost budget safety ceilings.</p>
            </div>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => handleToggleLock('ai_settings', locks['ai_settings'])}
            >
              {locks['ai_settings'] ? <Unlock className="w-3 h-3 text-warn" /> : <Lock className="w-3 h-3 text-ink-3" />}
              <span>{locks['ai_settings'] ? 'Unlock AI' : 'Lock by Zentry'}</span>
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-ink-2">AI Bot Status</label>
              <select
                className="input input-sm w-full mt-1.5"
                value={ai.enabled ? 'enabled' : 'disabled'}
                onChange={async (e) => {
                  const enabled = e.target.value === 'enabled';
                  const res = await adminUpdateAiControlAction(workspaceId, { enabled });
                  if (res.success) {
                    toast.success('AI status updated.');
                    loadData(true);
                  } else toast.error('Failed.');
                }}
              >
                <option value="enabled">Enabled (Auto-reply active)</option>
                <option value="disabled">Disabled (Offline)</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-ink-2">Enforced Model</label>
              <select
                className="input input-sm w-full mt-1.5"
                value={ai.model}
                onChange={async (e) => {
                  const model = e.target.value;
                  const res = await adminUpdateAiControlAction(workspaceId, { model });
                  if (res.success) {
                    toast.success('AI model updated.');
                    loadData(true);
                  } else toast.error('Failed.');
                }}
              >
                <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
                <option value="claude-3-haiku">Claude 3 Haiku</option>
                <option value="gpt-4o">GPT-4o</option>
                <option value="gpt-4o-mini">GPT-4o Mini</option>
                <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-ink-2">Monthly Reply Cap</label>
              <input
                type="number"
                placeholder="Unlimited (empty)"
                className="input input-sm w-full mt-1.5"
                defaultValue={ai.monthly_reply_cap !== null ? ai.monthly_reply_cap : ''}
                onBlur={async (e) => {
                  const val = e.target.value.trim() === '' ? null : Number(e.target.value);
                  const res = await adminUpdateAiControlAction(workspaceId, { monthly_reply_cap: val });
                  if (res.success) {
                    toast.success('Reply cap updated.');
                    loadData(true);
                  } else toast.error('Failed.');
                }}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-ink-2">Monthly Cost Cap ($ USD)</label>
              <input
                type="number"
                placeholder="Unlimited (empty)"
                className="input input-sm w-full mt-1.5"
                defaultValue={ai.monthly_cost_cap_usd !== null ? ai.monthly_cost_cap_usd : ''}
                onBlur={async (e) => {
                  const val = e.target.value.trim() === '' ? null : Number(e.target.value);
                  const res = await adminUpdateAiControlAction(workspaceId, { monthly_cost_cap_usd: val });
                  if (res.success) {
                    toast.success('Cost cap updated.');
                    loadData(true);
                  } else toast.error('Failed.');
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 7. Widget & Branding */}
      {activeTab === 'widget' && (
        <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <h3 className="text-md font-bold text-ink">Widget & Branding Controls</h3>
              <p className="text-xs text-ink-3">Enforce platform branding or disable widget loading on customer sites.</p>
            </div>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => handleToggleLock('widget_appearance', locks['widget_appearance'])}
            >
              {locks['widget_appearance'] ? <Unlock className="w-3 h-3 text-warn" /> : <Lock className="w-3 h-3 text-ink-3" />}
              <span>{locks['widget_appearance'] ? 'Unlock Widget' : 'Lock by Zentry'}</span>
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-ink-2">"Powered by Zentry" Policy</label>
              <select
                className="input input-sm w-full mt-1.5"
                value={widgetConfig.forcePoweredBy}
                onChange={async (e) => {
                  const forcePoweredBy = e.target.value as any;
                  const res = await adminUpdateWidgetControlAction(workspaceId, { forcePoweredBy });
                  if (res.success) {
                    toast.success('Branding policy updated.');
                    loadData(true);
                  } else toast.error('Failed.');
                }}
              >
                <option value="inherited">Inherit from Plan (Allow removal if plan includes it)</option>
                <option value="force_on">Force "Powered by Zentry" Always On</option>
                <option value="force_off">Force "Powered by Zentry" Always Off</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-ink-2">Widget Kill Switch</label>
              <select
                className="input input-sm w-full mt-1.5"
                value={widgetConfig.disabled ? 'disabled' : 'enabled'}
                onChange={async (e) => {
                  const widgetDisabled = e.target.value === 'disabled';
                  const res = await adminUpdateWidgetControlAction(workspaceId, { widgetDisabled });
                  if (res.success) {
                    toast.success('Widget status updated.');
                    loadData(true);
                  } else toast.error('Failed.');
                }}
              >
                <option value="enabled">Enabled (Widget loads normally)</option>
                <option value="disabled">Disabled (Blocked from rendering on customer sites)</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* 8. Help Center */}
      {activeTab === 'helpcenter' && (
        <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <h3 className="text-md font-bold text-ink">Help Center & Domains</h3>
              <p className="text-xs text-ink-3">Manage public help center status, custom domains, and SSL routing.</p>
            </div>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => handleToggleLock('help_center', locks['help_center'])}
            >
              {locks['help_center'] ? <Unlock className="w-3 h-3 text-warn" /> : <Lock className="w-3 h-3 text-ink-3" />}
              <span>{locks['help_center'] ? 'Unlock Help Center' : 'Lock by Zentry'}</span>
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-surface-2 border border-line rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-ink">Published Status</h4>
                  <p className="text-2xs text-ink-3">Control whether the public help center is viewable by visitors.</p>
                </div>
                <Button
                  variant={hcConfig.enabled ? 'secondary' : 'primary'}
                  size="xs"
                  onClick={async () => {
                    const res = await adminToggleHelpCenterPublishedAction(workspaceId, !hcConfig.enabled);
                    if (res.success) {
                      toast.success(hcConfig.enabled ? 'Unpublished' : 'Published');
                      loadData(true);
                    } else toast.error('Failed.');
                  }}
                >
                  {hcConfig.enabled ? 'Unpublish' : 'Publish'}
                </Button>
              </div>
            </div>

            <div className="p-4 bg-surface-2 border border-line rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-ink">Custom Domain</h4>
                  <p className="text-2xs text-ink-3 font-mono">
                    {hcConfig.customDomain || 'No custom domain attached'}
                  </p>
                </div>
                <Badge tone={hcConfig.isCustomDomainVerified ? 'success' : 'warn'} className="text-2xs">
                  {hcConfig.isCustomDomainVerified ? 'Verified' : 'Unverified'}
                </Badge>
              </div>

              {hcConfig.customDomain && (
                <div className="flex items-center gap-2 pt-1">
                  {!hcConfig.isCustomDomainVerified && (
                    <Button
                      variant="primary"
                      size="xs"
                      onClick={async () => {
                        const res = await adminApproveCustomDomainAction(workspaceId);
                        if (res.success) {
                          toast.success('Custom domain approved.');
                          loadData(true);
                        } else toast.error('Failed to approve domain.');
                      }}
                    >
                      Approve Domain
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="xs"
                    onClick={async () => {
                      const res = await adminRemoveCustomDomainAction(workspaceId);
                      if (res.success) {
                        toast.success('Custom domain detached.');
                        loadData(true);
                      } else toast.error('Failed to detach domain.');
                    }}
                  >
                    Detach Domain
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 9. Security & Data */}
      {activeTab === 'security_data' && (
        <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <h3 className="text-md font-bold text-ink">Security Policies & Lifecycle</h3>
              <p className="text-xs text-ink-3">Enforce two-factor authentication, set data retention periods, or export data.</p>
            </div>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => handleToggleLock('security', locks['security'])}
            >
              {locks['security'] ? <Unlock className="w-3 h-3 text-warn" /> : <Lock className="w-3 h-3 text-ink-3" />}
              <span>{locks['security'] ? 'Unlock Security' : 'Lock by Zentry'}</span>
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-ink-2">Enforce Two-Factor Authentication (2FA)</label>
              <select
                className="input input-sm w-full mt-1.5"
                value={secConfig.require2fa ? 'required' : 'optional'}
                onChange={async (e) => {
                  const require2fa = e.target.value === 'required';
                  const res = await adminUpdateSecurityControlAction(workspaceId, { require2fa });
                  if (res.success) {
                    toast.success('Security 2FA policy updated.');
                    loadData(true);
                  } else toast.error('Failed.');
                }}
              >
                <option value="optional">Optional for team members</option>
                <option value="required">Strictly required for all team members</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-ink-2">Data Retention Policy</label>
              <select
                className="input input-sm w-full mt-1.5"
                value={secConfig.dataRetentionDays !== null ? String(secConfig.dataRetentionDays) : 'indefinite'}
                onChange={async (e) => {
                  const val = e.target.value === 'indefinite' ? null : Number(e.target.value);
                  const res = await adminUpdateSecurityControlAction(workspaceId, { dataRetentionDays: val });
                  if (res.success) {
                    toast.success('Data retention period updated.');
                    loadData(true);
                  } else toast.error('Failed.');
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

          <div className="p-4 bg-surface-2 border border-line rounded-xl flex items-center justify-between">
            <div>
              <h4 className="text-xs font-bold text-ink">Export Workspace Data</h4>
              <p className="text-2xs text-ink-3">Download complete JSON archive of tickets, channels, articles, and members.</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                const res = await exportWorkspaceDataAction(workspaceId);
                if (res.success && res.data) {
                  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `workspace-export-${workspace.name.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.json`;
                  a.click();
                  toast.success('Data exported successfully.');
                } else toast.error('Export failed.');
              }}
            >
              <Download className="w-3.5 h-3.5 mr-1" />
              <span>Export JSON Archive</span>
            </Button>
          </div>

          {/* Deletion Box */}
          <div className="p-4 rounded-xl border border-danger/30 bg-danger/5 flex items-center justify-between">
            <div>
              <h4 className="text-xs font-bold text-danger">Permanent Workspace Deletion</h4>
              <p className="text-2xs text-danger/80">
                {workspace.scheduled_deletion_at
                  ? `Scheduled for permanent deletion on ${new Date(workspace.scheduled_deletion_at).toLocaleDateString()}`
                  : 'Requires confirmation and initiates a 30-day waiting period.'}
              </p>
            </div>
            {workspace.scheduled_deletion_at ? (
              <Button
                variant="primary"
                size="sm"
                onClick={async () => {
                  const res = await cancelWorkspaceDeletionAction(workspaceId);
                  if (res.success) {
                    toast.success('Scheduled deletion canceled.');
                    loadData(true);
                  } else toast.error('Failed to cancel deletion.');
                }}
              >
                Cancel Deletion
              </Button>
            ) : (
              <Button
                variant="danger"
                size="sm"
                onClick={() => setDeleteModalOpen(true)}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" />
                <span>Delete Workspace</span>
              </Button>
            )}
          </div>
        </div>
      )}

      {/* 10. Activity Log */}
      {activeTab === 'activity' && (
        <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs space-y-4">
          <div>
            <h3 className="text-md font-bold text-ink">Workspace Audit Trail</h3>
            <p className="text-xs text-ink-3">Complete log of internal workspace events and super admin modifications.</p>
          </div>

          {recentActivity.length === 0 ? (
            <p className="text-xs text-ink-3 py-6 text-center">No activity recorded yet.</p>
          ) : (
            <div className="space-y-3">
              {recentActivity.map((log: any) => (
                <div key={log.id} className="p-3.5 bg-surface-2 border border-line rounded-xl flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-ink font-mono">{log.action}</span>
                      <Badge tone={log.type === 'super_admin' ? 'accent' : 'neutral'} className="text-2xs">
                        {log.type === 'super_admin' ? 'Super Admin' : 'Workspace'}
                      </Badge>
                    </div>
                    <p className="text-2xs text-ink-3 mt-1">
                      By: <strong className="text-ink-2">{log.actor}</strong>
                    </p>
                    {log.details && (
                      <pre className="mt-1.5 p-2 rounded bg-surface border border-line/60 text-2xs font-mono text-ink-2 overflow-x-auto max-h-32">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    )}
                  </div>
                  <span className="text-2xs text-ink-3 shrink-0">{new Date(log.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Suspend Reason Modal */}
      <Modal
        open={suspendModalOpen}
        onClose={() => setSuspendModalOpen(false)}
        title="Suspend Workspace"
      >
        <div className="space-y-4">
          <p className="text-xs text-ink-3">
            Please provide an administrative reason for suspending <strong className="text-ink">{workspace.name}</strong>.
          </p>
          <input
            type="text"
            className="input input-sm w-full"
            placeholder="e.g. Terms of Service violation, non-payment"
            value={suspendReason}
            onChange={(e) => setSuspendReason(e.target.value)}
          />
          <div className="flex justify-end gap-2 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setSuspendModalOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                const res = await adminToggleWorkspaceSuspensionAction({
                  workspaceId,
                  suspend: true,
                  reason: suspendReason,
                });
                if (res.success) {
                  toast.success('Workspace suspended.');
                  setSuspendModalOpen(false);
                  loadData(true);
                } else toast.error('Failed.');
              }}
            >
              Confirm Suspension
            </Button>
          </div>
        </div>
      </Modal>

      {/* Manual Payment Modal */}
      <Modal
        open={paymentModalOpen}
        onClose={() => setPaymentModalOpen(false)}
        title="Record Manual Payment"
      >
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-ink-2">Amount ($ USD)</label>
            <input
              type="number"
              className="input input-sm w-full mt-1"
              value={paymentAmount}
              onChange={(e) => setPaymentAmount(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-ink-2">Payment Method</label>
            <select
              className="input input-sm w-full mt-1"
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value as any)}
            >
              <option value="manual_bank_transfer">Wire / Bank Transfer</option>
              <option value="manual_crypto">Cryptocurrency</option>
              <option value="manual_check">Corporate Check</option>
              <option value="manual_other">Other</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-ink-2">Reference / Transaction ID</label>
            <input
              type="text"
              className="input input-sm w-full mt-1"
              placeholder="e.g. TX-98421"
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-ink-2">Extend Subscription (Days)</label>
            <input
              type="number"
              className="input input-sm w-full mt-1"
              value={paymentExtendDays}
              onChange={(e) => setPaymentExtendDays(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setPaymentModalOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                const res = await adminRecordManualPaymentAction({
                  workspaceId,
                  amount: Number(paymentAmount) || 0,
                  paymentMethod,
                  paymentReference: paymentReference || 'MANUAL-REF',
                  extendDays: Number(paymentExtendDays) || 30,
                  notes: paymentNotes,
                });
                if (res.success) {
                  toast.success('Payment recorded and subscription renewed.');
                  setPaymentModalOpen(false);
                  loadData(true);
                } else toast.error('Failed to record payment.');
              }}
            >
              Record & Activate
            </Button>
          </div>
        </div>
      </Modal>

      {/* Transfer Ownership Modal */}
      <Modal
        open={transferOwnerModalOpen}
        onClose={() => setTransferOwnerModalOpen(false)}
        title="Transfer Workspace Ownership"
      >
        <div className="space-y-4">
          <p className="text-xs text-ink-3">
            Are you sure you want to transfer ownership of <strong className="text-ink">{workspace.name}</strong>?
          </p>
          <div className="flex justify-end gap-2 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setTransferOwnerModalOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                const res = await adminTransferWorkspaceOwnershipAction(workspaceId, selectedNewOwnerId);
                if (res.success) {
                  toast.success('Ownership transferred.');
                  setTransferOwnerModalOpen(false);
                  loadData(true);
                } else toast.error(res.error || 'Failed.');
              }}
            >
              Confirm Transfer
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Workspace Modal */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Schedule Workspace Deletion"
      >
        <div className="space-y-4">
          <p className="text-xs text-danger">
            This will suspend the workspace immediately and schedule permanent deletion with a 30-day grace period.
          </p>
          <div>
            <label className="text-xs font-medium text-ink-2">Type workspace name to confirm: <strong className="text-ink">{workspace.name}</strong></label>
            <input
              type="text"
              className="input input-sm w-full mt-1"
              value={deleteConfirmName}
              onChange={(e) => setDeleteConfirmName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-ink-2">Reason</label>
            <input
              type="text"
              className="input input-sm w-full mt-1"
              placeholder="e.g. Inactivity, user request"
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setDeleteModalOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              disabled={deleteConfirmName.trim().toLowerCase() !== workspace.name.trim().toLowerCase()}
              onClick={async () => {
                const res = await scheduleWorkspaceDeletionAction({
                  workspaceId,
                  confirmName: deleteConfirmName,
                  reason: deleteReason,
                });
                if (res.success) {
                  toast.success('Workspace scheduled for deletion.');
                  setDeleteModalOpen(false);
                  loadData(true);
                } else toast.error(res.error || 'Failed to schedule deletion.');
              }}
            >
              Schedule Deletion
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
