'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Radio,
  Mail,
  Zap,
  Building2,
  ExternalLink,
  Clock,
  ShieldCheck,
  Server,
} from 'lucide-react';
import { getPlatformSystemHealthAction } from '@/app/actions/platform';
import { SystemHealthReport } from '@/types/database';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SkeletonBlock } from '@/components/ui/States';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';
import { VercelDomainsCard } from './VercelDomainsCard';

export function SystemHealthView() {
  const [data, setData] = useState<SystemHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const res = await getPlatformSystemHealthAction();
      setData(res);
    } catch (err: any) {
      setError(errorMessage(err, 'Failed to load system health report.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <SkeletonBlock className="h-8 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <SkeletonBlock className="h-72 rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
      <div className="card p-8 border border-line bg-surface text-center space-y-3">
        <AlertTriangle className="w-8 h-8 text-warn mx-auto" />
        <h3 className="text-sm font-bold text-ink">Failed to Load Health Diagnostics</h3>
        <p className="text-xs text-ink-3 max-w-md mx-auto">{error}</p>
        <Button variant="secondary" size="sm" onClick={() => loadData()}>
          Try Again
        </Button>
      </div>
      <VercelDomainsCard />
      </div>
    );
  }

  const totalFailures =
    data.channel_failures.length + data.email_issues.length + data.background_errors.length;
  const isHealthy = totalFailures === 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-ink tracking-tight">System Health & Diagnostics</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            Monitor real-time channel delivery, webhook events, email verification status, and automation queues.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-2xs text-ink-3">
            Last checked: {new Date(data.checked_at).toLocaleTimeString()}
          </span>
          <Button variant="secondary" size="sm" onClick={() => loadData(true)} loading={refreshing}>
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
            <span>Run Health Check</span>
          </Button>
        </div>
      </div>

      <VercelDomainsCard />

      {/* Global Status Banner */}
      <div
        className={cn(
          'p-4 rounded-xl border flex items-center justify-between gap-4 shadow-xs',
          isHealthy
            ? 'border-success/30 bg-success/10 text-ink'
            : 'border-warn/30 bg-warn/10 text-ink'
        )}
      >
        <div className="flex items-center gap-3">
          {isHealthy ? (
            <ShieldCheck className="w-6 h-6 text-success shrink-0" />
          ) : (
            <AlertTriangle className="w-6 h-6 text-warn shrink-0" />
          )}
          <div>
            <h3 className="text-sm font-bold">
              {isHealthy ? 'All Platform Channels & Services Operational' : 'Platform Warnings Detected'}
            </h3>
            <p className="text-xs text-ink-2 mt-0.5">
              {isHealthy
                ? 'Outbound queues, webhook pipelines, and email transports are functioning normally without errors.'
                : `${totalFailures} delivery or background job anomalies require review.`}
            </p>
          </div>
        </div>

        <Badge tone={isHealthy ? 'success' : 'warn'} className="uppercase">
          {isHealthy ? '100% Healthy' : `${totalFailures} Issues`}
        </Badge>
      </div>

      {/* 3 Metric Diagnostics Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* 1. Channel Outbound Queue */}
        <div className="card p-4 border border-line bg-surface shadow-xs space-y-1">
          <div className="flex items-center justify-between text-ink-3">
            <span className="text-2xs font-semibold uppercase tracking-wider">Channel Outbound</span>
            <Radio className="w-4 h-4 text-accent" />
          </div>
          <div className="text-2xl font-bold text-ink tabular-nums">
            {data.channel_failures.length}
          </div>
          <div className="text-2xs text-ink-3">Failed or retrying queue items</div>
        </div>

        {/* 2. Email Verification & Alerts */}
        <div className="card p-4 border border-line bg-surface shadow-xs space-y-1">
          <div className="flex items-center justify-between text-ink-3">
            <span className="text-2xs font-semibold uppercase tracking-wider">Email Delivery</span>
            <Mail className="w-4 h-4 text-accent" />
          </div>
          <div className="text-2xl font-bold text-ink tabular-nums">
            {data.email_issues.length}
          </div>
          <div className="text-2xs text-ink-3">Pending or delayed verifications</div>
        </div>

        {/* 3. Automation Job Failures */}
        <div className="card p-4 border border-line bg-surface shadow-xs space-y-1">
          <div className="flex items-center justify-between text-ink-3">
            <span className="text-2xs font-semibold uppercase tracking-wider">Automation Jobs</span>
            <Zap className="w-4 h-4 text-accent" />
          </div>
          <div className="text-2xl font-bold text-ink tabular-nums">
            {data.background_errors.length}
          </div>
          <div className="text-2xs text-ink-3">Rule outbox dispatch failures</div>
        </div>
      </div>

      {/* Section 1: Channel Queue Failures */}
      <section className="card p-5 border border-line bg-surface shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <Radio className="w-4 h-4 text-accent" />
              <span>Channel Outbound Queue & Webhooks</span>
            </h3>
            <p className="text-xs text-ink-3 mt-0.5">
              WhatsApp, Instagram, and web channel dispatch failures with links to affected workspaces
            </p>
          </div>
          <Badge tone={data.channel_failures.length === 0 ? 'success' : 'warn'}>
            {data.channel_failures.length} issues
          </Badge>
        </div>

        {data.channel_failures.length === 0 ? (
          <div className="p-6 text-center border border-line/40 rounded-lg bg-surface-2/20 text-xs text-ink-3 space-y-1">
            <CheckCircle2 className="w-5 h-5 text-success mx-auto" />
            <div>No outbound channel dispatch failures recorded.</div>
          </div>
        ) : (
          <div className="divide-y divide-line/60 border border-line rounded-lg overflow-hidden bg-surface">
            {data.channel_failures.map((f) => (
              <div key={f.id} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink uppercase font-mono text-2xs px-1.5 py-0.5 rounded bg-surface-2 border border-line">
                      {f.channel}
                    </span>
                    <span className="font-medium text-danger">{f.error || 'Dispatch failed'}</span>
                  </div>
                  <div className="text-2xs text-ink-3 flex items-center gap-2">
                    <span>Attempts: {f.attempts}</span>
                    <span>&bull;</span>
                    <span>{new Date(f.created_at).toLocaleString()}</span>
                  </div>
                </div>

                <Link
                  href={`/admin/workspaces/${f.workspace_id}`}
                  className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline shrink-0"
                >
                  <Building2 className="w-3.5 h-3.5" />
                  <span>{f.workspace_name}</span>
                  <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 2: Email Transport Delivery Issues */}
      <section className="card p-5 border border-line bg-surface shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <Mail className="w-4 h-4 text-accent" />
              <span>Email Delivery & Verifications</span>
            </h3>
            <p className="text-xs text-ink-3 mt-0.5">
              Unverified custom email records or delayed transport verifications
            </p>
          </div>
          <Badge tone={data.email_issues.length === 0 ? 'success' : 'warn'}>
            {data.email_issues.length} issues
          </Badge>
        </div>

        {data.email_issues.length === 0 ? (
          <div className="p-6 text-center border border-line/40 rounded-lg bg-surface-2/20 text-xs text-ink-3 space-y-1">
            <CheckCircle2 className="w-5 h-5 text-success mx-auto" />
            <div>All email channels and verifications are verified.</div>
          </div>
        ) : (
          <div className="divide-y divide-line/60 border border-line rounded-lg overflow-hidden bg-surface">
            {data.email_issues.map((e) => (
              <div key={e.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                <div>
                  <div className="font-semibold text-ink">Pending Email Verification</div>
                  <div className="text-2xs text-ink-3 mt-0.5">
                    Logged: {new Date(e.created_at).toLocaleString()}
                  </div>
                </div>

                <Link
                  href={`/admin/workspaces/${e.workspace_id}`}
                  className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline shrink-0"
                >
                  <Building2 className="w-3.5 h-3.5" />
                  <span>{e.workspace_name}</span>
                  <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 3: Background Jobs & Automation */}
      <section className="card p-5 border border-line bg-surface shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <Zap className="w-4 h-4 text-accent" />
              <span>Background Automation Job Outbox</span>
            </h3>
            <p className="text-xs text-ink-3 mt-0.5">
              Automation rule execution errors, webhook triggers, and ticket SLA outbox failures
            </p>
          </div>
          <Badge tone={data.background_errors.length === 0 ? 'success' : 'warn'}>
            {data.background_errors.length} issues
          </Badge>
        </div>

        {data.background_errors.length === 0 ? (
          <div className="p-6 text-center border border-line/40 rounded-lg bg-surface-2/20 text-xs text-ink-3 space-y-1">
            <CheckCircle2 className="w-5 h-5 text-success mx-auto" />
            <div>No automation outbox errors detected.</div>
          </div>
        ) : (
          <div className="divide-y divide-line/60 border border-line rounded-lg overflow-hidden bg-surface">
            {data.background_errors.map((b) => (
              <div key={b.id} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                <div className="space-y-0.5 min-w-0">
                  <div className="font-semibold text-ink flex items-center gap-2">
                    <span className="font-mono text-2xs uppercase px-1.5 py-0.5 rounded bg-surface-2 border border-line">
                      {b.action_type}
                    </span>
                    <span className="text-danger truncate">{b.error || 'Job failed'}</span>
                  </div>
                  <div className="text-2xs text-ink-3">
                    Created: {new Date(b.created_at).toLocaleString()}
                  </div>
                </div>

                <Link
                  href={`/admin/workspaces/${b.workspace_id}`}
                  className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline shrink-0"
                >
                  <Building2 className="w-3.5 h-3.5" />
                  <span>{b.workspace_name}</span>
                  <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
