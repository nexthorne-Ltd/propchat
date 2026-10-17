'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  ShieldCheck,
  UserPlus,
  Trash2,
  KeyRound,
  Lock,
  Search,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Clock,
  Mail,
  Copy,
  Check,
  RotateCcw,
  Ban,
  Send,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import {
  getPlatformAccessListAction,
  inviteOrGrantAdminAction,
  getAdminInvitesAction,
  resendAdminInviteAction,
  revokeAdminInviteAction,
  revokeAdminAccessAction,
} from '@/app/actions/platform';
import { PlatformAccessMember, AdminInviteItem, PlatformAccessRole } from '@/types/database';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

function formatExpiryTime(isoString: string): string {
  const diff = new Date(isoString).getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `Expires in ${days}d ${hours % 24}h`;
  }
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `Expires in ${hours}h ${minutes}m`;
}

export function AdminAccessView() {
  const toast = useToast();

  const [members, setMembers] = useState<PlatformAccessMember[]>([]);
  const [invites, setInvites] = useState<AdminInviteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search filter
  const [search, setSearch] = useState('');

  // Give access modal state
  const [giveModalOpen, setGiveModalOpen] = useState(false);
  const [grantEmail, setGrantEmail] = useState('');
  const [grantRole, setGrantRole] = useState<PlatformAccessRole>('admin');
  const [grantLoading, setGrantLoading] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [lastCreatedInviteUrl, setLastCreatedInviteUrl] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Remove access modal state
  const [removeTarget, setRemoveTarget] = useState<PlatformAccessMember | null>(null);
  const [removeLoading, setRemoveLoading] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Invite action loading states
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [membersRes, invitesRes] = await Promise.all([
        getPlatformAccessListAction(),
        getAdminInvitesAction(),
      ]);

      if (!membersRes.success) {
        setError(membersRes.error || 'Failed to load access list.');
      } else {
        setMembers(membersRes.members || []);
      }

      if (invitesRes.success) {
        setInvites(invitesRes.invites || []);
      }
    } catch (err: unknown) {
      setError(
        errorMessage(err, 'Failed to load platform access members.')
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  // Handle Send Invite / Grant Access
  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = grantEmail.trim().toLowerCase();
    if (!cleanEmail) {
      setGrantError('Please enter an email address.');
      return;
    }

    setGrantLoading(true);
    setGrantError(null);
    setLastCreatedInviteUrl(null);
    setCopiedUrl(false);

    try {
      const res = await inviteOrGrantAdminAction({
        email: cleanEmail,
        role: grantRole,
      });

      if (!res.success) {
        setGrantError(res.error || 'Failed to process admin access request.');
      } else {
        if (res.grantedDirectly) {
          toast.success(`Admin access granted directly to ${cleanEmail}. Notification email sent.`);
          setGiveModalOpen(false);
          setGrantEmail('');
          setGrantRole('admin');
        } else {
          toast.success(`Invitation created for ${cleanEmail}. Link expires in 48 hours.`);
          if (res.invite?.invite_url) {
            setLastCreatedInviteUrl(res.invite.invite_url);
          } else {
            setGiveModalOpen(false);
            setGrantEmail('');
            setGrantRole('admin');
          }
        }
        await fetchData();
      }
    } catch (err: unknown) {
      setGrantError(
        errorMessage(err, 'An unexpected error occurred.')
      );
    } finally {
      setGrantLoading(false);
    }
  };

  // Handle Resend Invite
  const handleResendInvite = async (inviteId: string) => {
    setResendingId(inviteId);
    try {
      const res = await resendAdminInviteAction(inviteId);
      if (!res.success) {
        toast.error(res.error || 'Failed to resend invitation.');
      } else {
        toast.success('Invitation resent with fresh 48-hour link.');
        if (res.invite_url) {
          await navigator.clipboard.writeText(res.invite_url);
          toast.success('Invite link copied to clipboard!');
        }
        await fetchData();
      }
    } catch (err: unknown) {
      toast.error(
        errorMessage(err, 'Failed to resend invitation.')
      );
    } finally {
      setResendingId(null);
    }
  };

  // Handle Revoke Invite
  const handleRevokeInvite = async (inviteId: string) => {
    setRevokingId(inviteId);
    try {
      const res = await revokeAdminInviteAction(inviteId);
      if (!res.success) {
        toast.error(res.error || 'Failed to revoke invitation.');
      } else {
        toast.success('Invitation revoked.');
        await fetchData();
      }
    } catch (err: unknown) {
      toast.error(
        errorMessage(err, 'Failed to revoke invitation.')
      );
    } finally {
      setRevokingId(null);
    }
  };

  // Handle Revoke Granted Access
  const handleRevokeAccess = async () => {
    if (!removeTarget) return;

    setRemoveLoading(true);
    setRemoveError(null);

    try {
      const res = await revokeAdminAccessAction(removeTarget.user_id);
      if (!res.success) {
        setRemoveError(res.error || 'Failed to revoke admin access.');
      } else {
        toast.success(`Revoked admin privileges for ${removeTarget.email}.`);
        setRemoveTarget(null);
        await fetchData();
      }
    } catch (err: unknown) {
      setRemoveError(
        errorMessage(err, 'Failed to revoke access.')
      );
    } finally {
      setRemoveLoading(false);
    }
  };

  const filteredMembers = members.filter((m) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase().trim();
    return (
      m.email.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      m.role.toLowerCase().includes(q)
    );
  });

  const filteredInvites = invites.filter((inv) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase().trim();
    return (
      inv.email.toLowerCase().includes(q) ||
      inv.role.toLowerCase().includes(q) ||
      inv.status.toLowerCase().includes(q)
    );
  });

  const ownerMember = members.find((m) => m.role === 'owner');
  const adminCount = members.filter((m) => m.role === 'admin').length;
  const pendingInvitesCount = invites.filter((i) => i.status === 'pending').length;

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <div className="bg-surface border border-line rounded-2xl p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink tracking-tight flex items-center gap-2">
                <span>Admin Access Control</span>
                <Badge tone="accent" className="text-2xs uppercase">
                  Owner Only
                </Badge>
              </h2>
              <p className="text-xs text-ink-3">
                Manage who has access to the ZenTry platform administration panel. Only the platform owner can send invites or grant access.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchData}
            disabled={loading}
            title="Refresh access list"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setGrantError(null);
              setGrantEmail('');
              setGrantRole('admin');
              setLastCreatedInviteUrl(null);
              setGiveModalOpen(true);
            }}
          >
            <UserPlus className="w-4 h-4 mr-1.5" />
            <span>Send Invite</span>
          </Button>
        </div>
      </div>

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl border border-line bg-surface space-y-1">
          <div className="text-2xs font-semibold uppercase tracking-wider text-ink-3 flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-accent" />
            <span>Platform Owner</span>
          </div>
          <div className="text-sm font-bold text-ink truncate">
            {ownerMember?.email || 'zentry385@gmail.com'}
          </div>
          <div className="text-2xs text-ink-3 flex items-center gap-1">
            <Lock className="w-3 h-3 text-warn" />
            <span>Permanent Root • Non-removable</span>
          </div>
        </div>

        <div className="p-4 rounded-xl border border-line bg-surface space-y-1">
          <div className="text-2xs font-semibold uppercase tracking-wider text-ink-3 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-accent" />
            <span>Active Administrators</span>
          </div>
          <div className="text-xl font-bold text-ink">
            {adminCount}
          </div>
          <div className="text-2xs text-ink-3">
            Operational super admins with platform panel access
          </div>
        </div>

        <div className="p-4 rounded-xl border border-line bg-surface space-y-1">
          <div className="text-2xs font-semibold uppercase tracking-wider text-ink-3 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-accent" />
            <span>Pending Invites</span>
          </div>
          <div className="text-xl font-bold text-ink">
            {pendingInvitesCount}
          </div>
          <div className="text-2xs text-ink-3">
            Awaiting password setup and account activation
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl border border-danger/30 bg-danger/5 text-xs text-danger flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1 font-medium">{error}</div>
          <button
            onClick={fetchData}
            className="underline text-xs hover:text-danger/80"
          >
            Retry
          </button>
        </div>
      )}

      {/* Search Filter Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by email, role, or status..."
            className="w-full h-9 pl-9 pr-3 rounded-lg border border-line bg-canvas text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
          />
        </div>

        <div className="text-2xs text-ink-3">
          Showing <strong className="text-ink">{filteredMembers.length}</strong> active admins,{' '}
          <strong className="text-ink">{filteredInvites.length}</strong> invites
        </div>
      </div>

      {/* SECTION 1: Pending & Recent Invitations Table */}
      <div className="bg-surface border border-line rounded-2xl overflow-hidden shadow-xs space-y-4 p-5">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <span>Invitations</span>
              {pendingInvitesCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-2xs font-semibold bg-accent/10 text-accent border border-accent/20">
                  {pendingInvitesCount} pending
                </span>
              )}
            </h3>
            <p className="text-2xs text-ink-3">
              Secure single-use invite tokens sent by the platform owner (valid for 48 hours).
            </p>
          </div>
        </div>

        <div className="border border-line rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-2/60 border-b border-line text-ink-3 uppercase text-2xs font-semibold tracking-wider select-none">
                <tr>
                  <th className="py-3 px-4">Invited Email</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Expiry / Sent</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-ink-3">
                      <div className="flex items-center justify-center gap-2">
                        <RefreshCw className="w-4 h-4 text-accent animate-spin" />
                        <span>Loading invitations…</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredInvites.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-ink-3">
                      No invitations found.
                    </td>
                  </tr>
                ) : (
                  filteredInvites.map((invite) => {
                    const isPending = invite.status === 'pending';
                    const isAccepted = invite.status === 'accepted';
                    const isRevoked = invite.status === 'revoked';

                    return (
                      <tr key={invite.id} className="hover:bg-surface-2/40 transition-colors">
                        {/* Email */}
                        <td className="py-3 px-4 font-mono text-xs text-ink">
                          {invite.email}
                        </td>

                        {/* Role */}
                        <td className="py-3 px-4">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-2xs font-semibold',
                              invite.role === 'owner'
                                ? 'bg-warn/10 text-warn border border-warn/20'
                                : 'bg-accent/10 text-accent border border-accent/20'
                            )}
                          >
                            {invite.role === 'owner' ? (
                              <>
                                <Shield className="w-3 h-3" />
                                <span>Owner</span>
                              </>
                            ) : (
                              <>
                                <ShieldCheck className="w-3 h-3" />
                                <span>Admin</span>
                              </>
                            )}
                          </span>
                        </td>

                        {/* Status */}
                        <td className="py-3 px-4">
                          {isPending ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-2xs font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/20">
                              <Clock className="w-3 h-3" />
                              <span>Pending</span>
                            </span>
                          ) : isAccepted ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-2xs font-semibold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                              <CheckCircle2 className="w-3 h-3" />
                              <span>Accepted</span>
                            </span>
                          ) : isRevoked ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-2xs font-semibold bg-rose-500/10 text-rose-500 border border-rose-500/20">
                              <Ban className="w-3 h-3" />
                              <span>Revoked</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-2xs font-semibold bg-zinc-500/10 text-zinc-500 border border-zinc-500/20">
                              <Clock className="w-3 h-3" />
                              <span>Expired</span>
                            </span>
                          )}
                        </td>

                        {/* Expiry */}
                        <td className="py-3 px-4 text-ink-3 text-2xs">
                          {isPending ? (
                            <span className="text-amber-500 font-medium">
                              {formatExpiryTime(invite.expires_at)}
                            </span>
                          ) : isAccepted && invite.accepted_at ? (
                            <span>
                              Accepted on {new Date(invite.accepted_at).toLocaleDateString()}
                            </span>
                          ) : (
                            <span>
                              Created {new Date(invite.created_at).toLocaleDateString()}
                            </span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {!isAccepted && (
                              <Button
                                variant="secondary"
                                size="sm"
                                className="h-7 text-2xs px-2"
                                title="Resend 48-hour invitation email"
                                disabled={resendingId === invite.id}
                                onClick={() => handleResendInvite(invite.id)}
                              >
                                <RotateCcw
                                  className={cn('w-3 h-3 mr-1', resendingId === invite.id && 'animate-spin')}
                                />
                                <span>{resendingId === invite.id ? 'Resending…' : 'Resend'}</span>
                              </Button>
                            )}

                            {isPending && (
                              <Button
                                variant="danger"
                                size="sm"
                                className="h-7 text-2xs px-2"
                                title="Revoke this invitation"
                                disabled={revokingId === invite.id}
                                onClick={() => handleRevokeInvite(invite.id)}
                              >
                                <Ban className="w-3 h-3 mr-1" />
                                <span>{revokingId === invite.id ? 'Revoking…' : 'Revoke'}</span>
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* SECTION 2: Active Platform Administrators Table */}
      <div className="bg-surface border border-line rounded-2xl overflow-hidden shadow-xs space-y-4 p-5">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <h3 className="text-sm font-bold text-ink flex items-center gap-2">
              <span>Active Platform Administrators</span>
              <span className="px-2 py-0.5 rounded-full text-2xs font-semibold bg-surface-2 text-ink-2 border border-line">
                {members.length}
              </span>
            </h3>
            <p className="text-2xs text-ink-3">
              Users with direct authorization to access and manage the ZenTry administration panel.
            </p>
          </div>
        </div>

        {/* Table Content */}
        <div className="border border-line rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-2/60 border-b border-line text-ink-3 uppercase text-2xs font-semibold tracking-wider select-none">
                <tr>
                  <th className="py-3 px-4">Account</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Granted By</th>
                  <th className="py-3 px-4">Granted At</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-ink-3">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <RefreshCw className="w-5 h-5 text-accent animate-spin" />
                        <span>Loading platform access members...</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredMembers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-ink-3">
                      No accounts found matching your filter.
                    </td>
                  </tr>
                ) : (
                  filteredMembers.map((member) => {
                    const isOwner = member.role === 'owner';
                    return (
                      <tr
                        key={member.user_id}
                        className="hover:bg-surface-2/50 transition-colors"
                      >
                        {/* User identity */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-3">
                            <Avatar name={member.name || member.email} size="sm" />
                            <div className="min-w-0">
                              <div className="font-semibold text-ink truncate flex items-center gap-1.5">
                                <span>{member.name || 'Admin'}</span>
                                {isOwner && (
                                  <span title="Permanent Platform Owner" className="inline-flex items-center">
                                    <Lock className="w-3 h-3 text-warn inline shrink-0" />
                                  </span>
                                )}
                              </div>
                              <div className="text-2xs text-ink-3 font-mono truncate">
                                {member.email}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Role Badge */}
                        <td className="py-3.5 px-4">
                          {isOwner ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-2xs font-semibold bg-warn/10 text-warn border border-warn/20">
                              <Shield className="w-3 h-3" />
                              <span>Owner</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-2xs font-semibold bg-accent/10 text-accent border border-accent/20">
                              <ShieldCheck className="w-3 h-3" />
                              <span>Admin</span>
                            </span>
                          )}
                        </td>

                        {/* Granted By */}
                        <td className="py-3.5 px-4 text-ink-2">
                          {isOwner ? (
                            <span className="text-2xs text-ink-3 italic">
                              Root System Assignment
                            </span>
                          ) : (
                            <span className="text-2xs font-mono text-ink-2 truncate block max-w-xs">
                              {member.granted_by_email || 'Owner'}
                            </span>
                          )}
                        </td>

                        {/* Granted At */}
                        <td className="py-3.5 px-4 text-ink-3">
                          <span className="text-2xs">
                            {member.granted_at
                              ? new Date(member.granted_at).toLocaleDateString(undefined, {
                                  year: 'numeric',
                                  month: 'short',
                                  day: 'numeric',
                                })
                              : '—'}
                          </span>
                        </td>

                        {/* Actions */}
                        <td className="py-3.5 px-4 text-right">
                          {isOwner ? (
                            <span
                              className="text-2xs text-ink-3 bg-surface-2 px-2.5 py-1 rounded-md border border-line/60 inline-flex items-center gap-1 select-none"
                              title="The platform owner can never be removed or demoted."
                            >
                              <Lock className="w-3 h-3 text-ink-3" />
                              <span>Protected</span>
                            </span>
                          ) : (
                            <Button
                              variant="danger"
                              size="sm"
                              className="h-8 text-2xs px-2.5"
                              onClick={() => {
                                setRemoveError(null);
                                setRemoveTarget(member);
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5 mr-1" />
                              <span>Remove</span>
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Give Access / Send Invite Modal */}
      <Modal
        open={giveModalOpen}
        onClose={() => {
          if (!grantLoading) {
            setGiveModalOpen(false);
            setLastCreatedInviteUrl(null);
          }
        }}
        title="Give Admin Access"
      >
        {lastCreatedInviteUrl ? (
          <div className="space-y-4">
            <div className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 text-xs text-emerald-600 flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-500" />
              <div className="flex-1 space-y-1">
                <strong>Invitation Link Created & Sent!</strong>
                <p className="text-2xs text-emerald-700">
                  An email was sent to <strong>{grantEmail}</strong>. You can also copy and share the link directly:
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-2xs font-semibold text-ink uppercase tracking-wider block">
                Secure Invite Link
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={lastCreatedInviteUrl}
                  className="w-full h-9 px-3 rounded-lg border border-line bg-surface-2 text-2xs font-mono text-ink-2 select-all"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0 h-9"
                  onClick={() => {
                    navigator.clipboard.writeText(lastCreatedInviteUrl);
                    setCopiedUrl(true);
                    toast.success('Link copied to clipboard!');
                    setTimeout(() => setCopiedUrl(false), 2000);
                  }}
                >
                  {copiedUrl ? (
                    <>
                      <Check className="w-3.5 h-3.5 mr-1 text-emerald-500" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 mr-1" />
                      <span>Copy</span>
                    </>
                  )}
                </Button>
              </div>
              <p className="text-2xs text-ink-3">
                Valid for 48 hours. Allows setting name and password without registering a workspace account.
              </p>
            </div>

            <div className="flex justify-end pt-3 border-t border-line">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => {
                  setGiveModalOpen(false);
                  setLastCreatedInviteUrl(null);
                  setGrantEmail('');
                }}
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSendInvite} className="space-y-4">
            <p className="text-xs text-ink-3">
              Enter an email address and select an administrative role. If the email already has a Zentry account, admin access is granted immediately. If no account exists, a secure 48-hour invite link will be sent to set up their password.
            </p>

            {grantError && (
              <div className="p-3.5 rounded-xl border border-danger/30 bg-danger/5 text-xs text-danger flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1 font-medium">{grantError}</div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-2xs font-semibold text-ink uppercase tracking-wider block">
                Colleague / Partner Email
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="email"
                  required
                  value={grantEmail}
                  onChange={(e) => setGrantEmail(e.target.value)}
                  placeholder="admin@example.com"
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-line bg-surface text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
                  disabled={grantLoading}
                  autoFocus
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-2xs font-semibold text-ink uppercase tracking-wider block">
                Administrative Role
              </label>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setGrantRole('admin')}
                  className={cn(
                    'p-3 rounded-xl border text-left transition-all',
                    grantRole === 'admin'
                      ? 'border-accent bg-accent/5 ring-1 ring-accent'
                      : 'border-line bg-surface hover:bg-surface-2'
                  )}
                >
                  <div className="flex items-center gap-1.5 font-semibold text-xs text-ink">
                    <ShieldCheck className="w-4 h-4 text-accent" />
                    <span>Admin</span>
                  </div>
                  <p className="text-2xs text-ink-3 mt-1">
                    Full platform panel management access.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setGrantRole('owner')}
                  className={cn(
                    'p-3 rounded-xl border text-left transition-all',
                    grantRole === 'owner'
                      ? 'border-warn bg-warn/5 ring-1 ring-warn'
                      : 'border-line bg-surface hover:bg-surface-2'
                  )}
                >
                  <div className="flex items-center gap-1.5 font-semibold text-xs text-ink">
                    <Shield className="w-4 h-4 text-warn" />
                    <span>Owner</span>
                  </div>
                  <p className="text-2xs text-ink-3 mt-1">
                    Co-ownership with invitation privileges.
                  </p>
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-line">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setGiveModalOpen(false)}
                disabled={grantLoading}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={grantLoading}
              >
                <Send className="w-3.5 h-3.5 mr-1" />
                <span>Send invite</span>
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* Remove Access Confirmation Modal */}
      <Modal
        open={!!removeTarget}
        onClose={() => {
          if (!removeLoading) setRemoveTarget(null);
        }}
        title="Revoke Admin Access"
      >
        <div className="space-y-4">
          <div className="p-3.5 rounded-xl border border-warn/30 bg-warn/5 flex items-start gap-2.5 text-xs text-warn">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              <strong>Confirm Access Revocation</strong>
              <p className="text-2xs text-warn/90 mt-0.5">
                Are you sure you want to revoke admin access for{' '}
                <strong className="font-mono text-ink">{removeTarget?.email}</strong>?
              </p>
            </div>
          </div>

          <p className="text-xs text-ink-3">
            This will immediately remove their privileges from the platform access table. They will no longer be able to open or view any page in the platform admin area.
          </p>

          {removeError && (
            <div className="p-3 rounded-xl border border-danger/30 bg-danger/5 text-xs text-danger">
              {removeError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-line">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setRemoveTarget(null)}
              disabled={removeLoading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              loading={removeLoading}
              onClick={handleRevokeAccess}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              <span>Confirm Revocation</span>
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
