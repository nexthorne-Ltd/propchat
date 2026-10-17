import React from 'react';
import { assertSuperAdmin } from '@/app/actions/platform';
import { GlobalDefaultsView } from '@/components/admin/GlobalDefaultsView';

export const metadata = {
  title: 'Global Defaults & Policies — Zentry Super Admin',
  description: 'Manage platform-wide setting defaults, limits, and fallback policies.',
};

export default async function GlobalDefaultsPage() {
  try {
    await assertSuperAdmin();
  } catch (err: any) {
    return (
      <div className="flex h-96 w-full flex-col items-center justify-center bg-canvas text-ink p-6">
        <div className="max-w-md w-full p-8 rounded-2xl border border-danger/30 bg-surface text-center space-y-4 shadow-lg">
          <div className="w-12 h-12 rounded-xl bg-danger/10 text-danger flex items-center justify-center mx-auto text-xl font-bold">
            403
          </div>
          <h1 className="text-xl font-bold text-ink tracking-tight">403 - Forbidden</h1>
          <p className="text-sm text-ink-3">
            Access denied. Platform super administrator privileges are required.
          </p>
          <a
            href="/dashboard"
            className="inline-block px-4 py-2 rounded-xl bg-accent text-accent-ink text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            Return to Dashboard
          </a>
        </div>
      </div>
    );
  }

  return <GlobalDefaultsView />;
}
