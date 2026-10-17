'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Users,
  Search,
  RefreshCw,
  UserX,
  UserCheck,
  Building2,
  ChevronLeft,
  ChevronRight,
  Shield,
} from 'lucide-react';
import {
  getPlatformUsersAction,
  deactivateUserAction,
  reactivateUserAction,
  PlatformUserItem,
} from '@/app/actions/platform';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { Modal } from '@/components/ui/Modal';
import { Table } from '@/components/ui/Table';
import { SkeletonBlock } from '@/components/ui/States';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

export function UsersView() {
  const toast = useToast();
  const searchParams = useSearchParams();
  const urlSearch = searchParams?.get('search') || '';

  // Users state
  const [users, setUsers] = useState<PlatformUserItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [search, setSearch] = useState(urlSearch);
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  // Confirmation Modals for Users
  const [targetUser, setTargetUser] = useState<PlatformUserItem | null>(null);
  const [showDeactivateModal, setShowDeactivateModal] = useState(false);
  const [showReactivateModal, setShowReactivateModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const loadUsers = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const res = await getPlatformUsersAction({
        search,
        role: roleFilter,
        status: statusFilter,
        page,
        pageSize: 15,
      });

      setUsers(res.users);
      setTotalCount(res.totalCount);
      setTotalPages(res.totalPages);
    } catch (err: any) {
      toast.error(errorMessage(err, 'Failed to load platform users.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Sync search param from URL when changed
  useEffect(() => {
    if (urlSearch && urlSearch !== search) {
      setSearch(urlSearch);
      setPage(1);
    }
  }, [urlSearch]);

  useEffect(() => {
    loadUsers();
  }, [page, roleFilter, statusFilter]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    loadUsers();
  };

  const handleConfirmDeactivate = async () => {
    if (!targetUser) return;
    setActionLoading(true);
    try {
      const res = await deactivateUserAction(targetUser.id);
      if (res.success) {
        toast.success(`Account for ${targetUser.name} deactivated.`);
        setShowDeactivateModal(false);
        setTargetUser(null);
        await loadUsers(true);
      } else {
        toast.error(res.error || 'Failed to deactivate account.');
      }
    } catch (err: any) {
      toast.error(errorMessage(err, 'Failed to deactivate account.'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmReactivate = async () => {
    if (!targetUser) return;
    setActionLoading(true);
    try {
      const res = await reactivateUserAction(targetUser.id);
      if (res.success) {
        toast.success(`Account for ${targetUser.name} reactivated.`);
        setShowReactivateModal(false);
        setTargetUser(null);
        await loadUsers(true);
      } else {
        toast.error(res.error || 'Failed to reactivate account.');
      }
    } catch (err: any) {
      toast.error(errorMessage(err, 'Failed to reactivate account.'));
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-ink tracking-tight">Platform Users Directory</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            Search and manage users across all workspaces, inspect membership, and control active status.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => loadUsers(true)}
            loading={refreshing}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* Filter / Search Bar */}
      <div className="card p-4 border border-line bg-surface shadow-xs space-y-3">
        <form onSubmit={handleSearchSubmit} className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by user name, email, or workspace..."
              className="w-full h-9 pl-9 pr-4 rounded-md border border-line bg-surface-2/40 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent"
            />
          </div>

          <select
            value={roleFilter}
            onChange={(e) => {
              setRoleFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 px-3 rounded-md border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
          >
            <option value="all">All Roles</option>
            <option value="owner">Owners</option>
            <option value="admin">Admins</option>
            <option value="agent">Agents</option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 px-3 rounded-md border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active Accounts</option>
            <option value="deactivated">Deactivated</option>
          </select>

          <Button type="submit" variant="primary" size="sm">
            <span>Filter</span>
          </Button>
        </form>

        <div className="flex items-center justify-between text-2xs text-ink-3 pt-1 border-t border-line/40">
          <span>Showing <strong className="text-ink">{users.length}</strong> of <strong className="text-ink">{totalCount}</strong> platform users</span>
          {(search || roleFilter !== 'all' || statusFilter !== 'all') && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setRoleFilter('all');
                setStatusFilter('all');
                setPage(1);
                loadUsers();
              }}
              className="text-accent hover:underline font-medium transition-colors"
            >
              Clear all filters
            </button>
          )}
        </div>
      </div>

      {/* Users Table */}
      <div className="card border border-line bg-surface shadow-xs overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <SkeletonBlock key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : users.length === 0 ? (
          <EmptyState
            type="no-search-results"
            title="No users found"
            description="Try adjusting your search criteria or clearing filters."
          />
        ) : (
          <Table>
            <thead>
              <tr className="border-b border-line bg-surface-2/60 text-2xs uppercase text-ink-3 font-semibold">
                <th className="p-3 text-left">User</th>
                <th className="p-3 text-left">Workspace</th>
                <th className="p-3 text-left">Role</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 text-left">Joined</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-ui">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-surface-3/50 transition-colors">
                  {/* User Profile */}
                  <td className="p-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar name={u.name} size="sm" />
                      <div className="min-w-0">
                        <div className="font-semibold text-ink truncate text-xs">{u.name}</div>
                        <div className="text-2xs text-ink-3 truncate">{u.email}</div>
                      </div>
                    </div>
                  </td>

                  {/* Workspace Link */}
                  <td className="p-3">
                    {u.workspace_id ? (
                      <Link
                        href={`/admin/workspaces/${u.workspace_id}`}
                        className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline truncate max-w-xs"
                      >
                        <Building2 className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{u.workspace_name || u.workspace_id}</span>
                      </Link>
                    ) : (
                      <span className="text-2xs text-ink-3 italic">Unassigned</span>
                    )}
                  </td>

                  {/* Role */}
                  <td className="p-3">
                    <Badge tone="neutral" className="uppercase text-2xs font-semibold">
                      {u.role}
                    </Badge>
                  </td>

                  {/* Status */}
                  <td className="p-3">
                    <Badge tone={u.is_active ? 'success' : 'warn'} className="text-2xs">
                      {u.is_active ? 'Active' : 'Deactivated'}
                    </Badge>
                  </td>

                  {/* Joined Date */}
                  <td className="p-3 text-2xs text-ink-3 whitespace-nowrap">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>

                  {/* Actions */}
                  <td className="p-3 text-right">
                    {u.is_active ? (
                      <Button
                        variant="danger"
                        size="xs"
                        onClick={() => {
                          setTargetUser(u);
                          setShowDeactivateModal(true);
                        }}
                        title="Deactivate account"
                      >
                        <UserX className="w-3.5 h-3.5" />
                        <span>Deactivate</span>
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => {
                          setTargetUser(u);
                          setShowReactivateModal(true);
                        }}
                        title="Reactivate account"
                      >
                        <UserCheck className="w-3.5 h-3.5 text-success" />
                        <span>Reactivate</span>
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between p-3.5 border-t border-line bg-surface-2/30 text-xs">
            <span className="text-ink-3">Page {page} of {totalPages}</span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Previous</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <span>Next</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Modal: Deactivate Tenant User */}
      <Modal
        open={showDeactivateModal}
        onClose={() => setShowDeactivateModal(false)}
        title="Deactivate User Account"
        description="Deactivating will prevent this user from signing in across all workspaces."
      >
        <div className="p-5 space-y-4">
          <p className="text-xs text-ink-2">
            Are you sure you want to deactivate <strong className="text-ink">{targetUser?.name}</strong> ({targetUser?.email})? They will lose access to all tickets and workspace features immediately.
          </p>
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-line">
            <Button variant="ghost" size="sm" onClick={() => setShowDeactivateModal(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={actionLoading} onClick={handleConfirmDeactivate}>
              <UserX className="w-3.5 h-3.5" />
              <span>Confirm Deactivation</span>
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal: Reactivate Tenant User */}
      <Modal
        open={showReactivateModal}
        onClose={() => setShowReactivateModal(false)}
        title="Reactivate User Account"
        description="Reactivating will restore sign-in access for this user."
      >
        <div className="p-5 space-y-4">
          <p className="text-xs text-ink-2">
            Restore sign-in access for <strong className="text-ink">{targetUser?.name}</strong> ({targetUser?.email})?
          </p>
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-line">
            <Button variant="ghost" size="sm" onClick={() => setShowReactivateModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={actionLoading} onClick={handleConfirmReactivate}>
              <UserCheck className="w-3.5 h-3.5" />
              <span>Confirm Reactivation</span>
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
