'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  Check,
  Minus,
  Sparkles,
  Zap,
  ArrowRight,
  ShieldCheck,
  Clock,
  HelpCircle,
  Layers,
  ChevronDown,
} from 'lucide-react';
import { PlatformPlan } from '@/types/plans';
import {
  PLAN_FEATURES,
  RESOURCE_LIMITS,
  PLAN_FEATURE_CATEGORIES,
  PlanFeatureCategory,
  PlanLimitDefinition,
} from '@/lib/plans/features';

interface PricingViewProps {
  initialPlans: PlatformPlan[];
}

export function PricingView({ initialPlans }: PricingViewProps) {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');

  // Filter only public and active plans
  const publicPlans = initialPlans.filter(
    (p) => p.visibility === 'public' && !p.is_archived
  );

  return (
    <div className="py-16 sm:py-24">
      <div className="u-container">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto">
          <span className="badge badge-accent inline-flex items-center gap-1.5 px-3 py-1 font-semibold text-xs tracking-wide uppercase">
            <Sparkles className="w-3.5 h-3.5" />
            Simple, Transparent Pricing
          </span>
          <h1 className="mt-4 text-3xl sm:text-5xl font-bold tracking-tight text-ink">
            Predictable plans designed to scale with your support team
          </h1>
          <p className="mt-4 text-base sm:text-lg text-ink-2 leading-relaxed">
            All plans include core shared inbox, real-time widget, contact history, and lightning-fast collaboration.
            No hidden setup fees or surprise overage charges.
          </p>

          {/* Monthly / Yearly Toggle */}
          <div className="mt-8 inline-flex items-center p-1 rounded-xl bg-surface-2 border border-line">
            <button
              type="button"
              onClick={() => setBillingCycle('monthly')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                billingCycle === 'monthly'
                  ? 'bg-surface text-ink shadow-sm'
                  : 'text-ink-2 hover:text-ink'
              }`}
            >
              Monthly Billing
            </button>
            <button
              type="button"
              onClick={() => setBillingCycle('yearly')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 ${
                billingCycle === 'yearly'
                  ? 'bg-surface text-ink shadow-sm'
                  : 'text-ink-2 hover:text-ink'
              }`}
            >
              <span>Annual Billing</span>
              <span className="badge badge-success text-2xs uppercase tracking-wider py-0.5 px-1.5">
                Save ~20%
              </span>
            </button>
          </div>
        </div>

        {/* Plan Cards Grid */}
        <div className="mt-14 grid gap-8 md:grid-cols-2 lg:grid-cols-3 max-w-6xl mx-auto items-stretch">
          {publicPlans.map((plan) => {
            const price =
              billingCycle === 'yearly'
                ? plan.yearly_price
                : plan.monthly_price;
            const perMonthEquivalent =
              billingCycle === 'yearly'
                ? Math.round(plan.yearly_price / 12)
                : plan.monthly_price;

            const isPopular = plan.is_popular;

            return (
              <div
                key={plan.id}
                className={`relative flex flex-col justify-between rounded-2xl p-7 transition-all ${
                  isPopular
                    ? 'bg-surface border-2 border-accent shadow-xl shadow-accent/5 ring-1 ring-accent'
                    : 'bg-surface border border-line shadow-sm hover:border-line-hover'
                }`}
              >
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-accent text-accent-contrast text-2xs font-bold uppercase tracking-wider px-3 py-1 rounded-full shadow-md flex items-center gap-1">
                      <Sparkles className="w-3 h-3" /> Most Popular
                    </span>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xl font-bold text-ink">{plan.name}</h3>
                    {plan.trial_days > 0 && (
                      <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-accent-soft text-accent">
                        {plan.trial_days}-day free trial
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs sm:text-sm text-ink-2 min-h-[40px] leading-relaxed">
                    {plan.description}
                  </p>

                  {/* Price */}
                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="text-4xl font-extrabold text-ink tracking-tight">
                      ${billingCycle === 'yearly' ? perMonthEquivalent : price}
                    </span>
                    <span className="text-sm font-medium text-ink-3">/ agent / month</span>
                  </div>

                  {billingCycle === 'yearly' && (
                    <p className="mt-1 text-2xs text-ink-3">
                      Billed annually (${price} per year)
                    </p>
                  )}

                  {/* Key Limits highlight */}
                  <div className="mt-6 pt-6 border-t border-line space-y-3">
                    <p className="text-2xs font-bold uppercase tracking-wider text-ink-3">
                      Included Capacity
                    </p>

                    <div className="flex items-center gap-2.5 text-xs text-ink">
                      <div className="w-4 h-4 rounded-full bg-accent-soft flex items-center justify-center shrink-0">
                        <Check className="w-2.5 h-2.5 text-accent" />
                      </div>
                      <span>
                        <strong>
                          {plan.max_agents === null ? 'Unlimited' : plan.max_agents}
                        </strong>{' '}
                        team seats
                      </span>
                    </div>

                    <div className="flex items-center gap-2.5 text-xs text-ink">
                      <div className="w-4 h-4 rounded-full bg-accent-soft flex items-center justify-center shrink-0">
                        <Check className="w-2.5 h-2.5 text-accent" />
                      </div>
                      <span>
                        <strong>
                          {plan.max_tickets_per_month === null
                            ? 'Unlimited'
                            : plan.max_tickets_per_month.toLocaleString()}
                        </strong>{' '}
                        tickets / month
                      </span>
                    </div>

                    <div className="flex items-center gap-2.5 text-xs text-ink">
                      <div className="w-4 h-4 rounded-full bg-accent-soft flex items-center justify-center shrink-0">
                        <Check className="w-2.5 h-2.5 text-accent" />
                      </div>
                      <span>
                        <strong>
                          {plan.max_ai_bot_replies_per_month === null
                            ? 'Unlimited'
                            : plan.max_ai_bot_replies_per_month.toLocaleString()}
                        </strong>{' '}
                        AI bot answers / mo
                      </span>
                    </div>

                    <div className="flex items-center gap-2.5 text-xs text-ink">
                      <div className="w-4 h-4 rounded-full bg-accent-soft flex items-center justify-center shrink-0">
                        <Check className="w-2.5 h-2.5 text-accent" />
                      </div>
                      <span>
                        <strong>
                          {plan.max_channels_connected === null
                            ? 'Unlimited'
                            : plan.max_channels_connected}
                        </strong>{' '}
                        connected channels
                      </span>
                    </div>
                  </div>
                </div>

                {/* Card CTA */}
                <div className="mt-8 pt-4">
                  <Link
                    href={`/signup?plan=${plan.slug}&billing=${billingCycle}`}
                    className={`btn w-full justify-center text-sm py-2.5 font-semibold ${
                      isPopular
                        ? 'btn-primary shadow-sm'
                        : 'btn-outline'
                    }`}
                  >
                    <span>
                      {plan.trial_days > 0
                        ? `Start ${plan.trial_days}-day free trial`
                        : 'Get started'}
                    </span>
                    <ArrowRight className="w-4 h-4 ml-1" />
                  </Link>
                  <p className="mt-2 text-center text-2xs text-ink-3">
                    No credit card required upfront
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Feature Comparison Table */}
        <div className="mt-24 max-w-6xl mx-auto">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <h2 className="text-2xl sm:text-3xl font-bold text-ink">
              Compare All Plan Features & Limits
            </h2>
            <p className="mt-2 text-sm text-ink-2">
              Everything in Zen-try is built for speed, reliability, and real-time customer care.
            </p>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-line bg-surface-2">
                  <th className="py-4 px-6 text-sm font-bold text-ink min-w-[240px]">
                    Feature or Resource
                  </th>
                  {publicPlans.map((plan) => (
                    <th
                      key={plan.id}
                      className="py-4 px-6 text-sm font-bold text-center text-ink min-w-[150px]"
                    >
                      <div className="flex flex-col items-center">
                        <span>{plan.name}</span>
                        {plan.is_popular && (
                          <span className="text-3xs uppercase tracking-wider text-accent font-semibold mt-0.5">
                            Popular
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Resource Limits Section */}
                <tr className="border-b border-line bg-surface-3/50">
                  <td
                    colSpan={publicPlans.length + 1}
                    className="py-2.5 px-6 text-xs font-bold uppercase tracking-wider text-ink-2"
                  >
                    Resource Capacity & Limits
                  </td>
                </tr>

                {RESOURCE_LIMITS.map((limit: PlanLimitDefinition) => (
                  <tr
                    key={limit.id}
                    className="border-b border-line/50 hover:bg-surface-2/40 transition-colors"
                  >
                    <td className="py-3 px-6 text-xs text-ink">
                      <div className="font-medium text-ink">{limit.name}</div>
                      <div className="text-3xs text-ink-3">{limit.description}</div>
                    </td>
                    {publicPlans.map((plan) => {
                      const val = plan[limit.id as keyof PlatformPlan] as number | null;
                      return (
                        <td
                          key={plan.id}
                          className="py-3 px-6 text-center text-xs font-medium text-ink"
                        >
                          {val === null || val === undefined ? (
                            <span className="text-success font-semibold">Unlimited</span>
                          ) : (
                            <span>
                              {val.toLocaleString()} {limit.unit}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}

                {/* Features by Category */}
                {(
                  Object.keys(PLAN_FEATURE_CATEGORIES) as PlanFeatureCategory[]
                ).map((catKey) => {
                  const catDef = PLAN_FEATURE_CATEGORIES[catKey];
                  const catFeatures = PLAN_FEATURES.filter(
                    (f) => f.category === catKey
                  );
                  if (catFeatures.length === 0) return null;

                  return (
                    <React.Fragment key={catKey}>
                      <tr className="border-b border-line bg-surface-3/50">
                        <td
                          colSpan={publicPlans.length + 1}
                          className="py-2.5 px-6 text-xs font-bold uppercase tracking-wider text-ink-2"
                        >
                          {catDef.label}
                        </td>
                      </tr>

                      {catFeatures.map((feat) => (
                        <tr
                          key={feat.id}
                          className="border-b border-line/50 hover:bg-surface-2/40 transition-colors"
                        >
                          <td className="py-3 px-6 text-xs text-ink">
                            <div className="font-medium text-ink">{feat.name}</div>
                            <div className="text-3xs text-ink-3">{feat.description}</div>
                          </td>
                          {publicPlans.map((plan) => {
                            const isIncluded = Boolean(plan.features?.[feat.id]);
                            return (
                              <td
                                key={plan.id}
                                className="py-3 px-6 text-center text-xs"
                              >
                                {isIncluded ? (
                                  <div className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-success-soft text-success">
                                    <Check className="w-3.5 h-3.5" />
                                  </div>
                                ) : (
                                  <div className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-surface-3 text-ink-3">
                                    <Minus className="w-3.5 h-3.5" />
                                  </div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* FAQ Section */}
        <div className="mt-24 max-w-4xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-bold text-ink">
              Frequently Asked Questions About Plans
            </h2>
            <p className="mt-2 text-sm text-ink-2">
              Everything you need to know about trials, billing cycles, and feature access.
            </p>
          </div>

          <div className="space-y-4">
            {[
              {
                q: 'What happens when my free trial ends?',
                a: 'When your trial period concludes, your team will be prompted to select an active subscription. Your tickets, macros, workflows, and historical data remain completely safe and intact.',
              },
              {
                q: 'Can I upgrade, downgrade, or switch billing intervals at any time?',
                a: 'Yes! You can adjust your plan at any time in Workspace Settings > Billing. Upgrades apply immediately with prorated billing.',
              },
              {
                q: 'What happens if we reach 80% or 100% of a monthly limit?',
                a: 'Zen-try shows an early advisory banner when you reach 80% of any monthly resource limit so you never get caught by surprise. If a limit is hit, you can easily upgrade or request an enterprise quota boost.',
              },
              {
                q: 'Are existing workspaces grandfathered into Legacy unlimited?',
                a: 'Yes. All workspaces created prior to platform pricing tier enforcement are grandfathered into the internal Legacy plan with unlimited resources.',
              },
              {
                q: 'Do you offer custom pricing for large organizations?',
                a: 'Yes. We support custom enterprise agreements with dedicated account managers, custom SLA targets, volume AI reply bundles, and single sign-on (SSO). Contact our team to learn more.',
              },
            ].map((faq, i) => (
              <div
                key={i}
                className="p-5 rounded-xl border border-line bg-surface"
              >
                <h4 className="text-sm font-semibold text-ink flex items-center gap-2">
                  <HelpCircle className="w-4 h-4 text-accent shrink-0" />
                  {faq.q}
                </h4>
                <p className="mt-2 text-xs sm:text-sm text-ink-2 leading-relaxed pl-6">
                  {faq.a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
