'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Building2,
  Users,
  CreditCard,
  Activity,
  ShieldAlert,
  Search,
  ExternalLink,
  Sun,
  Moon,
  Menu,
  X,
  Command,
  ArrowLeft,
  Shield,
  ArrowRight,
  LogOut,
  Sliders,
  KeyRound,
  Bot,
} from 'lucide-react';
import { Agent } from '@/types/database';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { SuperAdminCommandPalette } from './SuperAdminCommandPalette';
import { getPlatformGlobalSearchAction } from '@/app/actions/platform';
import { cn } from '@/lib/utils';

interface SuperAdminShellProps {
  currentAgent: Agent;
  children: React.ReactNode;
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  exact?: boolean;
  ownerOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Overview', href: '/admin', icon: LayoutDashboard, exact: true },
  { label: 'Workspaces', href: '/admin/workspaces', icon: Building2 },
  { label: 'Users', href: '/admin/users', icon: Users },
  { label: 'AI Model & Usage', href: '/admin/ai', icon: Bot },
  { label: 'Global Defaults', href: '/admin/defaults', icon: Sliders },
  { label: 'Admin Access', href: '/admin/access', icon: KeyRound, ownerOnly: true },
  { label: 'System Health', href: '/admin/health', icon: Activity },
  { label: 'Audit Log', href: '/admin/audit', icon: ShieldAlert },
];

export function SuperAdminShell({ currentAgent, children }: SuperAdminShellProps) {
  const pathname = usePathname();
  const router = useRouter();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // Global search bar state in header
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<{
    workspaces: Array<{ id: string; name: string; brand_color: string; plan: string; status: string }>;
    users: Array<{ id: string; name: string; email: string; role: string; workspace_name: string | null }>;
  }>({ workspaces: [], users: [] });
  const [searchOpen, setSearchOpen] = useState(false);

  // Initialize theme
  useEffect(() => {
    const currentTheme = (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
    setTheme(currentTheme);
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    try {
      localStorage.setItem('theme', nextTheme);
      localStorage.setItem('zentry-theme', nextTheme);
    } catch {}
  };

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileMenuOpen(false);
    setSearchOpen(false);
  }, [pathname]);

  // Debounced header search
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      setSearchResults({ workspaces: [], users: [] });
      setSearchLoading(false);
      setSearchOpen(false);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchLoading(true);
      setSearchOpen(true);
      try {
        const res = await getPlatformGlobalSearchAction(searchQuery);
        setSearchResults(res);
      } catch {
        setSearchResults({ workspaces: [], users: [] });
      } finally {
        setSearchLoading(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const isNavActive = (item: NavItem) => {
    if (item.exact) {
      return pathname === item.href;
    }
    return pathname.startsWith(item.href);
  };

  return (
    <div className="flex h-screen w-screen bg-canvas text-ink overflow-hidden">
      {/* Command Palette */}
      <SuperAdminCommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-64 bg-surface border-r border-line flex-col justify-between shrink-0 z-30 select-none">
        <div className="flex flex-col">
          {/* Logo & Super Admin Header */}
          <div className="h-16 px-5 border-b border-line flex items-center justify-between">
            <Link href="/admin" className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-accent text-accent-ink flex items-center justify-center font-bold text-sm shadow-xs">
                <Shield className="w-4 h-4" />
              </div>
              <div className="flex flex-col">
                <span className="font-bold tracking-tight text-ink text-sm">Zen-try</span>
                <span className="text-2xs font-semibold uppercase tracking-wider text-accent -mt-0.5">
                  Platform Admin
                </span>
              </div>
            </Link>

            <Badge tone="accent" className="text-2xs uppercase">
              Root
            </Badge>
          </div>

          {/* Navigation Items */}
          <nav className="p-3 space-y-1">
            {NAV_ITEMS.filter((item) => !item.ownerOnly || currentAgent.is_platform_owner).map((item) => {
              const active = isNavActive(item);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-md text-ui font-medium transition-colors',
                    active
                      ? 'bg-accent/10 text-accent font-semibold shadow-2xs'
                      : 'text-ink-2 hover:text-ink hover:bg-surface-3'
                  )}
                >
                  <Icon className={cn('w-4 h-4', active ? 'text-accent' : 'text-ink-3')} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Footer Area */}
        <div className="p-3 border-t border-line space-y-2">
          {/* Back to workspace dashboard */}
          <Link
            href="/dashboard"
            className="w-full flex items-center justify-between px-3 py-2 rounded-md text-ui text-ink-2 hover:text-ink hover:bg-surface-3 transition-colors"
            title="Open tenant inbox and workspace settings"
          >
            <span className="flex items-center gap-2.5">
              <ArrowLeft className="w-4 h-4 text-ink-3" />
              <span className="text-xs">Workspace App</span>
            </span>
            <ExternalLink className="w-3.5 h-3.5 text-ink-3" />
          </Link>

          {/* Theme Toggle & User Info */}
          <div className="pt-2 border-t border-line/60 flex items-center justify-between px-1">
            <div className="flex items-center gap-2 min-w-0">
              <Avatar name={currentAgent.name} size="sm" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-ink truncate">{currentAgent.name}</div>
                <div className="text-2xs text-ink-3 truncate">{currentAgent.email}</div>
              </div>
            </div>

            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="p-1.5 rounded-md text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors"
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header */}
        <header className="h-16 border-b border-line bg-surface px-4 sm:px-6 flex items-center justify-between gap-4 shrink-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            {/* Mobile menu trigger */}
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden p-2 rounded-md text-ink-2 hover:text-ink hover:bg-surface-3 transition-colors"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Breadcrumb / Title */}
            <div className="min-w-0">
              <h1 className="text-sm sm:text-base font-semibold text-ink tracking-tight truncate">
                {pathname === '/admin' && 'Platform Overview'}
                {pathname === '/admin/workspaces' && 'Workspaces Directory'}
                {pathname.startsWith('/admin/workspaces/') && 'Workspace Detail'}
                {pathname.startsWith('/admin/users') && 'All Platform Users'}
                {pathname.startsWith('/admin/access') && 'Admin Access Control'}
                {pathname.startsWith('/admin/health') && 'System Health & Diagnostics'}
                {pathname.startsWith('/admin/audit') && 'Super Admin Audit Log'}
              </h1>
            </div>
          </div>

          {/* Right Header Actions */}
          <div className="flex items-center gap-2.5">
            {/* Global Search Bar with Autocomplete Dropdown */}
            <div className="relative hidden sm:block w-64 lg:w-80">
              <div className="relative">
                <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={() => {
                    if (searchQuery.trim().length >= 2) setSearchOpen(true);
                  }}
                  placeholder="Search workspaces & users..."
                  className="w-full h-9 pl-9 pr-8 rounded-md border border-line bg-surface-2/60 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
                />
                {searchQuery && (
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setSearchOpen(false);
                    }}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Autocomplete Dropdown */}
              {searchOpen && (
                <div className="absolute top-11 left-0 right-0 bg-surface border border-line rounded-lg shadow-lg popover z-50 overflow-hidden divide-y divide-line/40 max-h-80 overflow-y-auto">
                  {searchLoading && (
                    <div className="p-4 text-center text-xs text-ink-3 animate-pulse">
                      Searching...
                    </div>
                  )}

                  {!searchLoading && searchResults.workspaces.length > 0 && (
                    <div className="p-2">
                      <div className="px-2 py-1 text-2xs font-semibold uppercase text-ink-3">
                        Workspaces
                      </div>
                      {searchResults.workspaces.map((w) => (
                        <button
                          key={w.id}
                          onClick={() => {
                            setSearchOpen(false);
                            setSearchQuery('');
                            router.push(`/admin/workspaces/${w.id}`);
                          }}
                          className="w-full px-2 py-1.5 rounded flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-xs text-ink"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: w.brand_color }}
                            />
                            <span className="truncate">{w.name}</span>
                          </span>
                          <span className="text-2xs text-ink-3 capitalize">{w.plan}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {!searchLoading && searchResults.users.length > 0 && (
                    <div className="p-2">
                      <div className="px-2 py-1 text-2xs font-semibold uppercase text-ink-3">Users</div>
                      {searchResults.users.map((u) => (
                        <button
                          key={u.id}
                          onClick={() => {
                            setSearchOpen(false);
                            setSearchQuery('');
                            router.push(`/admin/users?search=${encodeURIComponent(u.email)}`);
                          }}
                          className="w-full px-2 py-1.5 rounded flex items-center justify-between text-left hover:bg-surface-3 transition-colors text-xs text-ink"
                        >
                          <span className="min-w-0">
                            <span className="truncate block font-medium">{u.name}</span>
                            <span className="text-2xs text-ink-3 truncate block">{u.email}</span>
                          </span>
                          <span className="text-2xs text-ink-3 capitalize">{u.role}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {!searchLoading &&
                    searchResults.workspaces.length === 0 &&
                    searchResults.users.length === 0 && (
                      <div className="p-4 text-center text-xs text-ink-3">
                        No matches found.
                      </div>
                    )}
                </div>
              )}
            </div>

            {/* Ctrl+K Command Palette Trigger */}
            <button
              onClick={() => setPaletteOpen(true)}
              className="h-9 px-3 rounded-md border border-line bg-surface-2/40 hover:bg-surface-3 text-xs text-ink-2 flex items-center gap-2 transition-colors"
              title="Open Command Palette (Ctrl+K)"
            >
              <Command className="w-3.5 h-3.5 text-ink-3" />
              <span className="hidden sm:inline">Commands</span>
              <kbd className="hidden lg:inline text-2xs font-mono px-1 py-0.5 rounded bg-surface border border-line text-ink-3">
                Ctrl K
              </kbd>
            </button>
          </div>
        </header>

        {/* Page Content Body */}
        <main className="flex-1 overflow-y-auto bg-canvas p-4 sm:p-6 md:p-8">
          <div className="max-w-7xl mx-auto w-full">{children}</div>
        </main>
      </div>

      {/* Mobile Sidebar Sheet */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 bg-overlay flex md:hidden animate-in fade-in duration-150"
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            className="w-72 bg-surface h-full flex flex-col justify-between border-r border-line p-4 shadow-xl popover"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-accent text-accent-ink flex items-center justify-center font-bold">
                    <Shield className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="font-bold text-sm block">Zen-try</span>
                    <span className="text-2xs text-accent uppercase font-semibold">Super Admin</span>
                  </div>
                </div>
                <button
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-1 rounded text-ink-3 hover:text-ink"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <nav className="space-y-1">
                {NAV_ITEMS.filter((item) => !item.ownerOnly || currentAgent.is_platform_owner).map((item) => {
                  const active = isNavActive(item);
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                        active ? 'bg-accent/10 text-accent font-semibold' : 'text-ink-2 hover:text-ink'
                      )}
                    >
                      <Icon className="w-4 h-4" />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </nav>
            </div>

            <div className="border-t border-line pt-4 space-y-3">
              <Link
                href="/dashboard"
                className="flex items-center justify-between text-xs text-ink-2 hover:text-ink"
              >
                <span>Back to Workspace App</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </Link>
              <div className="flex items-center justify-between text-xs text-ink-3">
                <span>Theme</span>
                <button onClick={toggleTheme} className="p-1 border border-line rounded">
                  {theme === 'dark' ? 'Dark' : 'Light'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
