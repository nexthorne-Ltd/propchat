'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Clock,
  ExternalLink,
  Globe,
  MapPin,
  MessageSquare,
  Monitor,
  Radio,
  RefreshCw,
  Smartphone,
  Users,
  LayoutList,
  LayoutGrid,
  History,
  Ticket as TicketIcon,
  X,
  Compass,
} from 'lucide-react';
import { Visitor, Workspace, VisitorPageHistory } from '@/types/database';
import { formatTimeAgo, cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/Avatar';
import {
  BrowserIcon,
  CountryFlag,
  DeviceIcon,
  OsIcon,
} from '@/components/ui/BrandIcon';
import {
  localTimeIn,
  parseLocation,
  parseUserAgentDetailed,
  timezoneFrom,
} from '@/lib/visitor-meta';
import { EmptyState } from '@/components/ui/EmptyState';
import { createClient } from '@/lib/supabase/client';
import {
  isVisitorOnline,
  formatTimeOnPage,
  calculateTimeOnPage,
  formatPageDisplay,
  ONLINE_PRESENCE_WINDOW_SECONDS,
} from '@/lib/tracking/visitor-tracking';

interface LiveVisitorsRadarProps {
  visitors: Visitor[];
  workspace?: Workspace | null;
  onOpenConversationForVisitor: (visitorId: string) => void;
  onOpenTicket?: (ticketId: string) => void;
  onRefresh: () => void;
}

interface OpenTicketSummary {
  id: string;
  number: number;
  subject: string;
  status: string;
}

export function LiveVisitorsRadar({
  visitors,
  workspace,
  onOpenConversationForVisitor,
  onOpenTicket,
  onRefresh,
}: LiveVisitorsRadarProps) {
  const [viewMode, setViewMode] = useState<'rows' | 'grid'>('rows');
  const [now, setNow] = useState<number>(Date.now());
  const [pageHistoryMap, setPageHistoryMap] = useState<Record<string, VisitorPageHistory[]>>({});
  const [openTicketsMap, setOpenTicketsMap] = useState<Record<string, OpenTicketSummary[]>>({});
  const [expandedHistoryVisitorId, setExpandedHistoryVisitorId] = useState<string | null>(null);

  // Live presence ticker: updates every 3 seconds so time-on-page ticks
  // and visitors who exceed 90 seconds expire automatically without manual refresh.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const activeVisitors = useMemo(
    () => visitors.filter((v) => isVisitorOnline(v, now, ONLINE_PRESENCE_WINDOW_SECONDS)),
    [visitors, now]
  );

  const desktopCount = activeVisitors.filter(
    (v) => !/mobile|android|iphone|ipad/i.test(v.user_agent || '')
  ).length;
  const mobileCount = activeVisitors.length - desktopCount;

  // Real-time metadata loading: fetches page histories & open tickets for online visitors
  useEffect(() => {
    const wsId = workspace?.id;
    if (!wsId || activeVisitors.length === 0) {
      return;
    }

    const visitorIds = activeVisitors.map((v) => v.id);
    const supabase = createClient();
    let cancelled = false;

    async function loadMeta() {
      try {
        const [historyRes, ticketsRes] = await Promise.all([
          supabase
            .from('visitor_page_history')
            .select('*')
            .in('visitor_id', visitorIds)
            .order('visited_at', { ascending: false })
            .limit(100),
          supabase
            .from('tickets')
            .select('id, number, subject, status, requester_id')
            .eq('workspace_id', wsId)
            .in('status', ['new', 'open', 'pending', 'on_hold'])
            .in('requester_id', visitorIds),
        ]);

        if (cancelled) return;

        if (historyRes.data) {
          const hMap: Record<string, VisitorPageHistory[]> = {};
          for (const row of historyRes.data) {
            if (!hMap[row.visitor_id]) hMap[row.visitor_id] = [];
            hMap[row.visitor_id].push(row as VisitorPageHistory);
          }
          setPageHistoryMap(hMap);
        }

        if (ticketsRes.data) {
          const tMap: Record<string, OpenTicketSummary[]> = {};
          for (const row of ticketsRes.data) {
            if (!row.requester_id) continue;
            if (!tMap[row.requester_id]) tMap[row.requester_id] = [];
            tMap[row.requester_id].push({
              id: row.id,
              number: row.number,
              subject: row.subject,
              status: row.status,
            });
          }
          setOpenTicketsMap(tMap);
        }
      } catch (err) {
        console.error('Failed to load live visitor metadata:', err);
      }
    }

    loadMeta();

    // Subscribe to realtime updates for page history and tickets in this workspace
    const channel = supabase
      .channel(`radar-meta-${wsId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visitor_page_history' }, () => {
        loadMeta();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, () => {
        loadMeta();
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [workspace?.id, activeVisitors.map((v) => v.id).sort().join(',')]);

  const activeHistoryVisitor = activeVisitors.find((v) => v.id === expandedHistoryVisitorId);
  const activeHistoryItems = expandedHistoryVisitorId ? (pageHistoryMap[expandedHistoryVisitorId] || []) : [];
  const activeHistoryVisitorName = activeHistoryVisitor
    ? activeHistoryVisitor.name ||
      (activeHistoryVisitor.email
        ? activeHistoryVisitor.email.split('@')[0]
        : `Visitor ${activeHistoryVisitor.id.slice(0, 6)}`)
    : '';

  return (
    <div className="flex-1 min-w-0 h-screen flex flex-col bg-canvas">
      {/* Header */}
      <header className="shrink-0 px-7 h-16 flex items-center justify-between gap-4 border-b border-line bg-surface">
        <div className="min-w-0 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-success/10 border border-success/20 flex items-center justify-center text-success">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h1 className="text-md font-bold tracking-tight flex items-center gap-2.5 text-ink">
              Live Visitors Radar
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-bold bg-success/10 text-success border border-success/20">
                <span className="live-dot" />
                {activeVisitors.length} online now
              </span>
            </h1>
            <p className="text-xs text-ink-3">
              Realtime telemetry of visitors browsing your website right now.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {/* View Mode Toggle: Rows (default) vs Grid */}
          <div className="flex items-center p-0.5 rounded-lg bg-surface-2 border border-line">
            <button
              type="button"
              onClick={() => setViewMode('rows')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                viewMode === 'rows'
                  ? 'bg-surface text-ink font-semibold shadow-xs'
                  : 'text-ink-3 hover:text-ink'
              )}
              title="Compact Row View (Multiple visitors visible at once)"
            >
              <LayoutList className="w-3.5 h-3.5" />
              <span>Rows</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                viewMode === 'grid'
                  ? 'bg-surface text-ink font-semibold shadow-xs'
                  : 'text-ink-3 hover:text-ink'
              )}
              title="Card Grid View"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>Cards</span>
            </button>
          </div>

          <button
            onClick={onRefresh}
            className="btn btn-sm btn-secondary shrink-0 shadow-xs hover:border-line-2"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh Radar</span>
          </button>
        </div>
      </header>

      {/* Telemetry Metric Cards */}
      {activeVisitors.length > 0 && (
        <div className="px-7 py-4 border-b border-line/70 bg-surface/50 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="p-3 rounded-xl bg-surface border border-line/60 shadow-xs">
            <span className="text-2xs font-semibold text-ink-3 uppercase tracking-wider block mb-1">
              Active Visitors
            </span>
            <div className="text-xl font-bold text-ink tabular-nums flex items-baseline gap-1.5">
              {activeVisitors.length}
              <span className="text-2xs font-normal text-success">Live</span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-surface border border-line/60 shadow-xs">
            <span className="text-2xs font-semibold text-ink-3 uppercase tracking-wider block mb-1">
              Devices
            </span>
            <div className="text-ui font-bold text-ink flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Monitor className="w-3.5 h-3.5 text-ink-3" /> {desktopCount} Desktop
              </span>
              <span className="flex items-center gap-1">
                <Smartphone className="w-3.5 h-3.5 text-ink-3" /> {mobileCount} Mobile
              </span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-surface border border-line/60 shadow-xs col-span-2">
            <span className="text-2xs font-semibold text-ink-3 uppercase tracking-wider block mb-1">
              Top Active URL
            </span>
            <div className="text-xs font-mono text-accent truncate">
              {activeVisitors[0]?.current_page_url || activeVisitors[0]?.current_url || '/'}
            </div>
          </div>
        </div>
      )}

      {/* Grid or Rows of live visitors */}
      <div className="flex-1 overflow-y-auto p-7">
        {activeVisitors.length === 0 ? (
          <div className="h-full flex items-center justify-center p-8">
            <EmptyState
              type="no-visitors"
              title="Radar Scanning for Live Visitors"
              description="Nobody is browsing your site right now. As soon as someone visits, their page URL, page title, location, and device appear here live. If you have just installed the widget, open a test page to check it is reporting."
              actionLabel="Open a test page"
              onAction={() => {
                const targetUrl = workspace?.id
                  ? `/demo.html?workspaceId=${workspace.id}&name=${encodeURIComponent(workspace.name || '')}`
                  : '/demo.html';
                window.open(targetUrl, '_blank');
              }}
              secondaryActionLabel="Refresh Radar"
              onSecondaryAction={onRefresh}
            />
          </div>
        ) : viewMode === 'rows' ? (
          /* Compact Row-Wise Table View */
          <div className="rounded-2xl border border-line bg-surface overflow-hidden shadow-xs">
            {/* Table Header */}
            <div className="hidden lg:grid grid-cols-12 px-5 py-2.5 bg-surface-2/80 border-b border-line text-2xs font-bold text-ink-3 uppercase tracking-wider items-center gap-3">
              <div className="col-span-3">Visitor &amp; Tickets</div>
              <div className="col-span-4">Current Page &amp; Time</div>
              <div className="col-span-2">Session Pages</div>
              <div className="col-span-2">Location &amp; Device</div>
              <div className="col-span-1 text-right">Action</div>
            </div>

            {/* Compact Rows */}
            <div className="divide-y divide-line/60">
              {activeVisitors.map((visitor) => {
                const ua = parseUserAgentDetailed(visitor.user_agent);
                const place = parseLocation(
                  visitor.location,
                  visitor.ip_location_city,
                  visitor.ip_location_country
                );
                const localTime = localTimeIn(
                  visitor.timezone || timezoneFrom(visitor.location)
                );
                const displayName =
                  visitor.name ||
                  (visitor.email
                    ? visitor.email.split('@')[0]
                    : `Visitor ${visitor.id.slice(0, 6)}`);

                const rawUrl = visitor.current_page_url || visitor.current_url || '/';
                const pageDisplay = formatPageDisplay(rawUrl, visitor.current_page_title);
                const timeOnPageSeconds =
                  visitor.time_on_page_seconds ??
                  calculateTimeOnPage(visitor.current_page_entered_at, undefined, now);

                const visitorHistory = pageHistoryMap[visitor.id] || [];
                const historyCount = Math.max(1, visitorHistory.length);
                const openTickets = openTicketsMap[visitor.id] || [];

                return (
                  <div
                    key={visitor.id}
                    onClick={() => onOpenConversationForVisitor(visitor.id)}
                    className="grid grid-cols-1 lg:grid-cols-12 px-5 py-3 items-center gap-2.5 lg:gap-3 hover:bg-surface-2/70 transition-colors cursor-pointer group"
                  >
                    {/* 1. Visitor Info & Ticket Status */}
                    <div className="lg:col-span-3 flex items-center gap-2.5 min-w-0">
                      <Avatar
                        name={displayName}
                        seed={visitor.id}
                        size="sm"
                        online={true}
                        className="shrink-0 shadow-xs"
                      />
                      <div className="min-w-0">
                        <div className="text-ui font-bold text-ink truncate group-hover:text-accent transition-colors flex items-center gap-1.5">
                          <span className="truncate">{displayName}</span>
                          <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" title="Active online" />
                        </div>
                        <div className="text-2xs text-ink-3 truncate">
                          {visitor.email || 'Anonymous visitor'}
                        </div>
                        {/* Open Ticket Indicator */}
                        <div className="mt-1 flex items-center gap-1.5">
                          {openTickets.length > 0 ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenTicket?.(openTickets[0].id);
                              }}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
                              title={`Open Ticket #${openTickets[0].number}: ${openTickets[0].subject}`}
                            >
                              <TicketIcon className="w-2.5 h-2.5" />
                              <span>Ticket #{openTickets[0].number}</span>
                              {openTickets.length > 1 && (
                                <span className="text-2xs opacity-75">+{openTickets.length - 1}</span>
                              )}
                            </button>
                          ) : (
                            <span className="text-2xs text-ink-4">No open ticket</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* 2. Current Page, Title, and Time on Page */}
                    <div className="lg:col-span-4 min-w-0">
                      <div className="font-semibold text-xs text-ink truncate flex items-center gap-1.5" title={pageDisplay.title}>
                        <Globe className="w-3.5 h-3.5 shrink-0 text-accent" />
                        <span className="truncate">{pageDisplay.title}</span>
                      </div>
                      <div className="flex items-center gap-2 text-2xs mt-0.5 min-w-0">
                        <a
                          href={pageDisplay.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-ink-3 hover:text-accent font-mono truncate max-w-[200px]"
                          title={pageDisplay.url}
                        >
                          <span className="truncate">{pageDisplay.path}</span>
                          <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
                        </a>
                        <span className="text-ink-4">•</span>
                        <span className="text-ink-2 font-medium shrink-0 flex items-center gap-0.5">
                          <Clock className="w-2.5 h-2.5 text-ink-3" />
                          {formatTimeOnPage(timeOnPageSeconds)}
                        </span>
                      </div>
                      {visitor.referrer_source && (
                        <div className="text-2xs text-ink-3 truncate mt-0.5" title={`Referrer: ${visitor.referrer_source}`}>
                          via {visitor.referrer_source}
                        </div>
                      )}
                    </div>

                    {/* 3. Session Pages Visited */}
                    <div className="lg:col-span-2 min-w-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedHistoryVisitorId(visitor.id);
                        }}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-surface-2 hover:bg-surface-3 text-ink-2 hover:text-ink border border-line transition-colors"
                        title="Click to view visited pages this session"
                      >
                        <History className="w-3 h-3 text-ink-3" />
                        <span>{historyCount} {historyCount === 1 ? 'page' : 'pages'}</span>
                      </button>
                    </div>

                    {/* 4. Location & Device */}
                    <div className="lg:col-span-2 min-w-0 text-xs text-ink-2">
                      <div className="flex items-center gap-1.5 truncate font-medium">
                        <CountryFlag flag={place.flag} countryCode={place.countryCode} className="w-4 h-3 shrink-0" />
                        <span className="truncate">{place.label || 'Location undetected'}</span>
                      </div>
                      <div className="text-2xs text-ink-3 flex items-center gap-1.5 mt-0.5 truncate">
                        <BrowserIcon browser={ua.browser} className="w-3 h-3 shrink-0" title={ua.browserName} />
                        <span className="truncate">{ua.browserName}</span>
                        <span>•</span>
                        <DeviceIcon device={ua.device} className="w-3 h-3 shrink-0" />
                        <span className="capitalize">{ua.device}</span>
                      </div>
                    </div>

                    {/* 5. Action */}
                    <div className="lg:col-span-1 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenConversationForVisitor(visitor.id);
                        }}
                        className="btn btn-xs btn-primary gap-1 shadow-xs hover:shadow transition-all"
                      >
                        <MessageSquare className="w-3 h-3" />
                        <span>Chat</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          /* Card Grid View */
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
            {activeVisitors.map((visitor) => {
              const ua = parseUserAgentDetailed(visitor.user_agent);
              const place = parseLocation(
                visitor.location,
                visitor.ip_location_city,
                visitor.ip_location_country
              );
              const localTime = localTimeIn(
                visitor.timezone || timezoneFrom(visitor.location)
              );
              const displayName =
                visitor.name ||
                (visitor.email
                  ? visitor.email.split('@')[0]
                  : `Visitor ${visitor.id.slice(0, 6)}`);

              const rawUrl = visitor.current_page_url || visitor.current_url || '/';
              const pageDisplay = formatPageDisplay(rawUrl, visitor.current_page_title);
              const timeOnPageSeconds =
                visitor.time_on_page_seconds ??
                calculateTimeOnPage(visitor.current_page_entered_at, undefined, now);

              const visitorHistory = pageHistoryMap[visitor.id] || [];
              const historyCount = Math.max(1, visitorHistory.length);
              const openTickets = openTicketsMap[visitor.id] || [];

              return (
                <div
                  key={visitor.id}
                  className="rounded-2xl border border-line bg-surface p-5 flex flex-col gap-4 shadow-xs hover:shadow-md hover:border-accent/40 transition-all duration-150 relative group"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar
                        name={displayName}
                        seed={visitor.id}
                        size="md"
                        online={true}
                        className="shadow-xs"
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-ink truncate">
                          {displayName}
                        </div>
                        <div className="text-xs text-ink-3 truncate">
                          {visitor.email || 'Anonymous visitor'}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-bold bg-success/10 text-success border border-success/20">
                        <span className="live-dot" />
                        Live
                      </span>
                      {openTickets.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => onOpenTicket?.(openTickets[0].id)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
                          title={`Ticket #${openTickets[0].number}: ${openTickets[0].subject}`}
                        >
                          <TicketIcon className="w-2.5 h-2.5" />
                          <span>Ticket #{openTickets[0].number}</span>
                        </button>
                      ) : (
                        <span className="text-2xs text-ink-4">No open ticket</span>
                      )}
                    </div>
                  </div>

                  {/* Current URL & Title Card */}
                  <div className="p-3 rounded-xl bg-surface-2 border border-line/70">
                    <div className="flex items-center justify-between gap-2 mb-1 text-2xs font-bold text-ink-3 uppercase tracking-wider">
                      <span className="flex items-center gap-1.5">
                        <Globe className="w-3 h-3 text-accent" />
                        <span>Current Page</span>
                      </span>
                      <span className="text-ink-2 font-medium flex items-center gap-1 font-mono">
                        <Clock className="w-3 h-3 text-ink-3" />
                        {formatTimeOnPage(timeOnPageSeconds)}
                      </span>
                    </div>
                    <div className="font-semibold text-xs text-ink truncate mb-0.5" title={pageDisplay.title}>
                      {pageDisplay.title}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <a
                        href={pageDisplay.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-accent truncate hover:underline"
                        title={pageDisplay.url}
                      >
                        {pageDisplay.path}
                      </a>
                      <ExternalLink className="w-3 h-3 text-ink-3 shrink-0" />
                    </div>
                    {visitor.referrer_source && (
                      <div className="text-2xs text-ink-3 truncate mt-1 pt-1 border-t border-line/40">
                        Referred by: {visitor.referrer_source}
                      </div>
                    )}
                  </div>

                  {/* Pages visited this session trigger */}
                  <div className="flex items-center justify-between text-xs px-1">
                    <span className="text-ink-3 text-2xs font-semibold uppercase tracking-wider">Session Trail</span>
                    <button
                      type="button"
                      onClick={() => setExpandedHistoryVisitorId(visitor.id)}
                      className="inline-flex items-center gap-1 text-accent hover:underline text-xs font-medium"
                    >
                      <History className="w-3 h-3" />
                      <span>{historyCount} {historyCount === 1 ? 'page visited' : 'pages visited'}</span>
                    </button>
                  </div>

                  {/* Device & location telemetry */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-ink-2 bg-surface-2/40 p-3 rounded-xl border border-line/40">
                    <span className="flex items-center gap-1.5 truncate">
                      <CountryFlag flag={place.flag} countryCode={place.countryCode} className="w-4 h-3" />
                      <span className="truncate font-medium">
                        {place.label || 'Location undetected'}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 truncate">
                      <BrowserIcon
                        browser={ua.browser}
                        className="w-3.5 h-3.5"
                        title={ua.browserName}
                      />
                      <span className="truncate font-medium">
                        {ua.browserName}
                        {ua.browserVersion ? ` ${ua.browserVersion.split('.')[0]}` : ''}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 truncate">
                      <OsIcon os={ua.os} className="w-3.5 h-3.5" title={ua.osName} />
                      <span className="truncate font-medium">{ua.osName}</span>
                    </span>
                    <span className="flex items-center gap-1.5 truncate">
                      <DeviceIcon device={ua.device} className="w-3.5 h-3.5" />
                      <span className="truncate font-medium capitalize">
                        {ua.device}
                      </span>
                    </span>
                  </div>

                  {/* Action CTA */}
                  <button
                    onClick={() => onOpenConversationForVisitor(visitor.id)}
                    className="btn btn-primary w-full shadow-xs hover:shadow transition-all gap-1.5"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>Start Chat</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Session Page History Modal / Drawer */}
      {activeHistoryVisitor && (
        <div
          className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setExpandedHistoryVisitorId(null)}
        >
          <div
            className="bg-surface border border-line rounded-2xl shadow-xl max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-line flex items-center justify-between bg-surface-2/40">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar
                  name={activeHistoryVisitorName}
                  seed={activeHistoryVisitor.id}
                  size="md"
                  online={true}
                />
                <div className="min-w-0">
                  <h3 className="text-ui font-bold text-ink truncate">
                    {activeHistoryVisitorName}
                  </h3>
                  <p className="text-2xs text-ink-3 truncate">
                    Session Page Trail ({Math.max(1, activeHistoryItems.length)} pages)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setExpandedHistoryVisitorId(null)}
                className="p-1.5 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-5 overflow-y-auto space-y-4">
              {/* Current Active Page */}
              <div>
                <span className="text-2xs font-bold uppercase tracking-wider text-ink-3 block mb-2">
                  Current Page (Online now)
                </span>
                <div className="p-3 rounded-xl bg-success/5 border border-success/20">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-semibold text-xs text-ink truncate flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-success animate-pulse shrink-0" />
                      {activeHistoryVisitor.current_page_title || formatPageDisplay(activeHistoryVisitor.current_page_url || activeHistoryVisitor.current_url).title}
                    </span>
                    <span className="text-2xs font-medium text-ink-2 shrink-0 flex items-center gap-0.5">
                      <Clock className="w-3 h-3 text-ink-3" />
                      {formatTimeOnPage(
                        activeHistoryVisitor.time_on_page_seconds ??
                        calculateTimeOnPage(activeHistoryVisitor.current_page_entered_at, undefined, now)
                      )}
                    </span>
                  </div>
                  <a
                    href={activeHistoryVisitor.current_page_url || activeHistoryVisitor.current_url || '/'}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-2xs text-accent hover:underline flex items-center gap-1 truncate"
                  >
                    <span className="truncate">{activeHistoryVisitor.current_page_url || activeHistoryVisitor.current_url || '/'}</span>
                    <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                  </a>
                  {activeHistoryVisitor.referrer_source && (
                    <div className="text-2xs text-ink-3 mt-1.5 pt-1.5 border-t border-success/15">
                      Initial Referrer: {activeHistoryVisitor.referrer_source}
                    </div>
                  )}
                </div>
              </div>

              {/* History Timeline */}
              <div>
                <span className="text-2xs font-bold uppercase tracking-wider text-ink-3 block mb-2">
                  Session Page History
                </span>
                {activeHistoryItems.length === 0 ? (
                  <p className="text-xs text-ink-3 p-3 bg-surface-2/40 rounded-xl border border-line/60">
                    This visitor just arrived on their first page. Subsequent client-side route changes and visited pages will appear here.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {activeHistoryItems.map((item, idx) => {
                      const display = formatPageDisplay(item.url, item.title);
                      return (
                        <li
                          key={item.id || idx}
                          className="p-3 rounded-xl bg-surface-2/50 border border-line/60 text-xs hover:bg-surface-2 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-ink truncate" title={display.title}>
                              {display.title}
                            </span>
                            <span className="text-2xs text-ink-3 shrink-0 tabular-nums">
                              {formatTimeAgo(item.visited_at)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-1 text-2xs">
                            <a
                              href={display.url}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-ink-3 hover:text-accent truncate flex items-center gap-1"
                            >
                              <span className="truncate">{display.path}</span>
                              <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
                            </a>
                            {item.duration_seconds !== undefined && item.duration_seconds !== null && item.duration_seconds > 0 ? (
                              <span className="font-medium text-ink-2 shrink-0 flex items-center gap-0.5">
                                <Clock className="w-2.5 h-2.5 text-ink-3" />
                                {formatTimeOnPage(item.duration_seconds)}
                              </span>
                            ) : null}
                          </div>
                          {item.referrer && (
                            <div className="text-2xs text-ink-3 mt-1 pt-1 border-t border-line/40">
                              Referrer: {item.referrer}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3 border-t border-line bg-surface-2/40 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setExpandedHistoryVisitorId(null)}
                className="btn btn-sm btn-secondary"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = activeHistoryVisitor.id;
                  setExpandedHistoryVisitorId(null);
                  onOpenConversationForVisitor(id);
                }}
                className="btn btn-sm btn-primary gap-1.5 shadow-xs"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Start Chat</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
