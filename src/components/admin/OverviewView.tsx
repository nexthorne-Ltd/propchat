'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Building2,
  Users,
  MessageSquare,
  Bot,
  AlertTriangle,
  TrendingUp,
  RefreshCw,
  Clock,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import { getPlatformOverviewMetricsAction } from '@/app/actions/platform';
import { PlatformOverviewMetrics } from '@/types/database';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { LoadingState, ErrorState, SkeletonBlock } from '@/components/ui/States';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

export function OverviewView() {
  const [data, setData] = useState<PlatformOverviewMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const res = await getPlatformOverviewMetricsAction();
      setData(res);
    } catch (err: any) {
      setError(errorMessage(err, 'Failed to load platform overview metrics.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <SkeletonBlock className="h-8 w-48" />
          <SkeletonBlock className="h-8 w-24" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <SkeletonBlock className="h-72 rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SkeletonBlock className="h-64 rounded-xl" />
          <SkeletonBlock className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <ErrorState
        title="Could not load platform overview"
        message={error || 'An unexpected error occurred while fetching metrics.'}
        onRetry={() => fetchData()}
      />
    );
  }

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-ink tracking-tight">Platform Overview</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            Real-time aggregate performance, activity metrics, and health alerts across all workspaces.
          </p>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => fetchData(true)}
          loading={refreshing}
          className="self-start sm:self-auto"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          <span>Refresh Metrics</span>
        </Button>
      </div>

      {/* 5 Key Metric Cards */}
      <section aria-label="Key Platform Indicators" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        {/* 1. Workspaces */}
        <div className="card p-4 space-y-2 border border-line bg-surface shadow-xs">
          <div className="flex items-center justify-between text-ink-3">
            <span className="text-2xs font-semibold uppercase tracking-wider">Total Workspaces</span>
            <Building2 className="w-4 h-4 text-accent" />
          </div>
          <div className="text-2xl font-bold text-ink tabular-nums">
            {data.total_workspaces.toLocaleString()}
          </div>
          <div className="flex items-center gap-1.5 text-2xs text-ink-3">
            <Badge tone="success" className="text-2xs py-0 px-1.5">
              {data.active_workspaces} active
            </Badge>
            {data.suspended_workspaces > 0 && (
              <Badge tone="warn" className="text-2xs py-0 px-1.5">
                {data.suspended_workspaces} suspended
              </Badge>
            )}
          </div>
        </div>

        {/* 2. Active Agents */}
        <div className="card p-4 space-y-2 border border-line bg-surface shadow-xs">
          <div className="flex items-center justify-between text-ink-3">
            <span className="text-2xs font-semibold uppercase tracking-wider">Active Agents</span>
            <Users className="w-4 h-4 text-accent" />
          </div>
          <div className="text-2xl font-bold text-ink tabular-nums">
            {data.active_agents.toLocaleString()}
          </div>
          <div className="text-2xs text-ink-3">
            {data.total_agents.toLocaleString()} total platform users
          </div>
        </div>

        {/* 3. Tickets Today & Month */}
        <div className="card p-4 space-y-2 border border-line bg-surface shadow-xs">
          <div className="flex items-center justify-between text-ink-3">
            <span className="text-2xs font-semibold uppercase tracking-wider">Tickets Today</span>
            <TrendingUp className="w-4 h-4 text-accent" />
          </div>
          <div className="text-2xl font-bold text-ink tabular-nums">
            {data.tickets_today.toLocaleString()}
          </div>
          <div className="text-2xs text-ink-3">
            {data.tickets_this_month.toLocaleString()} this calendar month
          </div>
        </div>

        {/* 4. Messages Total */}
        <div className="card p-4 space-y-2 border border-line bg-surface shadow-xs">
          <div className="flex items-center justify-between text-ink-3">
            <span className="text-2xs font-semibold uppercase tracking-wider">Total Messages</span>
            <MessageSquare className="w-4 h-4 text-accent" />
          </div>
          <div className="text-2xl font-bold text-ink tabular-nums">
            {data.total_messages.toLocaleString()}
          </div>
          <div className="text-2xs text-ink-3">Across all customer threads</div>
        </div>

        {/* 5. AI Bot Resolution Rate */}
        <div className="card p-4 space-y-2 border border-line bg-surface shadow-xs">
          <div className="flex items-center justify-between text-ink-3">
            <span className="text-2xs font-semibold uppercase tracking-wider">Bot Resolution</span>
            <Bot className="w-4 h-4 text-accent" />
          </div>
          <div className="text-2xl font-bold text-ink tabular-nums">
            {data.bot_resolution_rate !== null ? `${data.bot_resolution_rate}%` : 'Not available yet'}
          </div>
          <div className="text-2xs text-ink-3">
            {data.bot_resolved_count > 0 || data.bot_handover_count > 0
              ? `${data.bot_resolved_count} resolved, ${data.bot_handover_count} handover`
              : 'Self-service AI automated resolution'}
          </div>
        </div>
      </section>

      {/* 30-Day Trend Area Chart */}
      <section className="card p-5 border border-line bg-surface shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-ink">Ticket Volume & Resolution Trend (30 Days)</h3>
            <p className="text-xs text-ink-3 mt-0.5">
              Daily customer inquiries created versus resolved across all workspaces
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs text-ink-3 font-medium">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-accent" />
              Created
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-success" />
              Solved
            </span>
          </div>
        </div>

        <div className="h-64 w-full pt-2">
          {data.trend_tickets.length === 0 ? (
            <EmptyState
              type="custom"
              title="No tickets recorded"
              description="No support ticket activity has been logged in the past 30 days."
            />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.trend_tickets} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="trendCreatedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--ds-accent)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--ds-accent)" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="trendSolvedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--ds-success)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--ds-success)" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
                <XAxis
                  dataKey="formatted_date"
                  tick={{ fontSize: 11, fill: 'currentColor' }}
                  tickLine={false}
                  axisLine={{ stroke: 'rgba(150, 150, 150, 0.2)' }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'currentColor' }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--ds-surface)',
                    borderColor: 'var(--ds-line)',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: 'var(--ds-ink)',
                  }}
                  labelStyle={{ color: 'var(--ds-ink-2)', fontWeight: 600, marginBottom: '4px' }}
                />
                <Area
                  type="monotone"
                  dataKey="created"
                  name="Tickets Created"
                  stroke="var(--ds-accent)"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#trendCreatedGrad)"
                />
                <Area
                  type="monotone"
                  dataKey="solved"
                  name="Tickets Solved"
                  stroke="var(--ds-success)"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#trendSolvedGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Two Column Grid: Newest Workspaces & System Alerts List */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 1. Newest Workspaces */}
        <section className="card p-5 border border-line bg-surface shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-ink">Newest Workspaces</h3>
              <p className="text-xs text-ink-3 mt-0.5">Recently registered organizations</p>
            </div>
            <Link
              href="/admin/workspaces"
              className="text-xs text-accent hover:underline flex items-center gap-1 font-medium"
            >
              <span>View all</span>
              <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          {data.newest_workspaces.length === 0 ? (
            <EmptyState
              type="custom"
              title="No workspaces registered"
              description="New workspaces will appear here automatically."
            />
          ) : (
            <div className="divide-y divide-line/60 border border-line rounded-lg overflow-hidden bg-surface">
              {data.newest_workspaces.map((w) => (
                <div key={w.id} className="p-3 flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-xs shrink-0"
                      style={{ backgroundColor: w.brand_color || '#2563eb' }}
                    >
                      {w.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <Link
                        href={`/admin/workspaces/${w.id}`}
                        className="font-semibold text-ink hover:text-accent truncate block"
                      >
                        {w.name}
                      </Link>
                      <span className="text-2xs text-ink-3 truncate block">
                        {w.owner_email || 'No owner email'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Badge tone={w.is_suspended ? 'warn' : 'neutral'} className="text-2xs capitalize">
                      {w.is_suspended ? 'Suspended' : w.plan}
                    </Badge>
                    <Link
                      href={`/admin/workspaces/${w.id}`}
                      className="p-1.5 rounded hover:bg-surface-3 text-ink-3 hover:text-ink transition-colors"
                      title="View Workspace"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 2. Live Alerts List */}
        <section className="card p-5 border border-line bg-surface shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-ink">Platform Alerts</h3>
              <p className="text-xs text-ink-3 mt-0.5">Suspended workspaces & channel error alerts</p>
            </div>
            <Link
              href="/admin/health"
              className="text-xs text-accent hover:underline flex items-center gap-1 font-medium"
            >
              <span>System Health</span>
              <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          {data.alerts.length === 0 ? (
            <div className="p-6 text-center border border-line/60 rounded-lg bg-surface-2/20 space-y-1.5">
              <CheckCircle2 className="w-6 h-6 text-success mx-auto" />
              <div className="text-xs font-semibold text-ink">No Active System Alerts</div>
              <div className="text-2xs text-ink-3">All workspaces and channels are operating normally.</div>
            </div>
          ) : (
            <div className="divide-y divide-line/60 border border-line rounded-lg overflow-hidden bg-surface max-h-80 overflow-y-auto">
              {data.alerts.map((a, idx) => (
                <div key={idx} className="p-3 flex items-start gap-3 text-xs">
                  <AlertTriangle
                    className={cn(
                      'w-4 h-4 shrink-0 mt-0.5',
                      a.severity === 'high' ? 'text-danger' : 'text-warn'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-ink">{a.message}</div>
                    <div className="text-2xs text-ink-3 mt-0.5 flex items-center gap-2">
                      <span>{a.workspace_name}</span>
                      <span>&bull;</span>
                      <span>{new Date(a.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  {a.workspace_id && (
                    <Link
                      href={`/admin/workspaces/${a.workspace_id}`}
                      className="text-2xs text-accent hover:underline shrink-0"
                    >
                      View
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
