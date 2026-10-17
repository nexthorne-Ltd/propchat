'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  ShieldAlert,
  Search,
  Filter,
  RefreshCw,
  Clock,
  Building2,
  ChevronDown,
  ChevronRight,
  User,
  PlusCircle,
  PauseCircle,
  PlayCircle,
  FileText,
  Eye,
  CheckCircle2,
} from 'lucide-react';
import { getSuperAdminAuditLogsAction } from '@/app/actions/platform';
import { SuperAdminAuditLog } from '@/types/database';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Table } from '@/components/ui/Table';
import { SkeletonBlock } from '@/components/ui/States';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

export function AuditLogView() {
  const [logs, setLogs] = useState<SuperAdminAuditLog[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchLogs = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const res = await getSuperAdminAuditLogsAction({
        actionFilter: actionFilter === 'all' ? undefined : actionFilter,
        limit: 100,
      });
      setLogs(res.logs || []);
      setTotalCount(res.totalCount || 0);
    } catch (err: any) {
      setError(errorMessage(err, 'Failed to load audit logs.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [actionFilter]);

  const filteredLogs = logs.filter((log) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase().trim();
    return (
      log.admin_email.toLowerCase().includes(q) ||
      (log.admin_name && log.admin_name.toLowerCase().includes(q)) ||
      (log.workspace_name && log.workspace_name.toLowerCase().includes(q)) ||
      (log.workspace_id && log.workspace_id.toLowerCase().includes(q)) ||
      log.action.toLowerCase().includes(q)
    );
  });

  const getActionBadge = (action: string) => {
    switch (action) {
      case 'suspend_workspace':
        return (
          <Badge tone="danger" className="text-2xs uppercase">
            Suspend Workspace
          </Badge>
        );
      case 'reactivate_workspace':
        return (
          <Badge tone="success" className="text-2xs uppercase">
            Reactivate Workspace
          </Badge>
        );
      case 'deactivate_user':
        return (
          <Badge tone="warn" className="text-2xs uppercase">
            Deactivate User
          </Badge>
        );
      case 'reactivate_user':
        return (
          <Badge tone="success" className="text-2xs uppercase">
            Reactivate User
          </Badge>
        );
      case 'add_workspace_note':
        return (
          <Badge tone="accent" className="text-2xs uppercase">
            Owner Note
          </Badge>
        );
      case 'view_workspace_detail':
        return (
          <Badge tone="neutral" className="text-2xs uppercase">
            View Detail
          </Badge>
        );
      default:
        return (
          <Badge tone="neutral" className="text-2xs uppercase font-mono">
            {action.replace(/_/g, ' ')}
          </Badge>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-ink tracking-tight">Super Admin Audit Trail</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            Immutable log of all platform administrator actions, timestamps, and target workspace events.
          </p>
        </div>

        <Button variant="secondary" size="sm" onClick={() => fetchLogs(true)} loading={refreshing}>
          <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          <span>Refresh Logs</span>
        </Button>
      </div>

      {/* Filter / Search Bar */}
      <div className="card p-4 border border-line bg-surface shadow-xs space-y-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by admin email, workspace name, or action..."
              className="w-full h-9 pl-9 pr-4 rounded-md border border-line bg-surface-2/40 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent"
            />
          </div>

          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="h-9 px-3 rounded-md border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
          >
            <option value="all">All Action Types</option>
            <option value="suspend_workspace">Suspend Workspace</option>
            <option value="reactivate_workspace">Reactivate Workspace</option>
            <option value="deactivate_user">Deactivate User</option>
            <option value="reactivate_user">Reactivate User</option>
            <option value="add_workspace_note">Owner Note</option>
            <option value="view_workspace_detail">View Detail</option>
          </select>
        </div>

        <div className="flex items-center justify-between text-2xs text-ink-3 pt-1 border-t border-line/40">
          <span>
            Showing <strong className="text-ink">{filteredLogs.length}</strong> of{' '}
            <strong className="text-ink">{totalCount}</strong> recorded events
          </span>
          {search && (
            <button onClick={() => setSearch('')} className="text-accent hover:underline">
              Clear search
            </button>
          )}
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="card border border-line bg-surface shadow-xs overflow-hidden">
        {loading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonBlock key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : filteredLogs.length === 0 ? (
          <EmptyState
            type="custom"
            title="No audit events found"
            description="No actions matched the current filter criteria."
          />
        ) : (
          <Table>
            <thead>
              <tr className="border-b border-line bg-surface-2/60 text-2xs uppercase text-ink-3 font-semibold">
                <th className="p-3 text-left">Timestamp</th>
                <th className="p-3 text-left">Admin Operator</th>
                <th className="p-3 text-left">Action</th>
                <th className="p-3 text-left">Target Workspace</th>
                <th className="p-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-ui">
              {filteredLogs.map((log) => {
                const isExpanded = expandedId === log.id;
                const hasDetails = log.details && Object.keys(log.details).length > 0;

                return (
                  <React.Fragment key={log.id}>
                    <tr
                      className={cn(
                        'hover:bg-surface-3/50 transition-colors cursor-pointer',
                        isExpanded && 'bg-surface-3/40'
                      )}
                      onClick={() => setExpandedId(isExpanded ? null : log.id)}
                    >
                      {/* Timestamp */}
                      <td className="p-3 text-2xs text-ink-3 whitespace-nowrap">
                        {new Date(log.created_at).toLocaleString()}
                      </td>

                      {/* Admin Operator */}
                      <td className="p-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <User className="w-3.5 h-3.5 text-accent shrink-0" />
                          <div className="min-w-0">
                            <span className="font-semibold text-ink truncate block text-xs">
                              {log.admin_name || log.admin_email}
                            </span>
                            {log.admin_name && (
                              <span className="text-2xs text-ink-3 truncate block">
                                {log.admin_email}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Action Badge */}
                      <td className="p-3">{getActionBadge(log.action)}</td>

                      {/* Target Workspace */}
                      <td className="p-3">
                        {log.workspace_id ? (
                          <Link
                            href={`/admin/workspaces/${log.workspace_id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline truncate max-w-xs"
                          >
                            <Building2 className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{log.workspace_name || log.workspace_id}</span>
                          </Link>
                        ) : (
                          <span className="text-2xs text-ink-3 italic">Platform-wide</span>
                        )}
                      </td>

                      {/* Details toggle */}
                      <td className="p-3 text-right">
                        {hasDetails ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedId(isExpanded ? null : log.id);
                            }}
                            className="inline-flex items-center gap-1 text-2xs text-ink-3 hover:text-ink font-medium"
                          >
                            <span>{isExpanded ? 'Hide Details' : 'View Diff'}</span>
                            {isExpanded ? (
                              <ChevronDown className="w-3 h-3" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                          </button>
                        ) : (
                          <span className="text-2xs text-ink-3 italic">None</span>
                        )}
                      </td>
                    </tr>

                    {/* Expandable JSON Diff Details */}
                    {isExpanded && hasDetails && (
                      <tr className="bg-surface-2/40 border-b border-line">
                        <td colSpan={5} className="p-4">
                          <div className="space-y-1.5">
                            <div className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                              Audit Event Metadata & Parameters
                            </div>
                            <pre className="p-3 rounded-lg bg-surface border border-line text-2xs font-mono text-ink overflow-x-auto whitespace-pre-wrap">
                              {JSON.stringify(log.details, null, 2)}
                            </pre>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}
