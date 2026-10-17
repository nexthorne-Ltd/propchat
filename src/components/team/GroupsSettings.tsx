'use client';

import React, { useState } from 'react';
import { Plus, Trash2, Users } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Avatar } from '@/components/ui/Avatar';
import { ChipGroup, Field, Modal, inputClass } from '@/components/tickets/TicketBits';
import { ErrorPanel, TeamSkeleton, useTeam } from '@/components/team/TeamBits';
import {
  createGroupAction,
  deleteGroupAction,
  setGroupMembersAction,
  updateGroupAction,
  type TeamData,
  type TeamGroup,
} from '@/app/actions/team';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

/** Settings → Groups & routing. Groups, who is in them, and whether tickets are handed out in turn. */
export function GroupsSettings({ workspaceId }: { workspaceId: string }) {
  const { team, error, loading, reload, replace } = useTeam(workspaceId);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TeamGroup | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, work: () => Promise<TeamData>, okText?: string) {
    setBusy(key);
    setNotice(null);
    try {
      replace(await work());
      if (okText) setNotice({ text: okText, tone: 'ok' });
    } catch (e) {
      setNotice({ text: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-5" aria-labelledby="groups-heading">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="groups-heading" className="sr-only">
          Groups
        </h2>
        <p className="text-xs text-ink-3 min-w-0 flex-1 basis-72 max-w-xl">
          Groups such as Billing or Technical collect tickets for the people who handle them. A ticket in a group can only be assigned to one of its members.
        </p>
        {team && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
            <Plus className="w-3.5 h-3.5" /> New group
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

      {loading && <TeamSkeleton rows={3} />}
      {error && <ErrorPanel message={error} onRetry={reload} />}

      {team && team.groups.length === 0 && (
        <EmptyState
          type="custom"
          title="No groups yet"
          description="Create a group for each kind of work, for example Billing and Technical, then add the agents who handle it."
          actionLabel="New group"
          onAction={() => setCreating(true)}
        />
      )}

      {team && team.groups.length > 0 && (
        <ul className="space-y-3" aria-label="Groups">
          {team.groups.map((g) => {
            const assignable = team.members.filter((m) => m.is_active && m.role !== 'light_agent');
            return (
              <li key={g.id} className="p-4 rounded-xl border border-line bg-surface space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2 min-w-0 flex-1 basis-40">
                    <Users className="w-4 h-4 text-ink-3 shrink-0" />
                    <span className="text-sm font-semibold text-ink truncate">{g.name}</span>
                    <span className="pill pill-neutral">{g.member_ids.length} member{g.member_ids.length === 1 ? '' : 's'}</span>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-ink-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-[var(--ds-accent)]"
                      checked={g.round_robin}
                      disabled={busy === g.id}
                      onChange={(e) =>
                        run(g.id, () => updateGroupAction(workspaceId, g.id, { roundRobin: e.target.checked }), e.target.checked ? `Round-robin is on for ${g.name}.` : `Round-robin is off for ${g.name}.`)
                      }
                    />
                    Round-robin
                  </label>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDeleting(g)} aria-label={`Delete ${g.name}`}>
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                </div>

                <p className="text-xs text-ink-3">
                  {g.round_robin
                    ? 'New tickets in this group go to the next member who is online and under their capacity. Away and offline members are skipped; if nobody qualifies the ticket waits unassigned.'
                    : 'Tickets in this group are assigned by hand.'}
                </p>

                {assignable.length === 0 ? (
                  <p className="text-xs text-ink-3">No one can be added yet. Invite an agent first.</p>
                ) : (
                  <div className="space-y-2">
                    <ChipGroup
                      label="Members"
                      options={assignable.map((m) => ({ value: m.id, label: m.name }))}
                      value={g.member_ids}
                      onChange={(ids) => run(g.id, () => setGroupMembersAction(workspaceId, g.id, ids))}
                    />
                    <div className="flex -space-x-1.5" aria-hidden>
                      {assignable
                        .filter((m) => g.member_ids.includes(m.id))
                        .slice(0, 8)
                        .map((m) => (
                          <Avatar key={m.id} name={m.name} seed={m.id} size="sm" className="ring-2 ring-surface" />
                        ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {creating && (
        <CreateGroupDialog
          workspaceId={workspaceId}
          onClose={() => setCreating(false)}
          onDone={(next) => {
            replace(next);
            setCreating(false);
          }}
        />
      )}
      {deleting && (
        <Modal
          title={`Delete ${deleting.name}?`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  const g = deleting;
                  setDeleting(null);
                  await run(g.id, () => deleteGroupAction(workspaceId, g.id), `${g.name} was deleted.`);
                }}
              >
                Delete group
              </button>
            </>
          }
        >
          <p className="text-ui text-ink-2">Tickets in this group stay where they are, without a group. Nothing else is deleted.</p>
        </Modal>
      )}
    </section>
  );
}

function CreateGroupDialog({ workspaceId, onClose, onDone }: { workspaceId: string; onClose: () => void; onDone: (team: TeamData) => void }) {
  const [name, setName] = useState('');
  const [roundRobin, setRoundRobin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await createGroupAction(workspaceId, { name, roundRobin }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New group"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="group-form" className="btn btn-sm btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </>
      }
    >
      <form id="group-form" onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Billing" autoFocus />
        </Field>
        <label className="flex items-center gap-2 text-ui text-ink-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-[var(--ds-accent)]" checked={roundRobin} onChange={(e) => setRoundRobin(e.target.checked)} />
          Hand out new tickets round-robin
        </label>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
