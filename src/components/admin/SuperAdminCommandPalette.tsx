'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Building2,
  Users,
  Activity,
  ShieldAlert,
  Search,
  ExternalLink,
  Sun,
  Moon,
  ArrowRight,
  KeyRound,
  Sliders,
} from 'lucide-react';
import { getPlatformGlobalSearchAction } from '@/app/actions/platform';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';

interface SuperAdminCommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function SuperAdminCommandPalette({ open, onClose }: SuperAdminCommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{
    workspaces: Array<{ id: string; name: string; brand_color: string; plan: string; status: string }>;
    users: Array<{ id: string; name: string; email: string; role: string; workspace_name: string | null }>;
  }>({ workspaces: [], users: [] });

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setResults({ workspaces: [], users: [] });
    }
  }, [open]);

  // Global Ctrl+K / Esc listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) onClose();
      } else if (e.key === 'Escape' && open) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Debounced search
  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setResults({ workspaces: [], users: [] });
      setLoading(false);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await getPlatformGlobalSearchAction(query);
        setResults(data);
      } catch {
        setResults({ workspaces: [], users: [] });
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query]);

  if (!open) return null;

  const navigateTo = (path: string) => {
    onClose();
    router.push(path);
  };

  const toggleTheme = () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {}
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-70 bg-overlay flex items-start justify-center pt-16 sm:pt-24 px-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-surface border border-line-2 rounded-xl shadow-xl overflow-hidden popover flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Super Admin Command Palette"
      >
        {/* Input Bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line bg-surface-2/40 shrink-0">
          <Search className="w-4 h-4 text-ink-3 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workspaces, users, or jump to page..."
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-3 outline-none"
          />
          <span className="text-2xs font-mono px-1.5 py-0.5 rounded bg-surface-3 text-ink-3 border border-line">
            ESC
          </span>
        </div>

        {/* Content list */}
        <div className="overflow-y-auto p-2 divide-y divide-line/40 text-ui">
          {/* Quick Navigations */}
          {!query && (
            <div className="py-2 space-y-1">
              <div className="px-3 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                Quick Navigation
              </div>
              <button
                onClick={() => navigateTo('/admin')}
                className="w-full px-3 py-2 rounded-lg flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-ink"
              >
                <span className="flex items-center gap-2.5">
                  <LayoutDashboard className="w-4 h-4 text-accent" />
                  <span>Overview & Metrics</span>
                </span>
                <span className="text-2xs text-ink-3 font-mono">/admin</span>
              </button>
              <button
                onClick={() => navigateTo('/admin/workspaces')}
                className="w-full px-3 py-2 rounded-lg flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-ink"
              >
                <span className="flex items-center gap-2.5">
                  <Building2 className="w-4 h-4 text-accent" />
                  <span>All Workspaces Directory</span>
                </span>
                <span className="text-2xs text-ink-3 font-mono">/admin/workspaces</span>
              </button>
              <button
                onClick={() => navigateTo('/admin/users')}
                className="w-full px-3 py-2 rounded-lg flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-ink"
              >
                <span className="flex items-center gap-2.5">
                  <Users className="w-4 h-4 text-accent" />
                  <span>Platform Users</span>
                </span>
                <span className="text-2xs text-ink-3 font-mono">/admin/users</span>
              </button>
              <button
                onClick={() => navigateTo('/admin/defaults')}
                className="w-full px-3 py-2 rounded-lg flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-ink"
              >
                <span className="flex items-center gap-2.5">
                  <Sliders className="w-4 h-4 text-accent" />
                  <span>Global Defaults & Policies</span>
                </span>
                <span className="text-2xs text-ink-3 font-mono">/admin/defaults</span>
              </button>
              <button
                onClick={() => navigateTo('/admin/access')}
                className="w-full px-3 py-2 rounded-lg flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-ink"
              >
                <span className="flex items-center gap-2.5">
                  <KeyRound className="w-4 h-4 text-accent" />
                  <span>Admin Access Control</span>
                </span>
                <span className="text-2xs text-ink-3 font-mono">/admin/access</span>
              </button>
              <button
                onClick={() => navigateTo('/admin/health')}
                className="w-full px-3 py-2 rounded-lg flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-ink"
              >
                <span className="flex items-center gap-2.5">
                  <Activity className="w-4 h-4 text-accent" />
                  <span>System Health & Diagnostics</span>
                </span>
                <span className="text-2xs text-ink-3 font-mono">/admin/health</span>
              </button>
              <button
                onClick={() => navigateTo('/admin/audit')}
                className="w-full px-3 py-2 rounded-lg flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-ink"
              >
                <span className="flex items-center gap-2.5">
                  <ShieldAlert className="w-4 h-4 text-accent" />
                  <span>Super Admin Audit Log</span>
                </span>
                <span className="text-2xs text-ink-3 font-mono">/admin/audit</span>
              </button>
              <button
                onClick={toggleTheme}
                className="w-full px-3 py-2 rounded-lg flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-ink"
              >
                <span className="flex items-center gap-2.5">
                  <Sun className="w-4 h-4 text-accent" />
                  <span>Toggle Light / Dark Mode</span>
                </span>
                <span className="text-2xs text-ink-3">Theme</span>
              </button>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="py-6 text-center text-xs text-ink-3 animate-pulse">
              Searching platform records...
            </div>
          )}

          {/* Workspaces results */}
          {!loading && results.workspaces.length > 0 && (
            <div className="py-2 space-y-1">
              <div className="px-3 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                Matching Workspaces
              </div>
              {results.workspaces.map((w) => (
                <button
                  key={w.id}
                  onClick={() => navigateTo(`/admin/workspaces/${w.id}`)}
                  className="w-full px-3 py-2 rounded-lg flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-ink"
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: w.brand_color || '#2563eb' }}
                    />
                    <span className="font-medium truncate">{w.name}</span>
                    <Badge tone={w.status === 'suspended' ? 'warn' : 'neutral'}>
                      {w.plan}
                    </Badge>
                  </span>
                  <ArrowRight className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                </button>
              ))}
            </div>
          )}

          {/* Users results */}
          {!loading && results.users.length > 0 && (
            <div className="py-2 space-y-1">
              <div className="px-3 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                Matching Users
              </div>
              {results.users.map((u) => (
                <button
                  key={u.id}
                  onClick={() => navigateTo(`/admin/users?search=${encodeURIComponent(u.email)}`)}
                  className="w-full px-3 py-2 rounded-lg flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-ink"
                >
                  <span className="min-w-0">
                    <span className="font-medium text-ink truncate block">{u.name}</span>
                    <span className="text-2xs text-ink-3 truncate block">{u.email}</span>
                  </span>
                  <Badge tone="neutral">{u.role}</Badge>
                </button>
              ))}
            </div>
          )}

          {/* Empty search */}
          {!loading && query.trim().length >= 2 && results.workspaces.length === 0 && results.users.length === 0 && (
            <div className="py-8 text-center text-xs text-ink-3">
              No workspaces or users matching &ldquo;{query}&rdquo;
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
