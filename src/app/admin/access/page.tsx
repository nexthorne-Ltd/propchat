import React from 'react';
import { assertPlatformOwner } from '@/app/actions/platform';
import { AdminAccessView } from '@/components/admin/AdminAccessView';

export const metadata = {
  title: 'Admin Access — Zentry Super Admin',
  description: 'Manage platform admin privileges. Only the platform owner can grant or revoke access.',
};

export default async function AdminAccessPage() {
  // Server-side database verification: only the owner can view this page
  try {
    await assertPlatformOwner();
  } catch (err: any) {
    return (
      <div className="flex h-96 w-full flex-col items-center justify-center bg-canvas text-ink p-6">
        <div className="max-w-md w-full p-8 rounded-2xl border border-danger/30 bg-surface text-center space-y-4 shadow-lg">
          <div className="w-12 h-12 rounded-xl bg-danger/10 text-danger flex items-center justify-center mx-auto text-xl font-bold">
            403
          </div>
          <h1 className="text-xl font-bold text-ink tracking-tight">403 - Forbidden</h1>
          <p className="text-sm text-ink-3">
            Access denied. Only the platform owner can view or manage administrative access.
          </p>
          <a
            href="/admin"
            className="inline-block px-4 py-2 rounded-xl bg-accent text-accent-ink text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            Return to Overview
          </a>
        </div>
      </div>
    );
  }

  return <AdminAccessView />;
}
