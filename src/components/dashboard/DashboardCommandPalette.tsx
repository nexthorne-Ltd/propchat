'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart2, BookOpen, Inbox, Keyboard, ListFilter, Radio, Settings, Ticket } from 'lucide-react';
import { CommandPalette } from '@/components/ui/CommandPalette';
import { isPaletteShortcut, type PaletteItem } from '@/lib/command-palette';
import { SYSTEM_VIEWS } from '@/lib/tickets/views';
import { searchTicketsAction } from '@/app/actions/tickets';
import { createClient } from '@/lib/supabase/client';
import { settingsSections, type SectionId } from './SettingsHub';
import type { View } from './Sidebar';

/** Fired by the sidebar's search button (and anything else) to open the palette. */
export const OPEN_PALETTE_EVENT = 'zentry:open-command-palette';

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
}

const NAV: { view: View; title: string; keywords: string[]; adminOnly?: boolean }[] = [
  { view: 'inbox', title: 'Inbox', keywords: ['conversations', 'chats', 'messages'] },
  { view: 'tickets', title: 'Tickets', keywords: ['queue', 'cases'] },
  { view: 'visitors', title: 'Live visitors', keywords: ['radar', 'online'] },
  { view: 'reports', title: 'Analytics', keywords: ['reports', 'stats', 'csat'], adminOnly: true },
  { view: 'helpdesk', title: 'Help Desk', keywords: ['articles', 'help center', 'knowledge base'] },
  { view: 'settings', title: 'Settings', keywords: ['preferences', 'configuration'] },
];

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'nav:inbox': Inbox,
  'nav:tickets': Ticket,
  'nav:visitors': Radio,
  'nav:reports': BarChart2,
  'nav:helpdesk': BookOpen,
  'nav:settings': Settings,
  'action:shortcuts': Keyboard,
  Tickets: Ticket,
  'Ticket views': ListFilter,
  Settings: Settings,
};

/**
 * The dashboard's Ctrl/Cmd+K palette: jump to any screen, ticket view,
 * settings section, or (by number, subject or requester) a ticket.
 */
export function DashboardCommandPalette({
  workspaceId,
  isAdmin,
  onNavigate,
  onOpenTicketView,
  onOpenTicket,
  onOpenSettings,
  onShowShortcuts,
}: {
  workspaceId: string;
  isAdmin: boolean;
  onNavigate: (view: View) => void;
  onOpenTicketView: (viewId: string) => void;
  onOpenTicket: (ticketId: string) => void;
  onOpenSettings: (section: SectionId) => void;
  onShowShortcuts: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [savedViews, setSavedViews] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An editor that already used Ctrl+K (insert link) wins.
      if (e.defaultPrevented || !isPaletteShortcut(e)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  // Saved views change rarely; refresh them each time the palette opens.
  useEffect(() => {
    if (!open) return;
    createClient()
      .from('ticket_views')
      .select('id, name')
      .eq('workspace_id', workspaceId)
      .order('position')
      .then(({ data, error }: { data: { id: string; name: string }[] | null; error: { message: string } | null }) => {
        if (error) console.error('[Command Palette] saved views:', error.message);
        else setSavedViews(data || []);
      });
  }, [open, workspaceId]);

  const items = useMemo<PaletteItem[]>(
    () => [
      ...NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => ({
        id: `nav:${n.view}`,
        group: 'Navigate' as const,
        title: n.title,
        keywords: n.keywords,
      })),
      ...[...SYSTEM_VIEWS, ...savedViews].map((v) => ({
        id: `view:${v.id}`,
        group: 'Ticket views' as const,
        title: v.name,
        subtitle: 'system' in v ? 'Ticket view' : 'Saved view',
      })),
      ...settingsSections(isAdmin).map((s) => ({
        id: `settings:${s.id}`,
        group: 'Settings' as const,
        title: s.label,
        subtitle: s.group,
        keywords: [...s.keywords, s.description],
      })),
      { id: 'action:shortcuts', group: 'Actions' as const, title: 'Keyboard shortcuts', shortcut: ['?'] },
    ],
    [isAdmin, savedViews]
  );

  const search = useCallback(
    async (q: string): Promise<PaletteItem[]> => {
      const { tickets } = await searchTicketsAction(workspaceId, q);
      return tickets.slice(0, 8).map((t) => ({
        id: `ticket:${t.id}`,
        group: 'Tickets' as const,
        title: `#${t.number} ${t.subject}`,
        subtitle: t.requester?.name || t.requester?.email || undefined,
        // The server already matched these; keep them visible whatever the local ranking says.
        keywords: [q],
      }));
    },
    [workspaceId]
  );

  const onSelect = (item: PaletteItem) => {
    const [kind, ...rest] = item.id.split(':');
    const value = rest.join(':');
    if (kind === 'nav') onNavigate(value as View);
    else if (kind === 'view') onOpenTicketView(value);
    else if (kind === 'ticket') onOpenTicket(value);
    else if (kind === 'settings') onOpenSettings(value as SectionId);
    else if (item.id === 'action:shortcuts') onShowShortcuts();
  };

  return <CommandPalette open={open} onClose={() => setOpen(false)} items={items} onSelect={onSelect} search={search} icons={ICONS} />;
}
