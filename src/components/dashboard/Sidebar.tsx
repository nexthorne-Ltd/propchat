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

/* One shape for every count badge. Accent marks unread work, warn marks
   people waiting on a person, neutral is just a total. */
const COUNT_BASE =
  'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-2xs font-bold tabular-nums';
const COUNT = {
  accent: cn(COUNT_BASE, 'bg-accent text-accent-ink'),
  warn: cn(COUNT_BASE, 'bg-warn-soft text-warn border border-warn-line'),
  neutral: cn(COUNT_BASE, 'bg-surface-3 text-ink-2'),
};

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
        <span className={COUNT.accent}>
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
          className={COUNT.warn}
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
            className={counts.teamUrgent ? COUNT.accent : COUNT.neutral}
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
          <span className="pill pill-success" aria-label={`${counts.liveVisitors} visitors on your site now`}>
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
      label: 'Help desk',
      Icon: BookOpen,
      badge:
        counts.articles !== undefined && counts.articles > 0 ? (
          <span className={COUNT.neutral}>
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
          <span className={COUNT.neutral} aria-label={`${counts.unanswered} questions the bot could not answer`}>
            {counts.unanswered}
          </span>
        ) : undefined,
    },
    { view: 'settings', label: 'Settings', Icon: Settings },
  ];

  return (
    <aside className="glass w-[220px] shrink-0 h-screen flex flex-col border-r select-none relative z-10 overflow-hidden">
      {/* Workspace Identity Card */}
      <div className="px-3 py-3 border-b border-line">
        <div className="flex items-center justify-between gap-2.5 px-1">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Avatar
              name={workspace?.name || 'Z'}
              seed={workspace?.id || 'zen-try'}
              color={workspace?.brand_color || undefined}
              size="sm"
              className="shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-ui font-bold text-ink truncate leading-tight">
                  {workspace?.name || 'Zen-try'}
                </span>
                {hasVisitors && (
                  <span className="pill pill-success" title="The widget is live on your site">
                    Live
                  </span>
                )}
              </div>
              <div className="text-2xs text-ink-3 truncate flex items-center gap-1 mt-0.5">
                <span className="truncate">{workspace?.website_url ? workspace.website_url.replace(/^https?:\/\//, '').replace(/\/+$/, '') : 'Workspace'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation List */}
      <nav className="p-3 flex-1 overflow-y-auto space-y-0.5" aria-label="Main">
        <button
          type="button"
          onClick={openCommandPalette}
          className="w-full h-9 mb-2 px-2.5 rounded-lg flex items-center gap-2.5 text-ui text-ink-3 bg-surface border border-line hover:border-line-3 hover:text-ink transition-colors"
        >
          <Search className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="kbd">Ctrl K</kbd>
        </button>
        <div className="eyebrow px-2 pt-1 pb-1.5">Menu</div>
        {nav.map(({ view, label, Icon, badge }) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              onClick={() => onSelectView(view)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'w-full h-9 px-2.5 rounded-sm flex items-center justify-between gap-2 text-ui font-medium transition-colors duration-150 group',
                active
                  ? 'bg-accent-soft text-accent font-semibold'
                  : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
              )}
            >
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
      <div className="p-3 border-t border-line space-y-2">
        <div className="flex items-center justify-between px-1">
          <button
            onClick={toggleSound}
            title={soundActive ? 'Sound alerts on' : 'Sound alerts off'}
            aria-label={soundActive ? 'Mute sound alerts' : 'Turn on sound alerts'}
            aria-pressed={soundActive}
            className={cn('btn btn-ghost btn-xs btn-icon', soundActive && 'text-accent')}
          >
            {soundActive ? (
              <Volume2 className="w-3.5 h-3.5" />
            ) : (
              <VolumeX className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={enableNotifications}
            title="Turn on browser notifications"
            aria-label="Turn on browser notifications"
            className="btn btn-ghost btn-xs btn-icon"
          >
            <Bell className="w-3.5 h-3.5" />
          </button>
          {onOpenShortcuts && (
            <button
              onClick={onOpenShortcuts}
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
              className="btn btn-ghost btn-xs btn-icon font-mono"
            >
              ?
            </button>
          )}
          {onOpenMobileInstall && (
            <button
              onClick={onOpenMobileInstall}
              title="Add Zentry to your phone"
              aria-label="Add Zentry to your phone"
              className="btn btn-ghost btn-xs btn-icon"
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
                    'flex items-center gap-2.5 w-full p-2 rounded-md border transition-colors cursor-pointer',
                    open
                      ? 'bg-surface-2 border-line-2'
                      : 'bg-surface border-line hover:border-line-2 hover:bg-surface-2'
                  )}
                  title={`${agentDisplayName} (${agentRoleLabel}): change status or theme`}
                >
                  <Avatar
                    name={agentDisplayName}
                    seed={currentAgent?.id || 'agent'}
                    size="sm"
                    online={currentAgent?.status === 'online'}
                    className="shrink-0"
                  />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block text-xs font-semibold text-ink truncate leading-tight">
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
                      <span aria-hidden="true">·</span>
                      <span>{agentRoleLabel}</span>
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
