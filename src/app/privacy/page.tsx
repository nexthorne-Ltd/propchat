import React from 'react';
import Link from 'next/link';
import { LegalLayout } from '@/components/marketing/LegalLayout';

export const metadata = {
  title: 'Privacy Policy | Zen-try',
  description: 'How Zen-try collects, uses and protects your data and your visitors’ data.',
};

export default function PrivacyPage() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Privacy Policy"
      updated="October 2026"
      intro={<p>What we collect when you use Zen-try or chat through the Zen-try widget, why, and who we share it with.</p>}
      related={{ label: 'Terms of Service', href: '/terms' }}
      sections={[
        {
          id: 'information-we-collect',
          title: 'Information we collect',
          body: (
            <p>
              When you create an account, we collect your name, business email address, and authentication credentials. For
              website visitors chatting via the Zen-try widget, we collect session metadata including IP address, browser type,
              referral URLs, and active page paths to enable live routing.
            </p>
          ),
        },
        {
          id: 'how-we-use-it',
          title: 'How we use your information',
          body: (
            <p>
              We use collected information to provision your multi-tenant workspace, deliver real-time messages, calculate
              platform analytics, and send necessary transactional notifications (such as email confirmations and unread
              message alerts).
            </p>
          ),
        },
        {
          id: 'retention-and-isolation',
          title: 'Data retention and isolation',
          body: (
            <p>
              Each workspace operates in strict tenant isolation protected by PostgreSQL Row Level Security (RLS). You can
              request data exports or deletion of your workspace and conversation history at any time from your administration
              settings.
            </p>
          ),
        },
        {
          id: 'third-parties',
          title: 'Third-party integrations',
          body: (
            <p>
              We integrate with trusted infrastructure providers including Supabase (authentication and database hosting),
              Cloudinary (secure media attachments), and Vercel (custom domain SSL edge termination). We do not sell your
              personal data.
            </p>
          ),
        },
        {
          id: 'contact',
          title: 'Contact our privacy team',
          body: (
            <p>
              If you have any questions or data protection requests under GDPR or CCPA, reach out through our{' '}
              <Link href="/help">Help Center</Link>.
            </p>
          ),
        },
      ]}
    />
  );
}
