'use client';

import React, { useEffect, useState, useTransition } from 'react';
import {
  Sparkles,
  Zap,
  Check,
  AlertTriangle,
  Clock,
  ArrowUpRight,
  ShieldCheck,
  Ticket,
  ChevronRight,
  RefreshCw,
  Tag,
  Lock,
} from 'lucide-react';
import { Workspace } from '@/types/database';
import { WorkspaceBillingOverview, PlatformPlan } from '@/types/plans';
import {
  getWorkspaceBillingAndUsageAction,
  getPublicPlansAction,
  applyCouponToWorkspaceAction,
} from '@/app/actions/plans';

export function WorkspaceBillingView({
  workspace,
}: {
  workspace: Workspace;
}) {
  const [overview, setOverview] = useState<WorkspaceBillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [availablePlans, setAvailablePlans] = useState<PlatformPlan[]>([]);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const [couponMsg, setCouponMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isApplyingCoupon, startCouponTransition] = useTransition();

  const loadData = async () => {
    setLoading(true);
    try {
      const [res, publicPlans] = await Promise.all([
        getWorkspaceBillingAndUsageAction(workspace.id),
        getPublicPlansAction(),
      ]);
      setOverview(res);
      setAvailablePlans(publicPlans);
    } catch (e) {
      console.error('Failed to load billing overview:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [workspace.id]);

  const handleApplyCoupon = () => {
    if (!couponCode.trim()) return;
    setCouponMsg(null);
    startCouponTransition(async () => {
      const res = await applyCouponToWorkspaceAction(workspace.id, couponCode.trim());
      if (res.success) {
        setCouponMsg({ type: 'success', text: res.discountSummary ? `Coupon applied: ${res.discountSummary}` : 'Coupon applied successfully!' });
        setCouponCode('');
        loadData();
      } else {
        setCouponMsg({ type: 'error', text: res.error || 'Failed to apply coupon.' });
      }
    });
  };

  if (loading && !overview) {
    return (
      <div className="p-8 text-center bg-surface border border-line rounded-xl">
        <RefreshCw className="w-5 h-5 animate-spin mx-auto text-ink-3" />
        <p className="mt-2 text-xs text-ink-3">Loading billing and usage details...</p>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="p-6 bg-surface border border-line rounded-xl">
        <p className="text-sm text-ink-2">Could not retrieve workspace subscription details.</p>
      </div>
    );
  }

  const sub = overview.subscription;
  const isTrial = sub.status === 'trialing';
  const hasWarning = overview.limits.some(
    (l) => l.isNearLimit || (!l.isUnlimited && l.limit !== null && l.currentUsage >= l.limit)
  );

  return (
    <div className="space-y-6">
      {/* 80% / Exceeded Top Warning Banner */}
      {hasWarning && (
        <div className="p-4 rounded-xl border border-warning/30 bg-warning-soft text-ink flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div className="flex-1 text-xs">
            <h4 className="font-semibold text-warning">Usage Warning Advisory</h4>
            <p className="mt-0.5 text-ink-2">
              One or more resource limits have reached or exceeded 80% capacity. Consider upgrading your plan to prevent service interruptions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setUpgradeModalOpen(true)}
            className="btn btn-sm btn-primary shrink-0 text-xs"
          >
            Review Plans
          </button>
        </div>
      )}

      {/* Main Subscription Card */}
      <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-line">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="text-2xs font-bold uppercase tracking-wider text-ink-3">
                Current Plan
              </span>
              <span
                className={`badge text-3xs uppercase font-bold px-2 py-0.5 rounded-full ${
                  sub.status === 'active'
                    ? 'badge-success'
                    : sub.status === 'trialing'
                    ? 'badge-accent'
                    : 'badge-danger'
                }`}
              >
                {sub.status}
              </span>
              {sub.admin_note?.includes('Coupon Applied') && (
                <span className="badge badge-warning text-3xs font-bold uppercase">
                  Discount Coupon Applied
                </span>
              )}
            </div>
            <h3 className="text-2xl font-bold text-ink mt-1">
              {overview.plan.name}
            </h3>
            <p className="text-xs text-ink-2 mt-1">
              {sub.billing_period === 'yearly' ? 'Annual Billing' : 'Monthly Billing'}
              {sub.current_period_end && (
                <span>
                  {' '}• Renews on {new Date(sub.current_period_end).toLocaleDateString()}
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setUpgradeModalOpen(true)}
              className="btn btn-primary text-xs flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Change Plan</span>
            </button>
          </div>
        </div>

        {/* Trial Callout if trialing */}
        {isTrial && (
          <div className="mt-4 p-3.5 rounded-lg bg-surface-2 border border-line flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2.5 text-ink">
              <Clock className="w-4 h-4 text-accent shrink-0" />
              <span>
                <strong>{overview.trialDaysRemaining ?? 0} days left</strong> in your free trial period.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setUpgradeModalOpen(true)}
              className="text-accent hover:underline font-semibold text-2xs"
            >
              Select Paid Plan &rarr;
            </button>
          </div>
        )}

        {/* Promo code redeemer */}
        <div className="mt-4 pt-4 border-t border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-ink-2">
            <Tag className="w-3.5 h-3.5 text-ink-3" />
            <span>Have a discount coupon?</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Enter coupon code"
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
              className="input input-sm text-xs font-mono uppercase w-48"
            />
            <button
              type="button"
              onClick={handleApplyCoupon}
              disabled={isApplyingCoupon || !couponCode.trim()}
              className="btn btn-sm btn-outline text-xs"
            >
              Apply
            </button>
          </div>
        </div>
        {couponMsg && (
          <p
            className={`mt-2 text-2xs font-medium ${
              couponMsg.type === 'success' ? 'text-success' : 'text-danger'
            }`}
          >
            {couponMsg.text}
          </p>
        )}
      </div>

      {/* Resource Limits & Usage Meters */}
      <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h4 className="text-sm font-bold text-ink">Plan Limits & Usage</h4>
            <p className="text-2xs text-ink-3">
              Usage tracked during current billing cycle ({new Date(sub.current_period_start).toLocaleDateString()} - {new Date(sub.current_period_end).toLocaleDateString()})
            </p>
          </div>
          <button
            type="button"
            onClick={loadData}
            className="btn btn-xs btn-ghost text-ink-3 hover:text-ink"
            title="Refresh Usage"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {overview.limits.map((l) => {
            const isUnlimited = l.isUnlimited;
            const percent = isUnlimited ? 0 : Math.min(100, l.percentage);
            const isExceeded = !isUnlimited && l.limit !== null && l.currentUsage >= l.limit;

            return (
              <div
                key={l.key}
                className={`p-4 rounded-xl border transition-all ${
                  isExceeded
                    ? 'border-danger/40 bg-danger-soft/20'
                    : l.isNearLimit
                    ? 'border-warning/40 bg-warning-soft/20'
                    : 'border-line bg-surface-2/40'
                }`}
              >
                <div className="flex items-center justify-between gap-1 text-2xs">
                  <span className="font-semibold text-ink truncate">{l.name}</span>
                  {isExceeded ? (
                    <span className="badge badge-danger text-3xs font-bold uppercase">
                      Limit Hit
                    </span>
                  ) : l.isNearLimit ? (
                    <span className="badge badge-warning text-3xs font-bold uppercase">
                      80%+ Used
                    </span>
                  ) : null}
                </div>

                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-lg font-bold text-ink tabular-nums">
                    {l.currentUsage.toLocaleString()}
                  </span>
                  <span className="text-2xs text-ink-3 font-medium">
                    {isUnlimited ? 'Unlimited' : `of ${l.limit?.toLocaleString()} ${l.unit}`}
                  </span>
                </div>

                {/* Progress bar */}
                <div className="mt-3 w-full bg-surface-3 rounded-full h-1.5 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isUnlimited
                        ? 'bg-success/50 w-full'
                        : isExceeded
                        ? 'bg-danger'
                        : l.isNearLimit
                        ? 'bg-warning'
                        : 'bg-accent'
                    }`}
                    style={{ width: isUnlimited ? '100%' : `${percent}%` }}
                  />
                </div>

                <div className="mt-2 flex items-center justify-between text-3xs text-ink-3">
                  <span>Capacity</span>
                  <span>{isUnlimited ? '∞' : `${percent}%`}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Feature Entitlements */}
      <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        <h4 className="text-sm font-bold text-ink mb-1">Feature Entitlements</h4>
        <p className="text-2xs text-ink-3 mb-4">
          Features enabled under the current subscription tier and custom workspace entitlements.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
          {overview.features.map((feat) => (
            <div
              key={feat.key}
              className={`p-3 rounded-lg border flex items-center gap-3 transition-colors ${
                feat.enabled
                  ? 'border-line bg-surface-2/30 text-ink'
                  : 'border-line/40 bg-surface-3/20 text-ink-3 opacity-60'
              }`}
            >
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                  feat.enabled
                    ? 'bg-success-soft text-success'
                    : 'bg-surface-3 text-ink-3'
                }`}
              >
                {feat.enabled ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Lock className="w-3 h-3" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold truncate">{feat.name}</p>
                <p className="text-3xs text-ink-3 truncate">{feat.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Upgrade / Change Plan Modal */}
      {upgradeModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-surface rounded-2xl border border-line shadow-2xl max-w-2xl w-full p-6 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-line">
              <div>
                <h3 className="text-lg font-bold text-ink">Change Subscription Tier</h3>
                <p className="text-2xs text-ink-3">
                  Choose a plan tailored to your team&apos;s support volume.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setUpgradeModalOpen(false)}
                className="btn btn-xs btn-ghost text-ink-3 hover:text-ink"
              >
                ✕
              </button>
            </div>

            <div className="mt-6 space-y-4">
              {availablePlans.map((plan) => {
                const isCurrent = plan.slug === overview.plan.slug;
                return (
                  <div
                    key={plan.id}
                    className={`p-4 rounded-xl border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                      isCurrent
                        ? 'border-accent bg-accent-soft/20 ring-1 ring-accent'
                        : 'border-line hover:border-line-hover bg-surface-2/30'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-ink">{plan.name}</h4>
                        {isCurrent && (
                          <span className="badge badge-accent text-3xs uppercase font-bold">
                            Current Plan
                          </span>
                        )}
                        {plan.is_popular && (
                          <span className="badge badge-warning text-3xs uppercase font-bold">
                            Popular
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-ink-2 mt-1">{plan.description}</p>
                      <div className="mt-2 text-2xs text-ink-3 flex items-center gap-3">
                        <span>${plan.monthly_price}/mo</span>
                        <span>•</span>
                        <span>
                          {plan.max_agents ?? '∞'} Seats
                        </span>
                        <span>•</span>
                        <span>
                          {plan.max_tickets_per_month ?? '∞'} Tickets
                        </span>
                      </div>
                    </div>

                    <div className="shrink-0">
                      {isCurrent ? (
                        <span className="text-xs font-semibold text-accent flex items-center gap-1">
                          <Check className="w-3.5 h-3.5" /> Selected
                        </span>
                      ) : (
                        <a
                          href="mailto:support@zentry.io?subject=Upgrade%20Request%20for%20Workspace"
                          className="btn btn-sm btn-primary text-xs"
                        >
                          Request Upgrade
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 pt-4 border-t border-line flex justify-end">
              <button
                type="button"
                onClick={() => setUpgradeModalOpen(false)}
                className="btn btn-sm btn-ghost text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
