'use client';

import React, { useMemo, useState } from 'react';
import { Clock, Copy, Gauge, Mail, Plus, RotateCw, UserCheck, UserMinus, X } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { ChipGroup, Field, Modal, inputClass, selectClass } from '@/components/tickets/TicketBits';
import { ErrorPanel, RoleBadge, StatusDot, TeamSkeleton, useTeam } from '@/components/team/TeamBits';
import {
  deactivateMemberAction,
  inviteMemberAction,
  reactivateMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
  setMemberCapacityAction,
  setMemberRoleAction,
  setMemberShiftsAction,
  type InviteResult,
  type PendingInvitation,
  type ReassignMode,
  type TeamData,
  type TeamMember,
} from '@/app/actions/team';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, assignableRoles, canManageMember, type Role } from '@/lib/team/permissions';
import { WEEKDAYS, formatClock, formatShiftSummary, parseClock, validateShifts, type Shift } from '@/lib/team/shifts';
import { cn, formatTimeAgo } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

/** Settings → Team members & roles. Owners and admins only (the server checks too). */
export function TeamSettings({ workspaceId }: { workspaceId: string }) {
  const { team, error, loading, reload, replace } = useTeam(workspaceId);
  const [inviting, setInviting] = useState(false);
  const [capacityFor, setCapacityFor] = useState<TeamMember | null>(null);
  const [deactivating, setDeactivating] = useState<TeamMember | null>(null);
  const [shiftsFor, setShiftsFor] = useState<TeamMember | null>(null);
  /** An invite whose email did not go: its link is shown once to share by hand. */
  const [unsent, setUnsent] = useState<InviteResult | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function invited(res: InviteResult) {
    replace(res.team);
    if (res.emailed) {
      setNotice({ text: `Invitation emailed to ${res.email}${res.team.mail.from ? ` from ${res.team.mail.from}` : ''}.`, tone: 'ok' });
    } else {
      setNotice(null);
      setUnsent(res);
    }
  }

  async function resend(invite: PendingInvitation) {
    setBusyId(invite.id);
    setNotice(null);
    try {
      invited(await resendInvitationAction(workspaceId, invite.id));
    } catch (e) {
      setNotice({ text: errorMessage(e), tone: 'error' });
    } finally {
      setBusyId(null);
    }
  }

  const active = useMemo(() => (team?.members || []).filter((m) => m.is_active), [team]);
  const inactive = useMemo(() => (team?.members || []).filter((m) => !m.is_active), [team]);

  async function run(memberId: string, work: () => Promise<TeamData>, okText: string) {
    setBusyId(memberId);
    setNotice(null);
    try {
      replace(await work());
      setNotice({ text: okText, tone: 'ok' });
    } catch (e) {
      setNotice({ text: errorMessage(e), tone: 'error' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-5" aria-labelledby="team-heading">
      <header className="flex flex-wrap items-center justify-between gap-3">
        {/* The settings page already shows the title; this names the region for screen readers. */}
        <h2 id="team-heading" className="sr-only">
          Team members
        </h2>
        <p className="text-xs text-ink-3 min-w-0 flex-1 basis-56">
          {team ? `${active.length} active member${active.length === 1 ? '' : 's'}${inactive.length ? `, ${inactive.length} deactivated` : ''}.` : 'Invite people, set what they can do, and manage who is on the team.'}
        </p>
        {team && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setInviting(true)}>
            <Plus className="w-3.5 h-3.5" /> Invite member
          </button>
        )}
      </header>

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'px-3 py-2 rounded-lg border text-xs',
            notice.tone === 'error' ? 'bg-danger-soft border-danger-line text-danger' : 'bg-success-soft border-success-line text-ink'
          )}
        >
          {notice.text}
        </div>
      )}

      {loading && <TeamSkeleton />}
      {error && <ErrorPanel message={error} onRetry={reload} />}

      {team && (
        <>
          {team.mail.ready ? (
            <p className="text-xs text-ink-3">
              Invitations and team alerts are emailed from <span className="font-medium text-ink">{team.mail.from}</span>. Shift hours are in{' '}
              {team.timezone}.
            </p>
          ) : (
            <p role="alert" className="px-3 py-2 rounded-lg border border-warn-line bg-warn-soft text-xs text-ink">
              Invitations and team alerts are sent from your workspace&apos;s own email address, which is not set up yet. Add it in
              Settings → Channels → SMTP. Until then you can still invite people and share the link yourself.
            </p>
          )}

          <RoleLegend />

          {active.length <= 1 && team.invitations.length === 0 && (
            <EmptyState
              type="custom"
              title="It's just you so far"
              description="Invite a colleague by email. They get a link from your workspace's address, choose their own password and join."
              actionLabel="Invite member"
              onAction={() => setInviting(true)}
            />
          )}

          {team.invitations.length > 0 && (
            <div className="space-y-2">
              <h3 className="eyebrow">Invited</h3>
              <ul className="space-y-2" aria-label="Pending invitations">
                {team.invitations.map((inv) => (
                  <InvitationRow
                    key={inv.id}
                    invite={inv}
                    busy={busyId === inv.id}
                    onResend={() => void resend(inv)}
                    onRevoke={() => run(inv.id, () => revokeInvitationAction(workspaceId, inv.id), `The invitation to ${inv.email} was withdrawn.`)}
                  />
                ))}
              </ul>
            </div>
          )}

          <ul className="space-y-2" aria-label="Team members">
            {active.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                team={team}
                busy={busyId === m.id}
                onRole={(role) => run(m.id, () => setMemberRoleAction(workspaceId, m.id, role), `${m.name} is now ${ROLE_LABELS[role].toLowerCase()}.`)}
                onCapacity={() => setCapacityFor(m)}
                onShifts={() => setShiftsFor(m)}
                onDeactivate={() => setDeactivating(m)}
              />
            ))}
          </ul>

          {inactive.length > 0 && (
            <div className="space-y-2">
              <h3 className="eyebrow">Deactivated</h3>
              <ul className="space-y-2" aria-label="Deactivated members">
                {inactive.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    team={team}
                    busy={busyId === m.id}
                    onReactivate={() => run(m.id, () => reactivateMemberAction(workspaceId, m.id), `${m.name} can sign in again.`)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {inviting && team && (
        <InviteDialog
          team={team}
          workspaceId={workspaceId}
          onClose={() => setInviting(false)}
          onDone={(res) => {
            setInviting(false);
            invited(res);
          }}
        />
      )}
      {unsent && <InviteLinkDialog result={unsent} onClose={() => setUnsent(null)} />}
      {shiftsFor && team && (
        <ShiftDialog
          member={shiftsFor}
          timezone={team.timezone}
          workspaceId={workspaceId}
          onClose={() => setShiftsFor(null)}
          onDone={(next) => {
            replace(next);
            setNotice({ text: `Shift hours saved for ${shiftsFor.name}.`, tone: 'ok' });
            setShiftsFor(null);
          }}
        />
      )}
      {capacityFor && (
        <CapacityDialog
          member={capacityFor}
          workspaceId={workspaceId}
          onClose={() => setCapacityFor(null)}
          onDone={(next) => {
            replace(next);
            setCapacityFor(null);
            setNotice({ text: 'Capacity updated.', tone: 'ok' });
          }}
        />
      )}
      {deactivating && team && (
        <DeactivateDialog
          member={deactivating}
          team={team}
          workspaceId={workspaceId}
          onClose={() => setDeactivating(null)}
          onDone={(next, moved) => {
            replace(next);
            setNotice({
              text: `${deactivating.name} was deactivated${moved ? ` and ${moved} open ticket${moved === 1 ? ' was' : 's were'} reassigned` : ''}.`,
              tone: 'ok',
            });
            setDeactivating(null);
          }}
        />
      )}
    </section>
  );
}

function RoleLegend() {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {(['owner', 'admin', 'agent', 'light_agent'] as Role[]).map((r) => (
        <div key={r} className="p-3 rounded-xl border border-line bg-surface-2">
          <dt className="text-xs font-semibold text-ink">{ROLE_LABELS[r]}</dt>
          <dd className="text-xs text-ink-3 mt-0.5">{ROLE_DESCRIPTIONS[r]}</dd>
        </div>
      ))}
    </dl>
  );
}

function MemberRow({
  member: m,
  team,
  busy,
  onRole,
  onCapacity,
  onShifts,
  onDeactivate,
  onReactivate,
}: {
  member: TeamMember;
  team: TeamData;
  busy: boolean;
  onRole?: (role: Role) => void;
  onCapacity?: () => void;
  onShifts?: () => void;
  onDeactivate?: () => void;
  onReactivate?: () => void;
}) {
  const me = { id: team.me.id, role: team.me.role };
  const manageable = canManageMember(me, { id: m.id, role: m.role });
  const roleOptions = assignableRoles(team.me.role);
  const groups = team.groups.filter((g) => m.group_ids.includes(g.id));
  const atCapacity = m.max_open_tickets !== null && m.open_tickets >= m.max_open_tickets;

  return (
    <li
      className={cn(
        'p-3 rounded-xl border border-line bg-surface flex flex-wrap items-center gap-x-4 gap-y-3',
        'lg:grid lg:grid-cols-[minmax(0,1.4fr)_9.5rem_9rem_minmax(0,1fr)_auto]',
        !m.is_active && 'opacity-70'
      )}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1 basis-56">
        <Avatar name={m.name} seed={m.id} size="md" online={m.is_active && m.status === 'online'} />
        <div className="min-w-0">
          <div className="text-ui font-semibold text-ink truncate">
            {m.name}
            {m.id === team.me.id && <span className="text-ink-3 font-normal"> (you)</span>}
          </div>
          <div className="text-xs text-ink-3 truncate">{m.email}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 min-w-0 basis-40">
        {manageable && m.is_active && onRole && roleOptions.length > 0 ? (
          <select
            aria-label={`Role for ${m.name}`}
            className={cn(selectClass, 'h-8 text-xs w-auto')}
            value={m.role}
            disabled={busy}
            onChange={(e) => onRole(e.target.value as Role)}
          >
            {Array.from(new Set([m.role, ...roleOptions])).map((r) => (
              <option key={r} value={r} disabled={!roleOptions.includes(r)}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        ) : (
          <RoleBadge role={m.role} />
        )}
        {!m.is_active && <span className="pill pill-warn">Deactivated</span>}
      </div>

      {m.is_active && (
        <div className="basis-44 space-y-1">
          <StatusDot status={m.status} />
          <div className={cn('text-xs', atCapacity ? 'text-warn font-medium' : 'text-ink-3')}>
            {m.role === 'light_agent'
              ? 'Not assignable'
              : `${m.open_tickets} open${m.max_open_tickets !== null ? ` of ${m.max_open_tickets}` : ' · no limit'}`}
          </div>
          {m.role !== 'light_agent' && (
            <div className="text-xs text-ink-3 flex items-center gap-1" title="Team emails go to people on shift">
              <Clock className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{m.shifts.length ? formatShiftSummary(m.shifts) : 'No shift hours'}</span>
            </div>
          )}
        </div>
      )}

      {groups.length > 0 && m.is_active && (
        <div className="flex flex-wrap gap-1 basis-40">
          {groups.map((g) => (
            <span key={g.id} className="pill pill-neutral">
              {g.name}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 ml-auto">
        {m.is_active && manageable && m.role !== 'light_agent' && onCapacity && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCapacity} aria-label={`Set capacity for ${m.name}`}>
            <Gauge className="w-3.5 h-3.5" /> Capacity
          </button>
        )}
        {m.is_active && m.role !== 'light_agent' && onShifts && (team.me.role === 'owner' || team.me.role === 'admin') && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onShifts} aria-label={`Set shift hours for ${m.name}`}>
            <Clock className="w-3.5 h-3.5" /> Shift
          </button>
        )}
        {m.is_active && manageable && onDeactivate && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDeactivate} aria-label={`Deactivate ${m.name}`}>
            <UserMinus className="w-3.5 h-3.5" /> Deactivate
          </button>
        )}
        {!m.is_active && manageable && onReactivate && (
          <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={onReactivate} aria-label={`Reactivate ${m.name}`}>
            <UserCheck className="w-3.5 h-3.5" /> Reactivate
          </button>
        )}
      </div>
    </li>
  );
}

function InviteDialog({
  team,
  workspaceId,
  onClose,
  onDone,
}: {
  team: TeamData;
  workspaceId: string;
  onClose: () => void;
  onDone: (result: InviteResult) => void;
}) {
  const roles = assignableRoles(team.me.role);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(roles.includes('agent') ? 'agent' : roles[0]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await inviteMemberAction(workspaceId, { name, email, role, groupIds }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Invite a team member"
      description={
        team.mail.ready
          ? `They get an email from ${team.mail.from} with a link to choose their password.`
          : 'Your workspace email is not set up, so you will get a link to send them yourself.'
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="invite-form" className="btn btn-sm btn-primary" disabled={busy || !email.trim()}>
            <Mail className="w-3.5 h-3.5" /> {busy ? 'Inviting…' : 'Send invite'}
          </button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" autoFocus />
        </Field>
        <Field label="Email">
          <input className={inputClass} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        </Field>
        <Field label="Role" hint={ROLE_DESCRIPTIONS[role]}>
          <select className={selectClass} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
        {team.groups.length > 0 && role !== 'light_agent' && (
          <ChipGroup label="Groups" options={team.groups.map((g) => ({ value: g.id, label: g.name }))} value={groupIds} onChange={setGroupIds} />
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function CapacityDialog({
  member,
  workspaceId,
  onClose,
  onDone,
}: {
  member: TeamMember;
  workspaceId: string;
  onClose: () => void;
  onDone: (team: TeamData) => void;
}) {
  const [value, setValue] = useState(member.max_open_tickets === null ? '' : String(member.max_open_tickets));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await setMemberCapacityAction(workspaceId, member.id, value.trim() === '' ? null : Number(value)));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Capacity for ${member.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="capacity-form" className="btn btn-sm btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="capacity-form" onSubmit={save} className="space-y-3">
        <Field
          label="Maximum open tickets"
          hint="Round-robin and auto-assignment skip this person once they have this many New or Open tickets. Leave empty for no limit. You can still assign tickets to them by hand."
        >
          <input className={inputClass} type="number" min={1} max={1000} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder="No limit" autoFocus />
        </Field>
        <p className="text-xs text-ink-3">Currently {member.open_tickets} open.</p>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function DeactivateDialog({
  member,
  team,
  workspaceId,
  onClose,
  onDone,
}: {
  member: TeamMember;
  team: TeamData;
  workspaceId: string;
  onClose: () => void;
  onDone: (team: TeamData, moved: number) => void;
}) {
  const candidates = team.members.filter((m) => m.is_active && m.id !== member.id && m.role !== 'light_agent');
  const [mode, setMode] = useState<ReassignMode>(candidates.length ? 'agent' : 'unassign');
  const [to, setTo] = useState(candidates[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await deactivateMemberAction(workspaceId, member.id, { mode, to: mode === 'agent' ? to : null });
      onDone(res.team, res.moved);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const options: { value: ReassignMode; label: string; hint: string; disabled?: boolean }[] = [
    { value: 'agent', label: 'Give them to one agent', hint: 'Every open ticket moves to the person you choose.', disabled: candidates.length === 0 },
    { value: 'round_robin', label: 'Send back to their groups', hint: 'Tickets in a group with round-robin go to the next available member; the rest wait unassigned.' },
    { value: 'unassign', label: 'Leave them unassigned', hint: 'Tickets keep their group and wait in the queue.' },
  ];

  return (
    <Modal
      title={`Deactivate ${member.name}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-danger" disabled={busy || (mode === 'agent' && !to)} onClick={confirm}>
            {busy ? 'Deactivating…' : 'Deactivate'}
          </button>
        </>
      }
    >
      <p className="text-ui text-ink-2">
        They will be signed out of this workspace immediately. Their history stays. You can reactivate them later.
      </p>
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold text-ink-2 mb-1.5">
          {member.open_tickets > 0 ? `${member.open_tickets} open ticket${member.open_tickets === 1 ? '' : 's'} to reassign` : 'Open tickets'}
        </legend>
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer',
              mode === o.value ? 'border-accent-line bg-accent-soft' : 'border-line bg-surface',
              o.disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <input type="radio" name="reassign" className="mt-0.5 accent-[var(--ds-accent)]" checked={mode === o.value} disabled={o.disabled} onChange={() => setMode(o.value)} />
            <span className="min-w-0">
              <span className="block text-ui font-medium text-ink">{o.label}</span>
              <span className="block text-xs text-ink-3">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {mode === 'agent' && (
        <Field label="Give them to">
          <select className={selectClass} value={to} onChange={(e) => setTo(e.target.value)}>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.open_tickets} open)
              </option>
            ))}
          </select>
        </Field>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

function InvitationRow({
  invite,
  busy,
  onResend,
  onRevoke,
}: {
  invite: PendingInvitation;
  busy: boolean;
  onResend: () => void;
  onRevoke: () => void;
}) {
  // Read once when the row mounts; the list reloads after every change anyway.
  const [now] = useState(() => Date.now());
  const expired = Date.parse(invite.expires_at) < now;
  return (
    <li className="p-3 rounded-xl border border-dashed border-line bg-surface flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-3 min-w-0 flex-1 basis-56">
        <div className="w-9 h-9 shrink-0 rounded-full bg-surface-2 border border-line grid place-items-center text-ink-3">
          <Mail className="w-4 h-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="text-ui font-semibold text-ink truncate">{invite.name || invite.email}</div>
          <div className="text-xs text-ink-3 truncate">{invite.email}</div>
        </div>
      </div>
      <RoleBadge role={invite.role} />
      <div className="text-xs basis-48 min-w-0">
        {expired ? (
          <span className="text-warn font-medium">Expired, send it again</span>
        ) : invite.send_error ? (
          <span className="text-danger" title={invite.send_error}>
            Not emailed
          </span>
        ) : invite.last_sent_at ? (
          <span className="text-ink-3">Emailed {formatTimeAgo(invite.last_sent_at)}</span>
        ) : (
          <span className="text-ink-3">Waiting</span>
        )}
      </div>
      <div className="flex items-center gap-1.5 ml-auto">
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onResend} aria-label={`Send the invitation to ${invite.email} again`}>
          <RotateCw className="w-3.5 h-3.5" /> {busy ? 'Sending…' : 'Resend'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onRevoke} aria-label={`Withdraw the invitation to ${invite.email}`}>
          <X className="w-3.5 h-3.5" /> Revoke
        </button>
      </div>
    </li>
  );
}

/** Shown once when the invitation email did not go out, so the link can be shared by hand. */
function InviteLinkDialog({ result, onClose }: { result: InviteResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(result.link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Modal
      title={`Send ${result.email} this link`}
      description="The invitation is saved, but it was not emailed."
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      {result.error && (
        <p role="alert" className="px-3 py-2 rounded-lg border border-warn-line bg-warn-soft text-xs text-ink">
          {result.error}
        </p>
      )}
      <Field label="Invitation link" hint="It works once and expires in 7 days. It is shown only now; resending makes a new one.">
        <div className="flex gap-2">
          <input className={cn(inputClass, 'font-mono text-xs')} readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={() => void copy()}>
            <Copy className="w-3.5 h-3.5" /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </Field>
    </Modal>
  );
}

/** Monday first, the way people read a work week. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

interface DayDraft {
  on: boolean;
  start: string;
  end: string;
}

function ShiftDialog({
  member,
  timezone,
  workspaceId,
  onClose,
  onDone,
}: {
  member: TeamMember;
  timezone: string;
  workspaceId: string;
  onClose: () => void;
  onDone: (team: TeamData) => void;
}) {
  const [days, setDays] = useState<DayDraft[]>(() =>
    Array.from({ length: 7 }, (_, weekday) => {
      const s = member.shifts.find((x) => x.weekday === weekday);
      return s ? { on: true, start: formatClock(s.start_minute), end: formatClock(s.end_minute) } : { on: false, start: '09:00', end: '17:00' };
    })
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Days with more than one shift (set elsewhere) keep only the first here.
  const hadExtra = new Set(member.shifts.map((s) => s.weekday)).size < member.shifts.length;

  const set = (weekday: number, patch: Partial<DayDraft>) => setDays((d) => d.map((x, i) => (i === weekday ? { ...x, ...patch } : x)));

  function toShifts(): Shift[] | string {
    const out: Shift[] = [];
    for (const weekday of WEEK_ORDER) {
      const d = days[weekday];
      if (!d.on) continue;
      const start = parseClock(d.start);
      const end = parseClock(d.end);
      if (start === null || end === null) return `${WEEKDAYS[weekday]}: enter a start and end time.`;
      out.push({ weekday, start_minute: start, end_minute: end });
    }
    return validateShifts(out) ?? out;
  }

  async function save(clear = false) {
    const shifts = clear ? [] : toShifts();
    if (typeof shifts === 'string') {
      setError(shifts);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await setMemberShiftsAction(workspaceId, member.id, shifts));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const monday = days[1];
  return (
    <Modal
      title={`Shift hours for ${member.name}`}
      description={`In ${timezone}. While anyone is on shift, team emails go only to the people on shift. An end time earlier than the start runs past midnight.`}
      onClose={onClose}
      footer={
        <>
          {member.shifts.length > 0 && (
            <button type="button" className="btn btn-sm btn-ghost mr-auto" disabled={busy} onClick={() => void save(true)}>
              Remove shift hours
            </button>
          )}
          <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">Working days and hours</legend>
        {WEEK_ORDER.map((weekday) => {
          const d = days[weekday];
          return (
            <div key={weekday} className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 w-20 shrink-0 text-ui text-ink">
                <input type="checkbox" className="accent-[var(--ds-accent)]" checked={d.on} onChange={(e) => set(weekday, { on: e.target.checked })} />
                {WEEKDAYS[weekday]}
              </label>
              <input
                type="time"
                className={cn(inputClass, 'w-28')}
                value={d.start}
                disabled={!d.on}
                aria-label={`${WEEKDAYS[weekday]} start`}
                onChange={(e) => set(weekday, { start: e.target.value })}
              />
              <span className="text-xs text-ink-3">to</span>
              <input
                type="time"
                className={cn(inputClass, 'w-28')}
                value={d.end}
                disabled={!d.on}
                aria-label={`${WEEKDAYS[weekday]} end`}
                onChange={(e) => set(weekday, { end: e.target.value })}
              />
            </div>
          );
        })}
      </fieldset>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => setDays((all) => all.map((x, i) => (i >= 1 && i <= 5 ? { ...monday } : x)))}
      >
        Copy Monday to Tuesday–Friday
      </button>
      {hadExtra && <p className="text-xs text-ink-3">Some days had more than one shift; saving keeps the first one of each day.</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
