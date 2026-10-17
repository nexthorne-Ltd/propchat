'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart2,
  Clock,
  CheckCircle2,
  Star,
  Download,
  RefreshCw,
  Filter,
  Users,
  Layers,
  Share2,
  Calendar,
  Sparkles,
  Bot,
  Flame,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  ThumbsUp,
  ThumbsDown,
  ShieldCheck,
  Search,
  ChevronDown,
  HelpCircle,
  ExternalLink,
} from 'lucide-react';
import { listUnansweredQuestionsAction, type UnansweredQuestionRecord } from '@/app/actions/unanswered';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import type { Workspace, Agent } from '@/types/database';
import {
  formatDuration,
  type ReportsDashboardData,
  exportCreatedVsSolvedCsv,
  exportBacklogCsv,
  exportAgentLeaderboardCsv,
  exportBreakdownsCsv,
  exportHeatmapCsv,
  exportSummaryOverviewCsv,
} from '@/lib/reports/metrics';
import { Tabs } from '@/components/ui/Tabs';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState, SkeletonBlock } from '@/components/ui/States';
import { Avatar } from '@/components/ui/Avatar';

interface ReportsDashboardProps {
  workspace: Workspace;
  currentAgent: Agent;
  onOpenInbox?: () => void;
  onOpenSettings?: (section?: string) => void;
}

type TabKey = 'overview' | 'sla_times' | 'csat' | 'breakdowns' | 'bot' | 'leaderboard';
type RangePreset = '7d' | '30d' | '90d' | 'custom';

export function ReportsDashboard({
  workspace,
  currentAgent,
  onOpenInbox,
  onOpenSettings,
}: ReportsDashboardProps) {
  // Filters state
  const [range, setRange] = useState<RangePreset>('30d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [selectedChannel, setSelectedChannel] = useState<string>('');

  // View state
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<(ReportsDashboardData & { meta: { groups: Array<{ id: string; name: string }>; agents: Array<{ id: string; name: string; role: string }> } }) | null>(null);

  // Leaderboard search & sort
  const [leaderboardSearch, setLeaderboardSearch] = useState('');
  const [leaderboardSortBy, setLeaderboardSortBy] = useState<'solved' | 'frt' | 'resolution' | 'csat'>('solved');

  // Export menu open
  const [exportOpen, setExportOpen] = useState(false);

  // Top unanswered questions for Bot tab
  const [topUnanswered, setTopUnanswered] = useState<UnansweredQuestionRecord[]>([]);
  const [loadingUnanswered, setLoadingUnanswered] = useState(false);

  useEffect(() => {
    if (activeTab === 'bot' && workspace?.id) {
      setLoadingUnanswered(true);
      listUnansweredQuestionsAction(workspace.id, 'open')
        .then((res) => setTopUnanswered(res.slice(0, 5)))
        .catch((err) => console.warn('Failed to load top unanswered:', err))
        .finally(() => setLoadingUnanswered(false));
    }
  }, [activeTab, workspace?.id]);

  const fetchData = useCallback(async () => {
    try {
      setRefreshing(true);
      let url = `/api/reports?workspace_id=${encodeURIComponent(workspace.id)}&range=${range}`;
      if (range === 'custom' && customStart && customEnd) {
        url += `&start_date=${encodeURIComponent(customStart)}&end_date=${encodeURIComponent(customEnd)}`;
      }
      if (selectedGroup) url += `&group_id=${encodeURIComponent(selectedGroup)}`;
      if (selectedAgent) url += `&agent_id=${encodeURIComponent(selectedAgent)}`;
      if (selectedChannel) url += `&channel=${encodeURIComponent(selectedChannel)}`;

      const res = await fetch(url);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.error || `Reports service returned HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err: unknown) {
      console.error('[Reports Dashboard Load Error]:', err);
      setError('Check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [workspace.id, range, customStart, customEnd, selectedGroup, selectedAgent, selectedChannel]);

  useEffect(() => {
    if (range !== 'custom' || (customStart && customEnd)) {
      fetchData();
    }
  }, [fetchData, range, customStart, customEnd]);

  // Download CSV helper
  const downloadCsv = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setExportOpen(false);
  };

  const handleResetFilters = () => {
    setRange('30d');
    setCustomStart('');
    setCustomEnd('');
    setSelectedGroup('');
    setSelectedAgent('');
    setSelectedChannel('');
  };

  const hasActiveFilters = Boolean(
    range !== '30d' || selectedGroup || selectedAgent || selectedChannel
  );

  // Tab definitions
  const tabs = [
    { id: 'overview' as const, label: 'Overview & Volume' },
    { id: 'sla_times' as const, label: 'Response Times & SLAs' },
    { id: 'csat' as const, label: 'Satisfaction (CSAT)' },
    { id: 'breakdowns' as const, label: 'Breakdowns & Heatmap' },
    { id: 'bot' as const, label: 'AI Bot Performance' },
    { id: 'leaderboard' as const, label: 'Agent Leaderboard' },
  ];

  // Filtered leaderboard
  const filteredLeaderboard = useMemo(() => {
    if (!data?.leaderboard) return [];
    let list = data.leaderboard.filter((row) =>
      row.name.toLowerCase().includes(leaderboardSearch.toLowerCase()) ||
      row.email.toLowerCase().includes(leaderboardSearch.toLowerCase())
    );

    list.sort((a, b) => {
      if (leaderboardSortBy === 'solved') return b.solvedCount - a.solvedCount;
      if (leaderboardSortBy === 'frt') return (a.medianFrtSeconds ?? Infinity) - (b.medianFrtSeconds ?? Infinity);
      if (leaderboardSortBy === 'resolution') return (a.medianResolutionSeconds ?? Infinity) - (b.medianResolutionSeconds ?? Infinity);
      if (leaderboardSortBy === 'csat') return (b.csatPercent ?? -1) - (a.csatPercent ?? -1);
      return 0;
    });

    return list;
  }, [data?.leaderboard, leaderboardSearch, leaderboardSortBy]);

  const summary = data?.summary;
  const isZeroVolume = !loading && summary && summary.totalCreated === 0 && summary.totalSolved === 0;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-canvas overflow-y-auto">
      {/* 1. Header */}
      <header className="border-b border-line px-6 py-4 bg-surface shrink-0 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink flex items-center gap-2">
            <BarChart2 className="w-5 h-5 text-accent" />
            Reports & Analytics
          </h1>
          <p className="text-xs text-ink-3 mt-0.5">
            Event-driven performance insights across volume, response speed, SLAs, and customer satisfaction.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchData}
            loading={refreshing}
            className="flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>

          {/* Export CSV Dropdown */}
          <div className="relative">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setExportOpen((prev) => !prev)}
              className="flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
              <ChevronDown className="w-3.5 h-3.5 text-ink-3" />
            </Button>

            {exportOpen && data && (
              <div
                className="popover absolute right-0 mt-1 w-56 rounded-lg p-1.5 shadow-lg border border-line z-50 animate-fade"
                onBlur={() => setExportOpen(false)}
              >
                <div className="px-2 py-1 text-2xs font-semibold text-ink-3 uppercase tracking-wider">
                  Download CSV
                </div>
                <button
                  type="button"
                  className="w-full text-left px-2.5 py-1.5 text-xs text-ink hover:bg-surface-3 rounded-md transition-colors"
                  onClick={() => downloadCsv(exportSummaryOverviewCsv(data.summary), `${workspace.name}_overview`)}
                >
                  Summary KPIs Overview
                </button>
                <button
                  type="button"
                  className="w-full text-left px-2.5 py-1.5 text-xs text-ink hover:bg-surface-3 rounded-md transition-colors"
                  onClick={() => downloadCsv(exportCreatedVsSolvedCsv(data.createdVsSolved), `${workspace.name}_created_vs_solved`)}
                >
                  Tickets Created vs Solved
                </button>
                <button
                  type="button"
                  className="w-full text-left px-2.5 py-1.5 text-xs text-ink hover:bg-surface-3 rounded-md transition-colors"
                  onClick={() => downloadCsv(exportBacklogCsv(data.backlogOverTime), `${workspace.name}_backlog`)}
                >
                  Backlog Over Time
                </button>
                <button
                  type="button"
                  className="w-full text-left px-2.5 py-1.5 text-xs text-ink hover:bg-surface-3 rounded-md transition-colors"
                  onClick={() => downloadCsv(exportBreakdownsCsv(data.channelBreakdown, data.priorityBreakdown, data.tagBreakdown), `${workspace.name}_breakdowns`)}
                >
                  Category Breakdowns
                </button>
                <button
                  type="button"
                  className="w-full text-left px-2.5 py-1.5 text-xs text-ink hover:bg-surface-3 rounded-md transition-colors"
                  onClick={() => downloadCsv(exportHeatmapCsv(data.heatmap), `${workspace.name}_busiest_hours`)}
                >
                  Busiest Hours Heatmap
                </button>
                <button
                  type="button"
                  className="w-full text-left px-2.5 py-1.5 text-xs text-ink hover:bg-surface-3 rounded-md transition-colors"
                  onClick={() => downloadCsv(exportAgentLeaderboardCsv(data.leaderboard), `${workspace.name}_agent_leaderboard`)}
                >
                  Agent Leaderboard
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* 2. Filters Bar */}
      <div className="border-b border-line px-6 py-3 bg-surface-2 flex flex-wrap items-center gap-3 shrink-0 text-xs">
        {/* Date Presets */}
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
          {(['7d', '30d', '90d', 'custom'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setRange(p)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                range === p
                  ? 'bg-accent text-accent-ink shadow-xs'
                  : 'text-ink-2 hover:text-ink'
              }`}
            >
              {p === '7d' ? '7 days' : p === '30d' ? '30 days' : p === '90d' ? '90 days' : 'Custom'}
            </button>
          ))}
        </div>

        {/* Custom Date Pickers */}
        {range === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="h-8 px-2 rounded-md border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
              aria-label="Start date"
            />
            <span className="text-ink-3">to</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="h-8 px-2 rounded-md border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
              aria-label="End date"
            />
          </div>
        )}

        {/* Group Filter */}
        <select
          value={selectedGroup}
          onChange={(e) => setSelectedGroup(e.target.value)}
          aria-label="Filter by group"
          className="h-8 px-2.5 rounded-md border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
        >
          <option value="">All Groups</option>
          {data?.meta?.groups?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>

        {/* Agent Filter */}
        <select
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value)}
          aria-label="Filter by agent"
          className="h-8 px-2.5 rounded-md border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
        >
          <option value="">All Agents</option>
          {data?.meta?.agents?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        {/* Channel Filter */}
        <select
          value={selectedChannel}
          onChange={(e) => setSelectedChannel(e.target.value)}
          aria-label="Filter by channel"
          className="h-8 px-2.5 rounded-md border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
        >
          <option value="">All Channels</option>
          <option value="chat">Chat</option>
          <option value="email">Email</option>
          <option value="web_form">Web Form</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="instagram">Instagram</option>
          <option value="x">X</option>
          <option value="threads">Threads</option>
          <option value="linkedin">LinkedIn</option>
          <option value="tiktok">TikTok</option>
        </select>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={handleResetFilters}
            className="text-xs text-accent hover:underline font-medium ml-auto"
          >
            Reset filters
          </button>
        )}
      </div>

      {/* 3. Main Content Area */}
      <div className="p-6 space-y-6">
        {loading ? (
          <div className="space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-24 rounded-xl border border-line bg-surface p-3.5 space-y-2">
                  <SkeletonBlock className="h-3 w-16 rounded" />
                  <SkeletonBlock className="h-6 w-20 rounded" />
                  <SkeletonBlock className="h-3 w-24 rounded" />
                </div>
              ))}
            </div>
            <div className="h-80 rounded-xl border border-line bg-surface p-6">
              <SkeletonBlock className="h-full w-full rounded-lg" />
            </div>
          </div>
        ) : error ? (
          <ErrorState
            title="Failed to load report data"
            message={error}
            onRetry={fetchData}
          />
        ) : isZeroVolume ? (
          <EmptyState
            type="custom"
            title="No ticket activity in this period"
            description="No tickets were created, resolved, or rated in the selected date range and filter criteria."
            actionLabel="Reset filters"
            onAction={handleResetFilters}
          />
        ) : (
          <>
            {/* Top Summary KPI Cards (Row of 6) */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {/* 1. Created vs Solved */}
              <div className="rounded-xl border border-line bg-surface p-3.5 shadow-xs">
                <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  Created vs Solved
                </span>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-xl font-bold text-ink tabular-nums">{summary?.totalCreated ?? 0}</span>
                  <span className="text-xs text-ink-3">/</span>
                  <span className="text-xl font-bold text-success tabular-nums">{summary?.totalSolved ?? 0}</span>
                </div>
                <div className="mt-1 text-2xs text-ink-2">
                  {summary?.resolutionRatePercent !== null ? `${summary?.resolutionRatePercent}% resolved` : '0% resolved'}
                </div>
              </div>

              {/* 2. Backlog */}
              <div className="rounded-xl border border-line bg-surface p-3.5 shadow-xs">
                <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  Active Backlog
                </span>
                <div className="mt-1 text-xl font-bold text-ink tabular-nums">
                  {summary?.finalBacklog ?? 0}
                </div>
                <div className="mt-1 text-2xs text-ink-2 flex items-center gap-1">
                  {(summary?.netBacklogChange ?? 0) <= 0 ? (
                    <TrendingDown className="w-3 h-3 text-success shrink-0" />
                  ) : (
                    <TrendingUp className="w-3 h-3 text-warn shrink-0" />
                  )}
                  <span>
                    {Math.abs(summary?.netBacklogChange ?? 0)} net { (summary?.netBacklogChange ?? 0) <= 0 ? 'reduction' : 'increase'}
                  </span>
                </div>
              </div>

              {/* 3. First Reply Time */}
              <div className="rounded-xl border border-line bg-surface p-3.5 shadow-xs">
                <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  First Reply Time
                </span>
                <div className="mt-1 text-xl font-bold text-ink tabular-nums">
                  {formatDuration(summary?.medianFrtSeconds)}
                </div>
                <div className="mt-1 text-2xs text-ink-2">
                  Avg: {formatDuration(summary?.avgFrtSeconds)}
                </div>
              </div>

              {/* 4. Resolution Time */}
              <div className="rounded-xl border border-line bg-surface p-3.5 shadow-xs">
                <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  Resolution Time
                </span>
                <div className="mt-1 text-xl font-bold text-ink tabular-nums">
                  {formatDuration(summary?.medianResolutionSeconds)}
                </div>
                <div className="mt-1 text-2xs text-ink-2">
                  Avg: {formatDuration(summary?.avgResolutionSeconds)}
                </div>
              </div>

              {/* 5. SLA Achievement */}
              <div className="rounded-xl border border-line bg-surface p-3.5 shadow-xs">
                <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  SLA Achievement
                </span>
                <div className="mt-1 text-xl font-bold text-ink tabular-nums">
                  {summary?.overallSlaPercent !== null ? `${summary?.overallSlaPercent}%` : '—'}
                </div>
                <div className="mt-1 text-2xs text-ink-2">
                  {summary?.totalSlaMet ?? 0} met · {summary?.totalSlaBreached ?? 0} breached
                </div>
              </div>

              {/* 6. CSAT Score */}
              <div className="rounded-xl border border-line bg-surface p-3.5 shadow-xs">
                <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  CSAT Positive %
                </span>
                <div className="mt-1 text-xl font-bold text-ink tabular-nums flex items-center gap-1.5">
                  <ThumbsUp className="w-4 h-4 text-success" />
                  <span>{summary?.csatPercent !== null ? `${summary?.csatPercent}%` : '—'}</span>
                </div>
                <div className="mt-1 text-2xs text-ink-2">
                  {summary?.goodCsatRatings ?? 0} good · {summary?.badCsatRatings ?? 0} bad
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="border-b border-line">
              <Tabs
                items={tabs}
                value={activeTab}
                onChange={setActiveTab}
                label="Report views"
                variant="line"
              />
            </div>

            {/* TAB 1: OVERVIEW & VOLUME */}
            {activeTab === 'overview' && data && (
              <div className="space-y-6">
                {/* Created vs Solved Chart */}
                <div className="rounded-xl border border-line bg-surface p-5 shadow-xs">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-sm font-semibold text-ink">Tickets Created vs Solved</h2>
                      <p className="text-xs text-ink-3">Daily comparison of incoming vs resolved ticket volume.</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => downloadCsv(exportCreatedVsSolvedCsv(data.createdVsSolved), `${workspace.name}_created_vs_solved`)}
                      className="flex items-center gap-1 text-2xs"
                    >
                      <Download className="w-3 h-3" /> CSV
                    </Button>
                  </div>

                  <div className="h-72 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.createdVsSolved} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--ds-line)" />
                        <XAxis dataKey="label" stroke="var(--ds-ink-3)" fontSize={11} tickLine={false} />
                        <YAxis stroke="var(--ds-ink-3)" fontSize={11} tickLine={false} allowDecimals={false} />
                        <RechartsTooltip
                          contentStyle={{ backgroundColor: 'var(--ds-surface)', borderColor: 'var(--ds-line)', borderRadius: '8px', fontSize: '12px' }}
                          labelStyle={{ color: 'var(--ds-ink)', fontWeight: 600 }}
                        />
                        <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                        <Bar dataKey="created" name="Created" fill="var(--ds-accent)" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="solved" name="Solved" fill="var(--ds-success)" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Backlog Over Time Chart */}
                <div className="rounded-xl border border-line bg-surface p-5 shadow-xs">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-sm font-semibold text-ink">Backlog Over Time</h2>
                      <p className="text-xs text-ink-3">Unresolved ticket volume progression across the selected period.</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => downloadCsv(exportBacklogCsv(data.backlogOverTime), `${workspace.name}_backlog`)}
                      className="flex items-center gap-1 text-2xs"
                    >
                      <Download className="w-3 h-3" /> CSV
                    </Button>
                  </div>

                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={data.backlogOverTime} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <defs>
                          <linearGradient id="backlogGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--ds-accent)" stopOpacity={0.25} />
                            <stop offset="95%" stopColor="var(--ds-accent)" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--ds-line)" />
                        <XAxis dataKey="label" stroke="var(--ds-ink-3)" fontSize={11} tickLine={false} />
                        <YAxis stroke="var(--ds-ink-3)" fontSize={11} tickLine={false} allowDecimals={false} />
                        <RechartsTooltip
                          contentStyle={{ backgroundColor: 'var(--ds-surface)', borderColor: 'var(--ds-line)', borderRadius: '8px', fontSize: '12px' }}
                          labelStyle={{ color: 'var(--ds-ink)', fontWeight: 600 }}
                        />
                        <Area type="monotone" dataKey="backlog" name="Active Backlog" stroke="var(--ds-accent)" fillOpacity={1} fill="url(#backlogGrad)" strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: RESPONSE TIMES & SLAS */}
            {activeTab === 'sla_times' && data && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* First Reply Time Card */}
                  <div className="rounded-xl border border-line bg-surface p-5 shadow-xs space-y-4">
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
                        <Clock className="w-4 h-4 text-accent" />
                        First Reply Time (FRT)
                      </h2>
                      <span className="text-2xs text-ink-3 uppercase font-semibold">Speed to First Contact</span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-2">
                      <div className="p-4 rounded-lg bg-surface-2 border border-line/60">
                        <span className="text-2xs text-ink-3 uppercase font-semibold">Median FRT</span>
                        <div className="text-2xl font-bold text-ink mt-1 tabular-nums">
                          {formatDuration(summary?.medianFrtSeconds)}
                        </div>
                        <span className="text-2xs text-ink-3">50% answered faster</span>
                      </div>
                      <div className="p-4 rounded-lg bg-surface-2 border border-line/60">
                        <span className="text-2xs text-ink-3 uppercase font-semibold">Average FRT</span>
                        <div className="text-2xl font-bold text-ink mt-1 tabular-nums">
                          {formatDuration(summary?.avgFrtSeconds)}
                        </div>
                        <span className="text-2xs text-ink-3">Arithmetic mean</span>
                      </div>
                    </div>
                  </div>

                  {/* Resolution Time Card */}
                  <div className="rounded-xl border border-line bg-surface p-5 shadow-xs space-y-4">
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-success" />
                        Resolution Time
                      </h2>
                      <span className="text-2xs text-ink-3 uppercase font-semibold">Full Cycle Duration</span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-2">
                      <div className="p-4 rounded-lg bg-surface-2 border border-line/60">
                        <span className="text-2xs text-ink-3 uppercase font-semibold">Median Resolution</span>
                        <div className="text-2xl font-bold text-ink mt-1 tabular-nums">
                          {formatDuration(summary?.medianResolutionSeconds)}
                        </div>
                        <span className="text-2xs text-ink-3">50% solved faster</span>
                      </div>
                      <div className="p-4 rounded-lg bg-surface-2 border border-line/60">
                        <span className="text-2xs text-ink-3 uppercase font-semibold">Average Resolution</span>
                        <div className="text-2xl font-bold text-ink mt-1 tabular-nums">
                          {formatDuration(summary?.avgResolutionSeconds)}
                        </div>
                        <span className="text-2xs text-ink-3">Arithmetic mean</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* SLA Achievement Breakdown Card */}
                <div className="rounded-xl border border-line bg-surface p-5 shadow-xs">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-accent" />
                        SLA Achievement by Metric
                      </h2>
                      <p className="text-xs text-ink-3">Compliance against first-reply, next-reply, and resolution targets.</p>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-bold text-ink tabular-nums">
                        {summary?.overallSlaPercent !== null ? `${summary?.overallSlaPercent}%` : '—'}
                      </span>
                      <span className="text-xs text-ink-3 block">Overall achievement</span>
                    </div>
                  </div>

                  <div className="space-y-4 pt-2">
                    {/* First reply SLA */}
                    <div>
                      <div className="flex justify-between text-xs font-medium mb-1">
                        <span className="text-ink">First Reply SLA</span>
                        <span className="text-ink tabular-nums font-semibold">
                          {summary?.firstReplySlaPercent !== null ? `${summary?.firstReplySlaPercent}%` : 'No targets'}
                        </span>
                      </div>
                      <div className="w-full bg-surface-3 rounded-full h-2.5 overflow-hidden">
                        <div
                          className="bg-accent h-2.5 rounded-full transition-all"
                          style={{ width: `${summary?.firstReplySlaPercent ?? 0}%` }}
                        />
                      </div>
                    </div>

                    {/* Next reply SLA */}
                    <div>
                      <div className="flex justify-between text-xs font-medium mb-1">
                        <span className="text-ink">Next Reply SLA</span>
                        <span className="text-ink tabular-nums font-semibold">
                          {summary?.nextReplySlaPercent !== null ? `${summary?.nextReplySlaPercent}%` : 'No targets'}
                        </span>
                      </div>
                      <div className="w-full bg-surface-3 rounded-full h-2.5 overflow-hidden">
                        <div
                          className="bg-accent h-2.5 rounded-full transition-all"
                          style={{ width: `${summary?.nextReplySlaPercent ?? 0}%` }}
                        />
                      </div>
                    </div>

                    {/* Resolution SLA */}
                    <div>
                      <div className="flex justify-between text-xs font-medium mb-1">
                        <span className="text-ink">Resolution SLA</span>
                        <span className="text-ink tabular-nums font-semibold">
                          {summary?.resolutionSlaPercent !== null ? `${summary?.resolutionSlaPercent}%` : 'No targets'}
                        </span>
                      </div>
                      <div className="w-full bg-surface-3 rounded-full h-2.5 overflow-hidden">
                        <div
                          className="bg-success h-2.5 rounded-full transition-all"
                          style={{ width: `${summary?.resolutionSlaPercent ?? 0}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: CUSTOMER SATISFACTION (CSAT) */}
            {activeTab === 'csat' && data && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* CSAT Score Card */}
                  <div className="rounded-xl border border-line bg-surface p-5 shadow-xs space-y-2">
                    <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                      Satisfaction Score (CSAT)
                    </span>
                    <div className="text-3xl font-bold text-ink tabular-nums flex items-center gap-2">
                      <ThumbsUp className="w-7 h-7 text-success shrink-0" />
                      <span>{summary?.csatPercent !== null ? `${summary?.csatPercent}%` : '—'}</span>
                    </div>
                    <p className="text-xs text-ink-2">
                      Percentage of customers rating their experience as Good.
                    </p>
                  </div>

                  {/* Ratings Count */}
                  <div className="rounded-xl border border-line bg-surface p-5 shadow-xs space-y-2">
                    <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                      Ratings Volume
                    </span>
                    <div className="text-3xl font-bold text-ink tabular-nums">
                      {summary?.totalCsatRatings ?? 0}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-ink-2">
                      <span className="flex items-center gap-1 text-success font-medium">
                        <ThumbsUp className="w-3.5 h-3.5" /> {summary?.goodCsatRatings ?? 0} Good
                      </span>
                      <span>·</span>
                      <span className="flex items-center gap-1 text-danger font-medium">
                        <ThumbsDown className="w-3.5 h-3.5" /> {summary?.badCsatRatings ?? 0} Bad
                      </span>
                    </div>
                  </div>

                  {/* Response Rate */}
                  <div className="rounded-xl border border-line bg-surface p-5 shadow-xs space-y-2">
                    <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                      Survey Response Rate
                    </span>
                    <div className="text-3xl font-bold text-ink tabular-nums">
                      {summary?.csatResponseRatePercent !== null ? `${summary?.csatResponseRatePercent}%` : '—'}
                    </div>
                    <p className="text-xs text-ink-2">
                      Percentage of solved tickets where the requester submitted a rating.
                    </p>
                  </div>
                </div>

                {/* Customer Comments & Feedback */}
                <div className="rounded-xl border border-line bg-surface p-5 shadow-xs">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-sm font-semibold text-ink">Recent Customer Feedback</h2>
                      <p className="text-xs text-ink-3">Comments and ratings submitted by requesters.</p>
                    </div>
                  </div>

                  {data.recentFeedback.length === 0 ? (
                    <div className="text-center py-10 text-xs text-ink-3">
                      No ratings or comments have been received yet.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {data.recentFeedback.map((fb, idx) => (
                        <div
                          key={idx}
                          className="p-3.5 rounded-lg border border-line bg-surface-2/60 flex items-start gap-3"
                        >
                          <div
                            className={`p-1.5 rounded-md ${
                              fb.rating === 'good'
                                ? 'bg-success-soft text-success'
                                : 'bg-danger-soft text-danger'
                            }`}
                          >
                            {fb.rating === 'good' ? (
                              <ThumbsUp className="w-4 h-4" />
                            ) : (
                              <ThumbsDown className="w-4 h-4" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-ink">
                                {fb.rating === 'good' ? 'Good Experience' : 'Needs Improvement'}
                              </span>
                              <span className="text-2xs text-ink-3">
                                {new Date(fb.occurredAt).toLocaleDateString()}
                              </span>
                            </div>
                            {fb.comment ? (
                              <p className="text-xs text-ink-2 mt-1 italic">“{fb.comment}”</p>
                            ) : (
                              <p className="text-2xs text-ink-3 mt-1">(No comment provided)</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 4: BREAKDOWNS & HEATMAP */}
            {activeTab === 'breakdowns' && data && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Channels Breakdown */}
                  <div className="rounded-xl border border-line bg-surface p-5 shadow-xs">
                    <h2 className="text-sm font-semibold text-ink mb-1">Tickets by Channel</h2>
                    <p className="text-2xs text-ink-3 mb-3">Volume distribution across contact channels.</p>
                    <div className="space-y-2">
                      {data.channelBreakdown.map((item) => (
                        <div key={item.key} className="text-xs">
                          <div className="flex justify-between mb-1">
                            <span className="text-ink capitalize">{item.label}</span>
                            <span className="text-ink-2 tabular-nums">
                              {item.count} ({item.percentage}%)
                            </span>
                          </div>
                          <div className="w-full bg-surface-3 rounded-full h-1.5">
                            <div className="bg-accent h-1.5 rounded-full" style={{ width: `${item.percentage}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Priority Breakdown */}
                  <div className="rounded-xl border border-line bg-surface p-5 shadow-xs">
                    <h2 className="text-sm font-semibold text-ink mb-1">Tickets by Priority</h2>
                    <p className="text-2xs text-ink-3 mb-3">Urgency classification breakdown.</p>
                    <div className="space-y-2">
                      {data.priorityBreakdown.map((item) => (
                        <div key={item.key} className="text-xs">
                          <div className="flex justify-between mb-1">
                            <span className="text-ink capitalize">{item.label}</span>
                            <span className="text-ink-2 tabular-nums">
                              {item.count} ({item.percentage}%)
                            </span>
                          </div>
                          <div className="w-full bg-surface-3 rounded-full h-1.5">
                            <div
                              className={`h-1.5 rounded-full ${
                                item.key === 'urgent'
                                  ? 'bg-danger'
                                  : item.key === 'high'
                                  ? 'bg-warn'
                                  : 'bg-accent'
                              }`}
                              style={{ width: `${item.percentage}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Tag Breakdown */}
                  <div className="rounded-xl border border-line bg-surface p-5 shadow-xs">
                    <h2 className="text-sm font-semibold text-ink mb-1">Top Tags</h2>
                    <p className="text-2xs text-ink-3 mb-3">Most common tags on created tickets.</p>
                    {data.tagBreakdown.length === 0 ? (
                      <p className="text-2xs text-ink-3 py-6 text-center">No tags used on tickets in this period.</p>
                    ) : (
                      <div className="space-y-2">
                        {data.tagBreakdown.map((item) => (
                          <div key={item.key} className="text-xs">
                            <div className="flex justify-between mb-1">
                              <span className="text-ink font-mono text-2xs">#{item.label}</span>
                              <span className="text-ink-2 tabular-nums">
                                {item.count} ({item.percentage}%)
                              </span>
                            </div>
                            <div className="w-full bg-surface-3 rounded-full h-1.5">
                              <div className="bg-accent h-1.5 rounded-full" style={{ width: `${item.percentage}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Busiest Hours Heatmap */}
                <div className="rounded-xl border border-line bg-surface p-5 shadow-xs space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
                        <Flame className="w-4 h-4 text-warn" />
                        Busiest Hours Heatmap
                      </h2>
                      <p className="text-xs text-ink-3">Ticket creation density across all hours of the week (UTC).</p>
                    </div>
                    {data.peakHour && (
                      <div className="px-3 py-1.5 rounded-lg bg-warn-soft border border-warn-line text-xs font-medium text-warn flex items-center gap-1.5">
                        <Flame className="w-3.5 h-3.5" />
                        <span>Peak: {data.peakHour.label} ({data.peakHour.count} tickets)</span>
                      </div>
                    )}
                  </div>

                  {/* Heatmap Grid */}
                  <div className="overflow-x-auto pb-2">
                    <div className="min-w-[640px]">
                      {/* Hour numbers header */}
                      <div className="grid grid-cols-[48px_repeat(24,1fr)] gap-1 mb-1 text-center text-2xs text-ink-3 font-mono">
                        <div></div>
                        {Array.from({ length: 24 }).map((_, h) => (
                          <div key={h}>{h}</div>
                        ))}
                      </div>

                      {/* Day rows */}
                      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((dayName, dayIndex) => {
                        const dayCells = data.heatmap.filter((c) => c.dayOfWeek === dayIndex);
                        const maxCount = Math.max(1, ...data.heatmap.map((c) => c.count));

                        return (
                          <div
                            key={dayName}
                            className="grid grid-cols-[48px_repeat(24,1fr)] gap-1 mb-1 items-center"
                          >
                            <span className="text-2xs font-semibold text-ink-2">{dayName}</span>
                            {dayCells.map((cell) => {
                              const intensity = cell.count > 0 ? Math.min(1, cell.count / maxCount) : 0;
                              return (
                                <div
                                  key={cell.hour}
                                  title={`${cell.dayName} at ${cell.hour}:00 UTC: ${cell.count} ticket${cell.count === 1 ? '' : 's'}`}
                                  className="h-6 rounded-xs transition-colors cursor-pointer border border-line/40 hover:border-accent"
                                  style={{
                                    backgroundColor:
                                      cell.count === 0
                                        ? 'var(--ds-surface-2)'
                                        : `color-mix(in srgb, var(--ds-accent) ${Math.round(intensity * 80 + 20)}%, transparent)`,
                                  }}
                                />
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 5: AI BOT PERFORMANCE */}
            {activeTab === 'bot' && data && (() => {
              const totalBot = summary?.totalBotInquiries ?? 0;
              const handoverCount = summary?.botHandoverCount ?? 0;
              const handoverRatePercent = totalBot > 0 ? Math.round((handoverCount / totalBot) * 100) : 0;

              return (
                <div className="space-y-6">
                  <div className="rounded-xl border border-line bg-surface p-5 shadow-xs space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
                          <Bot className="w-4 h-4 text-accent" />
                          AI Bot Resolved vs Handed to Human
                        </h2>
                        <p className="text-xs text-ink-3">Autopilot ticket deflection and agent hand-over tracking.</p>
                      </div>
                      <span className="text-2xs text-ink-3 font-mono font-semibold uppercase">Bot Deflection</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
                      <div className="p-4 rounded-xl bg-surface-2 border border-line/60">
                        <span className="text-2xs uppercase tracking-wider font-semibold text-ink-3">Bot Resolution Rate</span>
                        <div className="text-3xl font-bold text-success mt-1 tabular-nums">
                          {summary?.botResolutionRatePercent !== null ? `${summary?.botResolutionRatePercent}%` : '—'}
                        </div>
                        <p className="text-2xs text-ink-2 mt-1">Resolved without human escalation</p>
                      </div>

                      <div className="p-4 rounded-xl bg-surface-2 border border-line/60">
                        <span className="text-2xs uppercase tracking-wider font-semibold text-ink-3">Handover Rate</span>
                        <div className="text-3xl font-bold text-warn mt-1 tabular-nums">
                          {handoverRatePercent}%
                        </div>
                        <p className="text-2xs text-ink-2 mt-1">Escalated to human agents</p>
                      </div>

                      <div className="p-4 rounded-xl bg-surface-2 border border-line/60">
                        <span className="text-2xs uppercase tracking-wider font-semibold text-ink-3">Resolved by Bot</span>
                        <div className="text-3xl font-bold text-ink mt-1 tabular-nums">
                          {summary?.botResolvedCount ?? 0}
                        </div>
                        <p className="text-2xs text-ink-2 mt-1">Answered from knowledge base</p>
                      </div>

                      <div className="p-4 rounded-xl bg-surface-2 border border-line/60">
                        <span className="text-2xs uppercase tracking-wider font-semibold text-ink-3">Handed Over to Agent</span>
                        <div className="text-3xl font-bold text-warn mt-1 tabular-nums">
                          {summary?.botHandoverCount ?? 0}
                        </div>
                        <p className="text-2xs text-ink-2 mt-1">Requested human or out of scope</p>
                      </div>
                    </div>

                    {/* Visual Bar */}
                    {totalBot > 0 && (
                      <div className="space-y-2 pt-2">
                        <div className="flex justify-between text-xs text-ink-2">
                          <span>Resolved by bot ({summary?.botResolvedCount ?? 0})</span>
                          <span>Handed to human ({summary?.botHandoverCount ?? 0})</span>
                        </div>
                        <div className="w-full bg-surface-3 rounded-full h-3 flex overflow-hidden">
                          <div
                            className="bg-success h-full transition-all"
                            style={{ width: `${summary?.botResolutionRatePercent ?? 0}%` }}
                          />
                          <div
                            className="bg-warn h-full transition-all"
                            style={{ width: `${100 - (summary?.botResolutionRatePercent ?? 0)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Top Unanswered Questions */}
                  <div className="rounded-xl border border-line bg-surface p-5 shadow-xs space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
                          <HelpCircle className="w-4 h-4 text-accent" />
                          Top Unanswered Questions
                        </h2>
                        <p className="text-xs text-ink-3">
                          Frequent customer inquiries the AI bot could not answer from your knowledge base.
                        </p>
                      </div>
                      <a
                        href="/dashboard/unanswered"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-xs font-medium text-ink hover:bg-surface-2 transition-colors"
                      >
                        <span>View All in Training</span>
                        <ExternalLink className="w-3.5 h-3.5 text-ink-muted" />
                      </a>
                    </div>

                    {loadingUnanswered ? (
                      <div className="py-8 flex items-center justify-center gap-2 text-xs text-ink-muted">
                        <RefreshCw className="w-4 h-4 animate-spin text-accent" />
                        <span>Loading unanswered questions...</span>
                      </div>
                    ) : topUnanswered.length === 0 ? (
                      <div className="py-8 text-center text-xs text-ink-muted">
                        No open unanswered questions found for this workspace. Your bot is handling inquiries smoothly!
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-muted font-semibold">
                              <th className="py-2.5 px-3">Question</th>
                              <th className="py-2.5 px-3 text-center">Times Asked</th>
                              <th className="py-2.5 px-3">Last Asked</th>
                              <th className="py-2.5 px-3 text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line/60">
                            {topUnanswered.map((q) => (
                              <tr key={q.id} className="hover:bg-surface-2/50 transition-colors">
                                <td className="py-2.5 px-3 font-medium text-ink max-w-md truncate">
                                  {q.question}
                                </td>
                                <td className="py-2.5 px-3 text-center">
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-accent/10 text-accent font-semibold text-2xs">
                                    {q.times_asked}x
                                  </span>
                                </td>
                                <td className="py-2.5 px-3 text-ink-muted text-2xs">
                                  {new Date(q.last_asked_at || q.created_at).toLocaleDateString(undefined, {
                                    month: 'short',
                                    day: 'numeric',
                                  })}
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  <a
                                    href={`/dashboard/unanswered`}
                                    className="text-2xs font-semibold text-accent hover:underline inline-flex items-center gap-1"
                                  >
                                    <span>Train Answer</span>
                                    <ArrowRight className="w-3 h-3" />
                                  </a>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* TAB 6: AGENT LEADERBOARD */}
            {activeTab === 'leaderboard' && data && (
              <div className="rounded-xl border border-line bg-surface p-5 shadow-xs space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
                      <Users className="w-4 h-4 text-accent" />
                      Agent Performance Leaderboard
                    </h2>
                    <p className="text-xs text-ink-3">Solved ticket throughput, response speeds, and customer satisfaction.</p>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Search agent */}
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-2.5" />
                      <input
                        type="text"
                        placeholder="Search agent..."
                        value={leaderboardSearch}
                        onChange={(e) => setLeaderboardSearch(e.target.value)}
                        className="h-8 pl-8 pr-3 rounded-md border border-line bg-surface text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent"
                      />
                    </div>

                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => downloadCsv(exportAgentLeaderboardCsv(data.leaderboard), `${workspace.name}_agent_leaderboard`)}
                      className="flex items-center gap-1 text-2xs"
                    >
                      <Download className="w-3 h-3" /> CSV
                    </Button>
                  </div>
                </div>

                {/* Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-line text-ink-3 uppercase text-2xs">
                        <th className="py-2.5 px-3">Agent</th>
                        <th
                          className="py-2.5 px-3 cursor-pointer hover:text-ink text-right"
                          onClick={() => setLeaderboardSortBy('solved')}
                        >
                          Solved {leaderboardSortBy === 'solved' ? '↓' : ''}
                        </th>
                        <th
                          className="py-2.5 px-3 cursor-pointer hover:text-ink text-right"
                          onClick={() => setLeaderboardSortBy('frt')}
                        >
                          Median FRT {leaderboardSortBy === 'frt' ? '↓' : ''}
                        </th>
                        <th
                          className="py-2.5 px-3 cursor-pointer hover:text-ink text-right"
                          onClick={() => setLeaderboardSortBy('resolution')}
                        >
                          Median Resolution {leaderboardSortBy === 'resolution' ? '↓' : ''}
                        </th>
                        <th
                          className="py-2.5 px-3 cursor-pointer hover:text-ink text-right"
                          onClick={() => setLeaderboardSortBy('csat')}
                        >
                          CSAT % {leaderboardSortBy === 'csat' ? '↓' : ''}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/60">
                      {filteredLeaderboard.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-ink-3">
                            No matching agents found.
                          </td>
                        </tr>
                      ) : (
                        filteredLeaderboard.map((row) => (
                          <tr key={row.agentId} className="hover:bg-surface-2/60 transition-colors">
                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-2.5">
                                <Avatar name={row.name} seed={row.agentId} size="sm" />
                                <div>
                                  <div className="font-semibold text-ink">{row.name}</div>
                                  <div className="text-2xs text-ink-3">{row.email}</div>
                                </div>
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-right font-semibold text-ink tabular-nums">
                              {row.solvedCount}
                            </td>
                            <td className="py-2.5 px-3 text-right text-ink-2 tabular-nums">
                              {formatDuration(row.medianFrtSeconds)}
                            </td>
                            <td className="py-2.5 px-3 text-right text-ink-2 tabular-nums">
                              {formatDuration(row.medianResolutionSeconds)}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              {row.csatPercent !== null ? (
                                <span className="inline-flex items-center gap-1 font-semibold text-success">
                                  <ThumbsUp className="w-3 h-3" />
                                  <span>{row.csatPercent}%</span>
                                  <span className="text-2xs text-ink-3 font-normal">
                                    ({row.csatGood}/{row.totalCsat})
                                  </span>
                                </span>
                              ) : (
                                <span className="text-ink-3">—</span>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
