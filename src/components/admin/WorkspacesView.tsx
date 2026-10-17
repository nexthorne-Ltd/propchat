'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Building2,
  Search,
  Filter,
  RefreshCw,
  PauseCircle,
  PlayCircle,
  Eye,
  Globe,
  Mail,
  Clock,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Layers,
  Megaphone,
  Sliders,
  CreditCard,
  CheckSquare,
  Square,
} from 'lucide-react';
import {
  getPlatformWorkspacesTableAction,
  suspendWorkspaceAction,
  reactivateWorkspaceAction,
  PlatformWorkspaceItem,
} from '@/app/actions/platform';
import {
  adminBulkChangePlanAction,
  adminBulkSuspendAction,
  adminBulkToggleFeatureAction,
  adminBulkSendAnnouncementAction,
} from '@/app/actions/platform-control';
import { getPlatformPlansAction } from '@/app/actions/plans';
import { PLAN_FEATURES, PlanFeatureKey } from '@/lib/plans/features';
import { PlatformPlan } from '@/types/plans';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Table, SortHeader } from '@/components/ui/Table';
import { SkeletonBlock } from '@/components/ui/States';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

export function WorkspacesView() {
  const toast = useToast();

  const [workspaces, setWorkspaces] = useState<PlatformWorkspaceItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters & sorting
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended'>('all');
  const [channelFilter, setChannelFilter] = useState('all');
  const [planFilter, setPlanFilter] = useState('all');
  const [sortField, setSortField] = useState<'name' | 'created_at' | 'tickets_30d_count' | 'agents_count' | 'last_activity_at'>('created_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Confirmation Modals
  const [targetWorkspace, setTargetWorkspace] = useState<PlatformWorkspaceItem | null>(null);
  const [showSuspendModal, setShowSuspendModal] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [showReactivateModal, setShowReactivateModal] = useState(false);

  // Bulk Selection & Actions (Requirement E)
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [availablePlans, setAvailablePlans] = useState<PlatformPlan[]>([]);

  const [bulkPlanModalOpen, setBulkPlanModalOpen] = useState(false);
  const [bulkTargetPlan, setBulkTargetPlan] = useState('');

  const [bulkSuspendModalOpen, setBulkSuspendModalOpen] = useState(false);
  const [bulkSuspendReason, setBulkSuspendReason] = useState('');
  const [bulkSuspendActionType, setBulkSuspendActionType] = useState<'suspend' | 'reactivate'>('suspend');

  const [bulkFeatureModalOpen, setBulkFeatureModalOpen] = useState(false);
  const [bulkFeatureKey, setBulkFeatureKey] = useState<PlanFeatureKey>('ai_bot');
  const [bulkFeatureEnabled, setBulkFeatureEnabled] = useState(true);

  const [bulkAnnounceModalOpen, setBulkAnnounceModalOpen] = useState(false);
  const [bulkAnnounceTitle, setBulkAnnounceTitle] = useState('');
  const [bulkAnnounceMessage, setBulkAnnounceMessage] = useState('');
  const [bulkAnnounceTone, setBulkAnnounceTone] = useState<'info' | 'warning' | 'success' | 'urgent'>('info');

  const [bulkLoading, setBulkLoading] = useState(false);

  const loadData = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const res = await getPlatformWorkspacesTableAction({
        search,
        status: statusFilter,
        channel: channelFilter,
        plan: planFilter,
        sort: sortField,
        order: sortOrder,
        page,
        pageSize: 15,
      });

      setWorkspaces(res.workspaces);
      setTotalCount(res.totalCount);
      setTotalPages(res.totalPages);
    } catch (err: any) {
      setError(errorMessage(err, 'Failed to fetch workspaces.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [page, statusFilter, channelFilter, planFilter, sortField, sortOrder]);

  useEffect(() => {
    getPlatformPlansAction().then((res) => {
      setAvailablePlans(res.plans);
      if (res.plans.length > 0) setBulkTargetPlan(res.plans[0].id);
    });
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    loadData();
  };

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const handleConfirmSuspend = async () => {
    if (!targetWorkspace) return;
    setActionLoading(true);
    try {
      await suspendWorkspaceAction(targetWorkspace.id, suspendReason);
      toast.success(`Suspended ${targetWorkspace.name}`);
      setShowSuspendModal(false);
      setTargetWorkspace(null);
      setSuspendReason('');
      loadData(true);
    } catch (err: any) {
      toast.error(errorMessage(err, 'Failed to suspend workspace'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmReactivate = async () => {
    if (!targetWorkspace) return;
    setActionLoading(true);
    try {
      await reactivateWorkspaceAction(targetWorkspace.id);
      toast.success(`Reactivated ${targetWorkspace.name}`);
      setShowReactivateModal(false);
      setTargetWorkspace(null);
      loadData(true);
    } catch (err: any) {
      toast.error(errorMessage(err, 'Failed to reactivate workspace'));
    } finally {
      setActionLoading(false);
    }
  };

  // Bulk Actions
  const handleBulkChangePlan = async () => {
    if (selectedIds.length === 0 || !bulkTargetPlan) return;
    setBulkLoading(true);
    try {
      const res = await adminBulkChangePlanAction(selectedIds, bulkTargetPlan);
      if (res.success) {
        toast.success(`Changed plan for ${res.count} workspaces.`);
        setBulkPlanModalOpen(false);
        setSelectedIds([]);
        loadData(true);
      } else toast.error(res.error || 'Failed.');
    } catch (err: any) {
      toast.error(errorMessage(err, 'Failed to bulk change plans.'));
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkSuspend = async () => {
    if (selectedIds.length === 0) return;
    setBulkLoading(true);
    try {
      const suspend = bulkSuspendActionType === 'suspend';
      const res = await adminBulkSuspendAction(selectedIds, suspend, bulkSuspendReason || 'Bulk action');
      if (res.success) {
        toast.success(`${suspend ? 'Suspended' : 'Reactivated'} ${res.count} workspaces.`);
        setBulkSuspendModalOpen(false);
        setSelectedIds([]);
        loadData(true);
      } else toast.error(res.error || 'Failed.');
    } catch (err: any) {
      toast.error(errorMessage(err, 'Failed.'));
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkToggleFeature = async () => {
    if (selectedIds.length === 0) return;
    setBulkLoading(true);
    try {
      const res = await adminBulkToggleFeatureAction(selectedIds, bulkFeatureKey, bulkFeatureEnabled);
      if (res.success) {
        toast.success(`Updated feature for ${res.count} workspaces.`);
        setBulkFeatureModalOpen(false);
        setSelectedIds([]);
        loadData(true);
      } else toast.error(res.error || 'Failed.');
    } catch (err: any) {
      toast.error(errorMessage(err, 'Failed.'));
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkSendAnnouncement = async () => {
    if (selectedIds.length === 0 || !bulkAnnounceTitle.trim() || !bulkAnnounceMessage.trim()) return;
    setBulkLoading(true);
    try {
      const res = await adminBulkSendAnnouncementAction(selectedIds, {
        title: bulkAnnounceTitle.trim(),
        message: bulkAnnounceMessage.trim(),
        tone: bulkAnnounceTone,
      });
      if (res.success) {
        toast.success(`Announcement broadcasted to ${selectedIds.length} workspaces.`);
        setBulkAnnounceModalOpen(false);
        setSelectedIds([]);
        setBulkAnnounceTitle('');
        setBulkAnnounceMessage('');
      } else toast.error(res.error || 'Failed.');
    } catch (err: any) {
      toast.error(errorMessage(err, 'Failed.'));
    } finally {
      setBulkLoading(false);
    }
  };

  const allSelected = workspaces.length > 0 && selectedIds.length === workspaces.length;

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-lg font-bold text-ink tracking-tight flex items-center gap-2">
              <span>Workspaces Directory</span>
              <Badge tone="accent" className="text-2xs font-mono">{totalCount}</Badge>
            </h2>
          </div>
          <p className="text-xs text-ink-3 mt-1">
            Browse, inspect, and manage workspaces, team rosters, limits, and customer communications.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => loadData(true)}
            disabled={loading || refreshing}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* Bulk Action Sticky Bar (Requirement E) */}
      {selectedIds.length > 0 && (
        <div className="bg-accent/10 border border-accent/20 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 animate-in fade-in">
          <div className="flex items-center gap-2">
            <Badge tone="accent">{selectedIds.length} Workspaces Selected</Badge>
            <span className="text-xs text-ink-2 font-medium">Bulk Operations:</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="secondary" onClick={() => setBulkPlanModalOpen(true)}>
              <CreditCard className="w-3 h-3 mr-1 text-accent" />
              <span>Change Plan</span>
            </Button>
            <Button size="xs" variant="secondary" onClick={() => setBulkSuspendModalOpen(true)}>
              <PauseCircle className="w-3 h-3 mr-1 text-warn" />
              <span>Suspend / Reactivate</span>
            </Button>
            <Button size="xs" variant="secondary" onClick={() => setBulkFeatureModalOpen(true)}>
              <Sliders className="w-3 h-3 mr-1 text-accent" />
              <span>Toggle Feature</span>
            </Button>
            <Button size="xs" variant="secondary" onClick={() => setBulkAnnounceModalOpen(true)}>
              <Megaphone className="w-3 h-3 mr-1 text-accent" />
              <span>Broadcast Announcement</span>
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setSelectedIds([])}>
              Deselect
            </Button>
          </div>
        </div>
      )}

      {/* Filters Toolbar */}
      <div className="card p-4 border border-line bg-surface shadow-xs space-y-4">
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          <form onSubmit={handleSearchSubmit} className="flex-1 max-w-md relative">
            <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              className="input input-sm w-full pl-9 pr-4 text-xs"
              placeholder="Search workspaces by name, domain, or owner email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              className="input input-sm text-xs py-1"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as any);
                setPage(1);
              }}
            >
              <option value="all">All Statuses</option>
              <option value="active">Active Only</option>
              <option value="suspended">Suspended Only</option>
            </select>

            <select
              className="input input-sm text-xs py-1"
              value={planFilter}
              onChange={(e) => {
                setPlanFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">All Plans</option>
              <option value="starter">Starter</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
              <option value="legacy">Legacy</option>
            </select>
          </div>
        </div>
      </div>

      {/* Workspaces Table */}
      <div className="card border border-line bg-surface shadow-xs overflow-hidden">
        {loading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonBlock key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : workspaces.length === 0 ? (
          <EmptyState
            type="custom"
            title="No workspaces match your filters"
            description="Try modifying or clearing your search criteria to view workspaces."
            actionLabel="Reset All Filters"
            onAction={() => {
              setSearch('');
              setStatusFilter('all');
              setChannelFilter('all');
              setPlanFilter('all');
              setPage(1);
            }}
          />
        ) : (
          <Table>
            <thead>
              <tr className="border-b border-line bg-surface-2/60 text-2xs uppercase text-ink-3 font-semibold">
                <th className="p-3 text-left w-10">
                  <input
                    type="checkbox"
                    className="rounded border-line text-accent focus:ring-accent"
                    checked={allSelected}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedIds(workspaces.map((w) => w.id));
                      else setSelectedIds([]);
                    }}
                  />
                </th>
                <SortHeader
                  label="Workspace"
                  active={sortField === 'name'}
                  direction={sortOrder}
                  onSort={() => handleSort('name')}
                />
                <th className="p-3 text-left">Owner</th>
                <th className="p-3 text-left">Status</th>
                <SortHeader
                  label="Agents"
                  active={sortField === 'agents_count'}
                  direction={sortOrder}
                  onSort={() => handleSort('agents_count')}
                />
                <SortHeader
                  label="Tickets (30d)"
                  active={sortField === 'tickets_30d_count'}
                  direction={sortOrder}
                  onSort={() => handleSort('tickets_30d_count')}
                />
                <SortHeader
                  label="Created"
                  active={sortField === 'created_at'}
                  direction={sortOrder}
                  onSort={() => handleSort('created_at')}
                />
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-ui">
              {workspaces.map((w) => {
                const isSelected = selectedIds.includes(w.id);
                return (
                  <tr key={w.id} className={cn('hover:bg-surface-3/50 transition-colors', isSelected && 'bg-accent/5')}>
                    <td className="p-3">
                      <input
                        type="checkbox"
                        className="rounded border-line text-accent focus:ring-accent"
                        checked={isSelected}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedIds([...selectedIds, w.id]);
                          else setSelectedIds(selectedIds.filter((id) => id !== w.id));
                        }}
                      />
                    </td>

                    {/* Name */}
                    <td className="p-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-white font-bold text-xs shrink-0"
                          style={{ backgroundColor: w.brand_color }}
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
                          {w.website_url ? (
                            <span className="text-2xs text-ink-3 truncate block">
                              {w.website_url.replace(/^https?:\/\//, '')}
                            </span>
                          ) : (
                            <span className="text-2xs text-ink-3 italic block">No domain</span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Owner */}
                    <td className="p-3 text-ink-2 truncate max-w-xs">
                      {w.owner_email || <span className="italic text-ink-3">None</span>}
                    </td>

                    {/* Status & Plan */}
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <Badge tone={w.is_suspended ? 'danger' : 'success'} className="text-2xs capitalize">
                          {w.is_suspended ? 'Suspended' : 'Active'}
                        </Badge>
                        <Badge tone="neutral" className="text-2xs capitalize font-mono">
                          {w.plan || 'starter'}
                        </Badge>
                      </div>
                    </td>

                    {/* Agents */}
                    <td className="p-3 font-medium text-ink">
                      {w.agents_count}
                    </td>

                    {/* Tickets */}
                    <td className="p-3 font-medium text-ink">
                      {w.tickets_30d_count}
                    </td>

                    {/* Created */}
                    <td className="p-3 text-ink-3 text-2xs">
                      {new Date(w.created_at).toLocaleDateString()}
                    </td>

                    {/* Actions */}
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Link
                          href={`/admin/workspaces/${w.id}`}
                          className="btn btn-secondary btn-xs inline-flex items-center gap-1"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Control</span>
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-ink-3 pt-2">
          <span>Page {page} of {totalPages}</span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="xs"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Modal: Bulk Change Plan */}
      <Modal open={bulkPlanModalOpen} onClose={() => setBulkPlanModalOpen(false)} title="Bulk Change Plan">
        <div className="space-y-4">
          <p className="text-xs text-ink-3">
            Change subscription plan for <strong className="text-ink">{selectedIds.length}</strong> selected workspaces.
          </p>
          <div>
            <label className="text-xs font-medium text-ink-2">Select Target Plan</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={bulkTargetPlan}
              onChange={(e) => setBulkTargetPlan(e.target.value)}
            >
              {availablePlans.map((p) => (
                <option key={p.id} value={p.id}>{p.name} (${p.monthly_price}/mo)</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-line">
            <Button variant="secondary" size="sm" onClick={() => setBulkPlanModalOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm" loading={bulkLoading} onClick={handleBulkChangePlan}>Apply to Selected</Button>
          </div>
        </div>
      </Modal>

      {/* Modal: Bulk Suspend / Reactivate */}
      <Modal open={bulkSuspendModalOpen} onClose={() => setBulkSuspendModalOpen(false)} title="Bulk Suspend / Reactivate">
        <div className="space-y-4">
          <p className="text-xs text-ink-3">
            Modify status for <strong className="text-ink">{selectedIds.length}</strong> selected workspaces.
          </p>
          <div>
            <label className="text-xs font-medium text-ink-2">Action Type</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={bulkSuspendActionType}
              onChange={(e) => setBulkSuspendActionType(e.target.value as any)}
            >
              <option value="suspend">Suspend Workspaces</option>
              <option value="reactivate">Reactivate Workspaces</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-ink-2">Reason</label>
            <input
              type="text"
              className="input input-sm w-full mt-1.5"
              placeholder="e.g. Terms update, payment verification"
              value={bulkSuspendReason}
              onChange={(e) => setBulkSuspendReason(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-line">
            <Button variant="secondary" size="sm" onClick={() => setBulkSuspendModalOpen(false)}>Cancel</Button>
            <Button
              variant={bulkSuspendActionType === 'suspend' ? 'danger' : 'primary'}
              size="sm"
              loading={bulkLoading}
              onClick={handleBulkSuspend}
            >
              Confirm Bulk Action
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal: Bulk Feature Toggle */}
      <Modal open={bulkFeatureModalOpen} onClose={() => setBulkFeatureModalOpen(false)} title="Bulk Toggle Feature">
        <div className="space-y-4">
          <p className="text-xs text-ink-3">
            Enable or disable a feature for <strong className="text-ink">{selectedIds.length}</strong> selected workspaces.
          </p>
          <div>
            <label className="text-xs font-medium text-ink-2">Feature</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={bulkFeatureKey}
              onChange={(e) => setBulkFeatureKey(e.target.value as any)}
            >
              {PLAN_FEATURES.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-ink-2">New State</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={bulkFeatureEnabled ? 'enable' : 'disable'}
              onChange={(e) => setBulkFeatureEnabled(e.target.value === 'enable')}
            >
              <option value="enable">Force Enable</option>
              <option value="disable">Force Disable</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-line">
            <Button variant="secondary" size="sm" onClick={() => setBulkFeatureModalOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm" loading={bulkLoading} onClick={handleBulkToggleFeature}>Apply Feature Override</Button>
          </div>
        </div>
      </Modal>

      {/* Modal: Bulk Send Announcement */}
      <Modal open={bulkAnnounceModalOpen} onClose={() => setBulkAnnounceModalOpen(false)} title="Broadcast Announcement">
        <div className="space-y-4">
          <p className="text-xs text-ink-3">
            Broadcast banner announcement to <strong className="text-ink">{selectedIds.length}</strong> selected workspaces.
          </p>
          <div>
            <label className="text-xs font-medium text-ink-2">Title</label>
            <input
              type="text"
              className="input input-sm w-full mt-1.5"
              placeholder="e.g. Scheduled Platform Maintenance"
              value={bulkAnnounceTitle}
              onChange={(e) => setBulkAnnounceTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-ink-2">Message</label>
            <textarea
              className="input input-sm w-full mt-1.5 h-20 py-2"
              placeholder="Write announcement message..."
              value={bulkAnnounceMessage}
              onChange={(e) => setBulkAnnounceMessage(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-ink-2">Tone</label>
            <select
              className="input input-sm w-full mt-1.5"
              value={bulkAnnounceTone}
              onChange={(e) => setBulkAnnounceTone(e.target.value as any)}
            >
              <option value="info">Info (Blue)</option>
              <option value="warning">Warning (Amber)</option>
              <option value="success">Success (Green)</option>
              <option value="urgent">Urgent (Red)</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-line">
            <Button variant="secondary" size="sm" onClick={() => setBulkAnnounceModalOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm" loading={bulkLoading} onClick={handleBulkSendAnnouncement}>Send Announcement</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
