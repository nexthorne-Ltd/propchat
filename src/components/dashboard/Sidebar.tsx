'use client';

import React from 'react';
import {
  BarChart2,
  Bell,
  BookOpen,
  ChevronsUpDown,
  ExternalLink,
  Hand,
  HelpCircle,
  Inbox,
  MessagesSquare,
  Radio,
  Settings,
  Smartphone,
  Sparkles,
  Search,
  Ticket,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Agent, AgentStatus, Workspace } from '@/types/database';
import { openCommandPalette } from './DashboardCommandPalette';
import { sound } from '@/lib/sound';
import { requestNotificationPermission, cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/Avatar';
import { Menu } from '@/components/ui/Menu';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

export type View = 'inbox' | 'handovers' | 'tickets' | 'team' | 'visitors' | 'reports' | 'helpdesk' | 'settings' | 'unanswered';

interface SidebarProps {
  currentAgent: Agent | null;
  workspace: Workspace | null;
  activeView: View;
  onSelectView: (view: View) => void;
  counts: {
    open: number;
    liveVisitors: number;
    articles?: number;
    unanswered?: number;
    /** Conversations the bot handed over that no person has answered yet. */
    handovers?: number;
    /** Unread team-chat messages; mentions and direct messages make it urgent. */
    teamUnread?: number;
    teamUrgent?: boolean;
  };
  onUpdateAgentStatus: (status: AgentStatus) => void;
  onLogout: () => void;
  onOpenShortcuts?: () => void;
  onOpenMobileInstall?: () => void;
  hasVisitors?: boolean;
}

const STATUS_TINT: Record<AgentStatus, string> = {
  online: 'var(--ds-success)',
  away: 'var(--ds-warn)',
  offline: 'var(--ds-line-3)',
};

export function Sidebar({
  currentAgent,
  workspace,
  activeView,
  onSelectView,
  counts,
  onUpdateAgentStatus,
  onLogout,
  onOpenShortcuts,
  onOpenMobileInstall,
  hasVisitors = false,
}: SidebarProps) {
  const soundActive = React.useSyncExternalStore(
    sound.subscribe,
    sound.isEnabled,
    sound.isEnabledServer
  );

  const toggleSound = () => {
    if (sound.toggleSound()) sound.playSentMessage();
  };

  const enableNotifications = async () => {
    const granted = await requestNotificationPermission();
    if (granted) sound.playIncomingMessage();
  };

  const isAdmin =
    currentAgent?.role === 'admin' || currentAgent?.role === 'owner';

  const nav: {
    view: View;
    label: string;
    Icon: typeof Inbox;
    badge?: React.ReactNode;
  }[] = [
    {
      view: 'inbox',
      label: 'Inbox',
      Icon: Inbox,
      badge: counts.open > 0 ? (
        <span className="px-1.5 py-0.5 text-2xs font-bold rounded-full bg-accent text-accent-ink shadow-xs">
          {counts.open}
        </span>
      ) : undefined,
    },
    {
      view: 'handovers',
      label: 'Handovers',
      Icon: Hand,
      badge: counts.handovers ? (
        <span
          className="px-1.5 py-0.5 text-2xs font-bold rounded-full bg-accent text-accent-ink shadow-xs"
          aria-label={`${counts.handovers} waiting for a person`}
        >
          {counts.handovers > 99 ? '99+' : counts.handovers}
        </span>
      ) : undefined,
    },
    { view: 'tickets', label: 'Tickets', Icon: Ticket },
    {
      view: 'team',
      label: 'Team chat',
      Icon: MessagesSquare,
      badge:
        counts.teamUnread ? (
          <span
            className={cn(
              'px-1.5 py-0.5 text-2xs font-bold rounded-full shadow-xs',
              counts.teamUrgent ? 'bg-accent text-accent-ink' : 'bg-surface-3 text-ink-2'
            )}
          >
            {counts.teamUnread > 99 ? '99+' : counts.teamUnread}
          </span>
        ) : undefined,
    },
    {
      view: 'visitors',
      label: 'Live visitors',
      Icon: Radio,
      badge:
        counts.liveVisitors > 0 ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs bg-success/10 text-success font-bold border border-success/20">
            <span className="live-dot" />
            {counts.liveVisitors}
          </span>
        ) : undefined,
    },
    ...(isAdmin
      ? [{ view: 'reports' as View, label: 'Analytics', Icon: BarChart2 }]
      : []),
    {
      view: 'helpdesk',
      label: 'Help Desk',
      Icon: BookOpen,
      badge:
        counts.articles !== undefined && counts.articles > 0 ? (
          <span className="px-1.5 py-0.5 text-2xs font-medium rounded-full bg-surface-3 text-ink-2">
            {counts.articles}
          </span>
        ) : undefined,
    },
    {
      view: 'unanswered',
      label: 'Unanswered',
      Icon: HelpCircle,
      badge:
        counts.unanswered !== undefined && counts.unanswered > 0 ? (
          <span className="px-1.5 py-0.5 text-2xs font-bold rounded-full bg-amber-500 text-white shadow-xs">
            {counts.unanswered}
          </span>
        ) : undefined,
    },
    { view: 'settings', label: 'Settings', Icon: Settings },
  ];

  return (
    <aside className="glass w-[220px] shrink-0 h-screen flex flex-col border-r select-none relative z-10 overflow-hidden">
      {/* Workspace Identity Card */}
      <div className="p-3 border-b border-line/80">
        <div className="flex items-center justify-between gap-2.5 p-2 rounded-xl bg-surface-2/80 hover:bg-surface-2 transition-all border border-line/60">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Avatar
              name={workspace?.name || 'Z'}
              seed={workspace?.id || 'zen-try'}
              color={workspace?.brand_color || undefined}
              size="sm"
              className="shadow-xs ring-1 ring-black/5"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-ui font-bold text-ink truncate leading-tight">
                  {workspace?.name || 'Zen-try'}
                </span>
                {hasVisitors && (
                  <span className="text-2xs font-bold px-1.5 py-0.5 rounded bg-success/15 text-success border border-success/30 uppercase tracking-wider">
                    Live
                  </span>
                )}
              </div>
              <div className="text-2xs text-ink-3 truncate flex items-center gap-1 mt-0.5">
                <span className="truncate">{workspace?.website_url ? workspace.website_url.replace(/^https?:\/\//, '').replace(/\/+$/, '') : 'Workspace Active'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation List */}
      <nav className="p-3 flex-1 overflow-y-auto space-y-1" aria-label="Main">
        <button
          type="button"
          onClick={openCommandPalette}
          className="w-full h-9 mb-2 px-2.5 rounded-lg flex items-center gap-2.5 text-ui text-ink-3 bg-surface border border-line hover:border-line-3 hover:text-ink transition-colors"
        >
          <Search className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="kbd">Ctrl K</kbd>
        </button>
        <div className="px-2 py-1 text-2xs font-bold tracking-wider uppercase text-ink-3">
          Menu
        </div>
        {nav.map(({ view, label, Icon, badge }) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              onClick={() => onSelectView(view)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'w-full h-9 px-2.5 rounded-lg flex items-center justify-between gap-2 text-ui font-medium transition-all duration-150 relative group',
                active
                  ? 'bg-accent-soft text-accent font-semibold'
                  : 'text-ink-2 hover:bg-surface-3/70 hover:text-ink'
              )}
            >
              {active && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full bg-accent" />
              )}
              <span className="flex items-center gap-2.5 truncate">
                <Icon
                  className={cn(
                    'w-4 h-4 shrink-0',
                    active ? 'text-accent' : 'text-ink-3 group-hover:text-ink'
                  )}
                />
                {label}
              </span>
              {badge !== undefined && (
                <span className="shrink-0">{badge}</span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer: Quick controls + Agent Profile */}
      <div className="p-3 border-t border-line/80 space-y-2.5">
        {/* 4 Bottom Icon Buttons with Clear Tooltips */}
        <div className="flex items-center justify-between px-1.5 py-0.5 rounded-lg bg-surface-2/60 border border-line/50">
          <button
            onClick={toggleSound}
            title={soundActive ? 'Sound Alerts: Enabled (click to mute)' : 'Sound Alerts: Muted (click to unmute)'}
            aria-label={soundActive ? 'Mute audio notifications' : 'Unmute audio notifications'}
            className={cn(
              'w-7 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer',
              soundActive
                ? 'text-accent hover:bg-accent/10'
                : 'text-ink-3 hover:text-ink hover:bg-surface-3 opacity-60'
            )}
          >
            {soundActive ? (
              <Volume2 className="w-3.5 h-3.5" />
            ) : (
              <VolumeX className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={enableNotifications}
            title="Browser Push Notifications: Click to grant permission"
            aria-label="Browser push notifications"
            className="w-7 h-7 rounded-md flex items-center justify-center text-ink-3 hover:text-accent hover:bg-accent/10 transition-colors cursor-pointer"
          >
            <Bell className="w-3.5 h-3.5" />
          </button>
          {onOpenShortcuts && (
            <button
              onClick={onOpenShortcuts}
              title="Keyboard Shortcuts Cheat Sheet (Press ?)"
              aria-label="Keyboard Shortcuts"
              className="w-7 h-7 rounded-md flex items-center justify-center text-ink-3 hover:text-accent hover:bg-accent/10 transition-colors text-xs font-mono font-bold cursor-pointer"
            >
              ?
            </button>
          )}
          {onOpenMobileInstall && (
            <button
              onClick={onOpenMobileInstall}
              title="Install Mobile PWA / Add to Home Screen"
              aria-label="Install Mobile PWA / Add to Home Screen"
              className="w-7 h-7 rounded-md flex items-center justify-center text-ink-3 hover:text-accent hover:bg-accent/10 transition-colors cursor-pointer"
            >
              <Smartphone className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Agent Profile & Status Card (Agent's own name & role, with Theme toggle in popover) */}
        {(() => {
          const agentDisplayName = (() => {
            if (currentAgent?.name && currentAgent.name !== workspace?.name) {
              return currentAgent.name;
            }
            if (currentAgent?.email) {
              const namePart = currentAgent.email.split('@')[0];
              return namePart.charAt(0).toUpperCase() + namePart.slice(1);
            }
            return 'Support Agent';
          })();

          const agentRoleLabel = (() => {
            if (currentAgent?.role === 'owner') return 'Owner';
            if (currentAgent?.role === 'admin') return 'Admin';
            return 'Support Agent';
          })();

          return (
            <Menu<AgentStatus | 'logout'>
              value={(currentAgent?.status || 'online') as AgentStatus}
              side="top"
              align="start"
              label="Agent status"
              menuClassName="left-0 right-0 min-w-0"
              options={[
                { value: 'online', label: 'Online', dot: STATUS_TINT.online, description: 'Receiving live chats' },
                { value: 'away', label: 'Away', dot: STATUS_TINT.away, description: 'Paused assignments' },
                { value: 'offline', label: 'Offline', dot: STATUS_TINT.offline, description: 'Hidden from visitors' },
                { value: 'logout', label: 'Log out', danger: true },
              ]}
              footer={
                <div className="pt-2 mt-1.5 border-t border-line px-2 pb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-3">Appearance</span>
                  <ThemeToggle className="scale-90 origin-right" />
                </div>
              }
              onChange={(v) => {
                if (v === 'logout') onLogout();
                else onUpdateAgentStatus(v as AgentStatus);
              }}
              trigger={({ open }) => (
                <span
                  className={cn(
                    'flex items-center gap-2.5 w-full p-2 rounded-xl border transition-all cursor-pointer shadow-xs',
                    open
                      ? 'bg-surface border-line-2 ring-2 ring-accent/15'
                      : 'bg-surface border-line hover:border-line-2 hover:bg-surface-2/60'
                  )}
                  title={`${agentDisplayName} (${agentRoleLabel}) — Click to change status or theme`}
                >
                  <Avatar
                    name={agentDisplayName}
                    seed={currentAgent?.id || 'agent'}
                    size="sm"
                    online={currentAgent?.status === 'online'}
                    className="shrink-0"
                  />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block text-xs font-bold text-ink truncate leading-tight">
                      {agentDisplayName}
                    </span>
                    <span className="flex items-center gap-1.5 text-2xs text-ink-3 mt-0.5">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{
                          background: STATUS_TINT[currentAgent?.status || 'online'],
                        }}
                      />
                      <span className="capitalize">{currentAgent?.status || 'online'}</span>
                      <span className="text-ink-3/40">·</span>
                      <span className="text-2xs font-semibold text-ink-2 bg-surface-3 px-1.5 py-0.2 rounded border border-line/60">
                        {agentRoleLabel}
                      </span>
                    </span>
                  </span>
                  <ChevronsUpDown className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                </span>
              )}
            />
          );
        })()}
      </div>
    </aside>
  );
}
