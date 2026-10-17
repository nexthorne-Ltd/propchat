import React from 'react';
import { LandingNav } from '@/components/marketing/LandingNav';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';
import { PricingView } from '@/components/pricing/PricingView';
import { getPublicPlansAction } from '@/app/actions/plans';

export const metadata = {
  title: 'Pricing & Plans — Zen-try',
  description:
    'Transparent, predictable plans for modern customer care teams. Omnichannel inbox, AI agent, custom help center, and SLA enforcement.',
};

export default async function PricingPage() {
  const plans = await getPublicPlansAction();

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      <LandingNav />

      <main className="flex-1">
        <PricingView initialPlans={plans} />
      </main>

      <MarketingFooter />
    </div>
  );
}
