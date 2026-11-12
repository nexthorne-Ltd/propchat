'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BookOpen,
  Bot,
  Building2,
  CreditCard,
  KeyRound,
  Menu,
  Palette,
  Search,
  Share2,
  ShieldCheck,
  Ticket,
  Users,
  X,
  Zap,
} from 'lucide-react';
import type { Agent, CannedResponse, Workspace } from '@/types/database';
import { cn } from '@/lib/utils';
import { isRole, type Role } from '@/lib/team/permissions';
import {
  resolveTarget,
  searchSettings,
  settingsPages,
  visibleSections,
  type SettingsSection,
  type SettingsTab,
} from '@/lib/settings/registry';
import { AdminSettingsPanel, type AdminTab } from '@/components/admin/AdminSettingsPanel';
import { InstallationGuide } from '@/components/dashboard/InstallationGuide';
import { MobileAppSettingsCard } from '@/components/dashboard/MobileAppSettingsCard';
import { IntegrationsSettings } from '@/components/dashboard/IntegrationsSettings';
import { SMTPSettingsSection } from '@/components/admin/SMTPSettingsSection';
import { ChannelsSettings } from '@/components/channels/ChannelsSettings';
import { TeamSettings } from '@/components/team/TeamSettings';
import { GroupsSettings } from '@/components/team/GroupsSettings';
import { Button } from '@/components/ui/Button';
import { Drawer, Modal } from '@/components/ui/Modal';
import { Tabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { AutomationPage } from '@/components/automation/AutomationPage';
import { SlaPage } from '@/components/sla/SlaPage';
import { AuditLogPanel, SessionsPanel, TwoFactorPanel } from './SecurityPanels';
import { NotificationPreferences } from './NotificationPreferences';
import { WorkspaceGeneral } from './WorkspaceGeneral';
import { AutoCloseCard, LinkCard, PlanPanel, RolesMatrix } from './SmallPages';
import { ComingSoon, DirtyProvider } from './parts';
import { CsatSettingsCard } from './CsatSettingsCard';
import { KnowledgeIndexCard } from './KnowledgeIndexCard';
import { TagsSettings } from './TagsSettings';
import { PrechatSettings } from './PrechatSettings';
import { TicketFieldsSettings } from './TicketFieldsSettings';
import { WebhooksSettings } from './WebhooksSettings';
import { ApiKeysPanel } from './ApiKeysPanel';
import { LangGraphSettings } from './LangGraphSettings';
import { BotLearningSettings } from './BotLearningSettings';
import { BotHealthCheck } from './BotHealthCheck';
import { SubAgentsSettings } from './SubAgentsSettings';
import { TraderDataSettings } from './TraderDataSettings';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  building: Building2,
  users: Users,
  share: Share2,
  palette: Palette,
  ticket: Ticket,
  zap: Zap,
  bot: Bot,
  book: BookOpen,
  bell: Bell,
  shield: ShieldCheck,
  card: CreditCard,
  key: KeyRound,
};

export interface SettingsHubProps {
  workspace: Workspace | null;
  currentAgent: Agent | null;
  agents: Agent[];
  cannedResponses: CannedResponse[];
  hasVisitors?: boolean;
  latestVisitorUrl?: string;
  /** "section", "section:tab" or an older section id (see lib/settings/registry). */
  initialSection?: string;
  /** Bumped by the command palette so picking the same page again still jumps there. */
  sectionNonce?: number;
  onWorkspaceUpdated?: (ws: Workspace) => void;
  /** Lets a page link to another dashboard screen, e.g. 'tickets' or 'helpdesk'. */
  onNavigate?: (view: string) => void;
}

/** Pages the command palette lists, for a role. */
export function settingsSections(isAdmin: boolean) {
  return settingsPages(isAdmin ? 'admin' : 'agent');
}

export function SettingsHub({
  workspace,
  currentAgent,
  agents,
  cannedResponses,
  hasVisitors = false,
  latestVisitorUrl,
  initialSection,
  sectionNonce,
  onWorkspaceUpdated,
  onNavigate,
}: SettingsHubProps) {
  const role: Role | null = isRole(currentAgent?.role) ? (currentAgent!.role as Role) : null;
  const sections = useMemo(() => visibleSections(role), [role]);

  const [loc, setLoc] = useState(() => resolveTarget(initialSection, role));
  const [query, setQuery] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const go = useCallback(
    (target: string, force = false) => {
      if (dirtyRef.current && !force) return setPending(target);
      setLoc(resolveTarget(target, role));
      setDirty(false);
      setPending(null);
      setNavOpen(false);
      setQuery('');
      mainRef.current?.scrollTo({ top: 0 });
    },
    [role]
  );

  // The command palette, the setup checklist and the Instagram login return
  // here with a target; the nonce makes the same target work twice.
  useEffect(() => {
    if (initialSection) go(initialSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSection, sectionNonce]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const results = useMemo(() => searchSettings(query, role), [query, role]);

  const section = sections.find((s) => s.id === loc?.section);
  const tab = section?.tabs.find((t) => t.id === loc?.tab);

  const nav = (
    <SettingsNav
      sections={sections}
      activeSection={loc?.section}
      query={query}
      onQuery={setQuery}
      results={results}
      onGo={go}
    />
  );

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col bg-canvas text-ink overflow-hidden">
      <header className="shrink-0 px-4 md:px-8 h-14 flex items-center gap-3 border-b border-line bg-surface">
        <Button iconOnly variant="ghost" size="sm" className="md:hidden" aria-label="Open settings menu" onClick={() => setNavOpen(true)}>
          <Menu className="w-4 h-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-md font-semibold text-ink truncate">Settings</h1>
          <p className="text-2xs text-ink-3 truncate">{workspace?.name}</p>
        </div>
        <ThemeToggle className="shrink-0" />
      </header>

      <div className="flex-1 flex min-h-0">
        <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-line bg-surface min-h-0">{nav}</aside>

        <main ref={mainRef} className="flex-1 min-w-0 overflow-y-auto">
          {!workspace || !currentAgent || !section || !tab ? (
            <div className="p-8">
              <EmptyState type="custom" title="No settings available" description="Your role does not have access to workspace settings. Ask an owner or admin if you need something changed." />
            </div>
          ) : (
            <div className="px-4 md:px-8 py-6 max-w-5xl mx-auto w-full space-y-6">
              <div>
                <p className="eyebrow">{section.group}</p>
                <h2 className="text-xl font-semibold text-ink mt-1">{section.label}</h2>
                <p className="text-sm text-ink-2 mt-1">{section.description}</p>
              </div>

              {section.tabs.length > 1 && (
                <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
                  <Tabs
                    label={`${section.label} pages`}
                    items={section.tabs.map((t) => ({ id: t.id, label: t.label }))}
                    value={tab.id}
                    onChange={(id) => go(`${section.id}:${id}`)}
                  />
                </div>
              )}

              <div>
                <h3 className="text-md font-semibold text-ink">{tab.label}</h3>
                <p className="text-ui text-ink-2 mt-0.5 mb-5">{tab.description}</p>
                <DirtyProvider value={setDirty}>
                  <div key={`${section.id}:${tab.id}`}>
                    <Page
                      section={section}
                      tab={tab}
                      workspace={workspace}
                      currentAgent={currentAgent}
                      agents={agents}
                      cannedResponses={cannedResponses}
                      hasVisitors={hasVisitors}
                      latestVisitorUrl={latestVisitorUrl}
                      onWorkspaceUpdated={onWorkspaceUpdated}
                      onNavigate={onNavigate}
                      onDirty={setDirty}
                    />
                  </div>
                </DirtyProvider>
              </div>
            </div>
          )}
        </main>
      </div>

      {navOpen && (
        <Drawer title="Settings" onClose={() => setNavOpen(false)} width="max-w-xs">
          <div className="-m-4 h-full flex flex-col">{nav}</div>
        </Drawer>
      )}

      {pending && (
        <Modal
          title="Discard unsaved changes?"
          description="You have edits on this page that are not saved."
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)}>
                Keep editing
              </Button>
              <Button variant="danger" onClick={() => go(pending, true)}>
                Discard changes
              </Button>
            </>
          }
        >
          <p className="text-ui text-ink-2">If you leave now, those edits are lost.</p>
        </Modal>
      )}
    </div>
  );
}

function SettingsNav({
  sections,
  activeSection,
  query,
  onQuery,
  results,
  onGo,
}: {
  sections: SettingsSection[];
  activeSection?: string;
  query: string;
  onQuery: (q: string) => void;
  results: ReturnType<typeof searchSettings>;
  onGo: (target: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, SettingsSection[]>();
    for (const s of sections) map.set(s.group, [...(map.get(s.group) ?? []), s]);
    return Array.from(map.entries());
  }, [sections]);
  const searching = query.trim().length > 0;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="p-3 border-b border-line">
        <div className="relative">
          <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
          <input
            type="search"
            className="input input-sm pl-9 pr-8"
            placeholder="Search settings…"
            aria-label="Search settings"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          {searching && (
            <button type="button" aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink p-1" onClick={() => onQuery('')}>
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <nav aria-label="Settings" className="flex-1 overflow-y-auto p-3 space-y-5">
        {searching ? (
          results.length === 0 ? (
            <div className="px-2 py-1 space-y-2 text-ui text-ink-2" role="status">
              <p>No settings match “{query}”.</p>
              <p className="text-xs text-ink-3 leading-relaxed">
                Looking for team accounts or email? Check{' '}
                <button
                  type="button"
                  onClick={() => onGo('team:members')}
                  className="text-accent underline font-medium hover:text-accent/80"
                >
                  Team Members
                </button>{' '}
                or your agent profile at the bottom left.
              </p>
            </div>
          ) : (
            <ul className="space-y-1" aria-label="Search results">
              {results.map(({ section, tab }) => {
                const Icon = ICONS[section.icon] ?? Building2;
                return (
                  <li key={`${section.id}:${tab.id}`}>
                    <button type="button" className="w-full text-left flex items-start gap-2.5 px-2.5 py-2 rounded-sm hover:bg-surface-3" onClick={() => onGo(`${section.id}:${tab.id}`)}>
                      <Icon className="w-4 h-4 mt-0.5 text-ink-3 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-ui text-ink font-medium truncate">{section.tabs.length > 1 ? `${section.label}: ${tab.label}` : section.label}</span>
                        <span className="block text-xs text-ink-3 line-clamp-2">{tab.description}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          groups.map(([group, items]) => (
            <div key={group}>
              <p className="eyebrow px-2 mb-1.5">{group}</p>
              <ul className="space-y-0.5">
                {items.map((s) => {
                  const Icon = ICONS[s.icon] ?? Building2;
                  const active = s.id === activeSection;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        onClick={() => onGo(s.id)}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 min-h-10 md:min-h-9 rounded-sm text-ui text-left',
                          active ? 'bg-accent-soft text-accent font-semibold' : 'text-ink-2 hover:bg-surface-3 hover:text-ink font-medium'
                        )}
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        <span className="truncate">{s.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </nav>
    </div>
  );
}

function Page({
  section,
  tab,
  workspace,
  currentAgent,
  agents,
  cannedResponses,
  hasVisitors,
  latestVisitorUrl,
  onWorkspaceUpdated,
  onNavigate,
  onDirty,
}: {
  section: SettingsSection;
  tab: SettingsTab;
  workspace: Workspace;
  currentAgent: Agent;
  agents: Agent[];
  cannedResponses: CannedResponse[];
  hasVisitors: boolean;
  latestVisitorUrl?: string;
  onWorkspaceUpdated?: (ws: Workspace) => void;
  onNavigate?: (view: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const admin = (adminTab: AdminTab) => (
    <AdminSettingsPanel
      embedded
      tab={adminTab}
      workspace={workspace}
      currentAgent={currentAgent}
      initialAgents={agents}
      initialCannedResponses={cannedResponses}
      onWorkspaceUpdated={onWorkspaceUpdated}
      onDirtyChange={onDirty}
    />
  );

  if (tab.status === 'soon') return <ComingSoon title={tab.label} description={tab.description} />;

  switch (`${section.id}:${tab.id}`) {
    case 'workspace:general':
      return <WorkspaceGeneral workspace={workspace} onWorkspaceUpdated={onWorkspaceUpdated} />;
    case 'workspace:hours':
      return admin('hours');

    case 'team:members':
      return <TeamSettings workspaceId={workspace.id} />;
    case 'team:roles':
      return <RolesMatrix />;
    case 'team:groups':
      return <GroupsSettings workspaceId={workspace.id} />;

    case 'channels:website':
      return <InstallationGuide embedded workspace={workspace} hasVisitors={hasVisitors} latestVisitorUrl={latestVisitorUrl} />;
    case 'channels:email':
      return <SMTPSettingsSection workspace={workspace} onWorkspaceUpdated={onWorkspaceUpdated} />;
    case 'channels:social':
      return (
        <div className="space-y-8">
          <ChannelsSettings workspaceId={workspace.id} />
          {(['meta', 'slack'] as const).map((t) => (
            <IntegrationsSettings key={t} embedded tab={t} workspace={workspace} />
          ))}
        </div>
      );
    case 'channels:mobile':
      return <MobileAppSettingsCard />;

    case 'widget:appearance':
      return admin('widget');
    case 'widget:prechat':
      return <PrechatSettings workspace={workspace} onWorkspaceUpdated={onWorkspaceUpdated} />;

    case 'tickets:views':
      return <LinkCard title="Saved views" description="Create, edit and share views from the Tickets screen, where you can see the filters working on real tickets." actionLabel="Open tickets" onClick={() => onNavigate?.('tickets')} />;
    case 'tickets:csat':
      return <CsatSettingsCard workspace={workspace} onWorkspaceUpdated={onWorkspaceUpdated} />;
    case 'tickets:fields':
      return <TicketFieldsSettings workspaceId={workspace.id} />;
    case 'tickets:tags':
      return <TagsSettings workspaceId={workspace.id} />;

    case 'automation:replies':
      return admin('canned');
    case 'automation:assignment':
      return (
        <div className="space-y-10">
          {admin('assignment')}
          <AutoCloseCard workspace={workspace} onWorkspaceUpdated={onWorkspaceUpdated} />
        </div>
      );
    case 'automation:sla':
    case 'automation:sla-calendar':
      return <SlaPage workspaceId={workspace.id} tab={tab.id === 'sla' ? 'policies' : 'calendar'} />;
    case 'automation:macros':
    case 'automation:triggers':
    case 'automation:automations':
    case 'automation:log':
      return <AutomationPage workspaceId={workspace.id} tab={tab.id as 'macros' | 'triggers' | 'automations' | 'log'} onNavigate={onNavigate} />;

    case 'ai:assistant':
      return admin('ai');
    case 'ai:knowledge':
      return (
        <div className="space-y-6">
          <LinkCard title="Help desk articles and bot knowledge" description="The bot answers from published articles and from Help Center → Bot knowledge (information you do not want to publish). Add or edit them in the Help Desk, where unanswered questions also show what is missing." actionLabel="Open help desk" onClick={() => onNavigate?.('helpdesk')} />
          <KnowledgeIndexCard workspaceId={workspace.id} />
        </div>
      );
    case 'ai:sub-agents':
      return <SubAgentsSettings workspaceId={workspace.id} />;
    case 'ai:trader-data':
      return <TraderDataSettings workspaceId={workspace.id} />;
    case 'ai:learning':
      return <BotLearningSettings workspaceId={workspace.id} />;
    case 'ai:advanced':
      return <LangGraphSettings workspaceId={workspace.id} />;
    case 'ai:health':
      return <BotHealthCheck workspaceId={workspace.id} />;

    case 'helpcenter:branding':
      return admin('helpcenter');
    case 'helpcenter:domain':
      return admin('domain');

    case 'notifications:preferences':
      return <NotificationPreferences workspaceId={workspace.id} />;

    case 'security:sessions':
      return <SessionsPanel />;
    case 'security:twofactor':
      return <TwoFactorPanel />;
    case 'security:audit':
      return <AuditLogPanel workspaceId={workspace.id} />;

    case 'billing:plan':
      return <PlanPanel workspace={workspace} agents={agents} />;

    case 'api:keys':
      return <ApiKeysPanel workspaceId={workspace.id} />;
    case 'api:webhooks':
      return <WebhooksSettings workspaceId={workspace.id} />;

    default:
      return <ComingSoon title="Not available yet" description={tab.description} />;
  }
}

