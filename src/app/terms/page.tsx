import React from 'react';
import Link from 'next/link';
import { LegalLayout } from '@/components/marketing/LegalLayout';

export const metadata = {
  title: 'Terms of Service | Zen-try',
  description: 'The terms that apply when you use Zen-try.',
};

export default function TermsPage() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Terms of Service"
      updated="October 2026"
      intro={<p>The agreement between you and Zen-try when you create a workspace or use the service.</p>}
      related={{ label: 'Privacy Policy', href: '/privacy' }}
      sections={[
        {
          id: 'acceptance',
          title: 'Acceptance of terms',
          body: (
            <p>
              By signing up for an account, accessing, or using Zen-try (&quot;the Service&quot;), you agree to be bound by these
              Terms of Service. If you do not agree to these terms, do not create an account or use the Service.
            </p>
          ),
        },
        {
          id: 'account-security',
          title: 'Workspace and account security',
          body: (
            <p>
              You are responsible for maintaining the confidentiality of your workspace credentials, API keys, and email access.
              Email verification is required before workspaces become active to ensure verified ownership. You must notify us
              immediately of any unauthorized use of your account.
            </p>
          ),
        },
        {
          id: 'acceptable-use',
          title: 'Acceptable use policy',
          body: (
            <p>
              You agree not to use Zen-try to transmit spam, unlawful, abusive, or malicious content. Automated scraping of
              visitor data without consent or interference with widget delivery across subscriber websites is strictly
              prohibited.
            </p>
          ),
        },
        {
          id: 'ai-and-data',
          title: 'AI features and customer data',
          body: (
            <p>
              Zen-try offers AI copilot features that process conversations and knowledge notes to provide automated
              assistance. Your customer conversations are your proprietary data and will never be shared with third parties for
              general model training without explicit consent.
            </p>
          ),
        },
        {
          id: 'availability',
          title: 'Service availability and modifications',
          body: (
            <p>
              We strive for 99.9% uptime. However, we reserve the right to modify, suspend, or discontinue aspects of the
              Service with reasonable notice for maintenance, security upgrades, or feature enhancements.
            </p>
          ),
        },
        {
          id: 'contact',
          title: 'Contact information',
          body: (
            <p>
              For legal inquiries regarding these terms, please contact us through our <Link href="/help">Help Center</Link>.
            </p>
          ),
        },
      ]}
    />
  );
}
