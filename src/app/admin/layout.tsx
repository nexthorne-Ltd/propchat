import React from 'react';
import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { Agent } from '@/types/database';
import { SuperAdminShell } from '@/components/admin/SuperAdminShell';
import { ToastProvider } from '@/components/ui/Toast';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headerList = await headers();
  const currentPath = headerList.get('x-next-pathname') || '';
  if (
    currentPath === '/admin/invite' ||
    currentPath.startsWith('/admin/invite/') ||
    currentPath === '/admin/login' ||
    currentPath === '/admin/signup'
  ) {
    return <ToastProvider>{children}</ToastProvider>;
  }

  const supabase = await createClient();

  // getClaims verifies the session locally; the two lookups run together.
  const { data: claimData } = await supabase.auth.getClaims();
  const claims = claimData?.claims;
  const user = claims?.sub
    ? {
        id: claims.sub as string,
        email: (claims.email as string | undefined) ?? '',
        user_metadata: (claims.user_metadata as Record<string, string> | undefined) ?? {},
      }
    : null;

  if (!user) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-canvas text-ink p-6">
        <div className="max-w-md w-full p-8 rounded-2xl border border-danger/30 bg-surface text-center space-y-4 shadow-lg">
          <div className="w-12 h-12 rounded-xl bg-danger/10 text-danger flex items-center justify-center mx-auto text-xl font-bold">
            403
          </div>
          <h1 className="text-xl font-bold text-ink tracking-tight">403 - Forbidden</h1>
          <p className="text-sm text-ink-3">
            Authentication required. Platform super administrator privileges are required to access this system.
          </p>
          <a
            href="/admin/login"
            className="inline-block px-4 py-2 rounded-xl bg-accent text-accent-ink text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            Sign in to Zentry
          </a>
        </div>
      </div>
    );
  }

  // Server-side database verification of platform super admin privilege from platform_access table
  const [{ data: access }, { data: agent }] = await Promise.all([
    supabase.from('platform_access').select('role').eq('user_id', user.id).maybeSingle(),
    supabase.from('agents').select('*').eq('id', user.id).maybeSingle(),
  ]);

  if (!access || !['owner', 'admin'].includes(access.role)) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-canvas text-ink p-6">
        <div className="max-w-md w-full p-8 rounded-2xl border border-danger/30 bg-surface text-center space-y-4 shadow-lg">
          <div className="w-12 h-12 rounded-xl bg-danger/10 text-danger flex items-center justify-center mx-auto text-xl font-bold">
            403
          </div>
          <h1 className="text-xl font-bold text-ink tracking-tight">403 - Forbidden</h1>
          <p className="text-sm text-ink-3">
            Access denied. Platform super administrator privileges are required to access this system.
          </p>
          <div className="p-3 rounded-xl bg-surface-2 border border-border-subtle text-xs text-ink-3 space-y-1">
            <p>Signed in as: <strong className="text-ink">{user.email}</strong></p>
            <p className="text-ink-4">Platform owner access is assigned to <strong className="text-ink">zentry385@gmail.com</strong>.</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 justify-center pt-2">
            <a
              href="/dashboard"
              className="inline-block px-4 py-2 rounded-xl bg-surface-2 border border-border text-ink text-xs font-semibold hover:bg-surface-3 transition-colors"
            >
              Return to Workspace
            </a>
            <a
              href="/admin/login"
              className="inline-block px-4 py-2 rounded-xl bg-accent text-accent-ink text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              Sign in with an admin account
            </a>
          </div>
        </div>
      </div>
    );
  }

  const currentAgent: Agent = agent || ({
    id: user.id,
    name: user.user_metadata?.name || user.email?.split('@')[0] || 'Admin',
    email: user.email || '',
    role: 'owner',
    status: 'online',
    is_active: true,
  } as Agent);

  currentAgent.is_super_admin = true;
  currentAgent.is_platform_owner = access.role === 'owner';

  return (
    <ToastProvider>
      <SuperAdminShell currentAgent={currentAgent}>
        {children}
      </SuperAdminShell>
    </ToastProvider>
  );
}
