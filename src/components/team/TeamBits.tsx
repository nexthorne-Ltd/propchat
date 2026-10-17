'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getTeamAction, type TeamData } from '@/app/actions/team';
import { ROLE_LABELS, STATUS_LABELS, type AgentStatus, type Role } from '@/lib/team/permissions';
import { errorMessage } from '@/lib/errors/user-error';

/** Loads the team once and again on demand; actions hand back fresh data to `replace`. */
export function useTeam(workspaceId: string) {
  const [team, setTeam] = useState<TeamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getTeamAction(workspaceId)
      .then((data) => {
        if (cancelled) return;
        setTeam(data);
        setError(null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(errorMessage(e, 'Could not load the team.'));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, tick]);

  const reload = useCallback(() => {
    setError(null);
    setTeam(null);
    setTick((n) => n + 1);
  }, []);

  return { team, error, loading: !team && !error, reload, replace: setTeam };
}

export function TeamSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-xl border border-line bg-surface">
          <div className="skeleton w-9 h-9 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5 w-1/3" />
            <div className="skeleton h-3 w-1/2" />
          </div>
          <div className="skeleton h-7 w-20 hidden sm:block" />
        </div>
      ))}
    </div>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 p-4 rounded-xl border border-danger-line bg-danger-soft text-ui text-danger">
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn btn-sm btn-secondary shrink-0">
          <RefreshCw className="w-3.5 h-3.5" /> Try again
        </button>
      )}
    </div>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  const tone = role === 'owner' ? 'pill-accent' : role === 'admin' ? 'pill-success' : 'pill-neutral';
  return <span className={cn('pill', tone)}>{ROLE_LABELS[role]}</span>;
}

const DOT: Record<AgentStatus, string> = { online: 'bg-success', away: 'bg-warn', offline: 'bg-ink-3' };

export function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
      <span className={cn('w-2 h-2 rounded-full', DOT[status])} aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}
