'use client';

import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  CHANNEL_LABEL,
  MANUAL_TICKET_CHANNELS,
  PRIORITY_LABEL,
  SORT_FIELDS,
  SORT_LABEL,
  STATUS_LABEL,
  TICKET_CHANNELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  TYPE_LABEL,
  normalizeTag,
  type SortField,
  type TicketFilters,
  type TicketSort,
  type ViewDefinition,
} from '@/lib/tickets/views';
import type { TicketChannel, TicketGroup, TicketPriority, TicketStatus, TicketType } from '@/types/database';
import { ChipGroup, Field, Modal, inputClass, selectClass } from './TicketBits';
import { errorMessage } from '@/lib/errors/user-error';

/* ── Saved views ──────────────────────────────────────────────────────── */

export function ViewEditor({
  view,
  agents,
  groups,
  canShare,
  onSave,
  onDelete,
  onClose,
}: {
  view: ViewDefinition | null;
  agents: { id: string; name: string }[];
  groups: TicketGroup[];
  canShare: boolean;
  onSave: (input: { id?: string; name: string; filters: TicketFilters; sort: TicketSort; shared: boolean }) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(view?.name ?? '');
  const [filters, setFilters] = useState<TicketFilters>(view?.filters ?? { status: ['new', 'open'] });
  const [sort, setSort] = useState<TicketSort>(view?.sort ?? { field: 'updated_at', direction: 'desc' });
  const [shared, setShared] = useState(view ? view.ownerId === null : false);
  const [tags, setTags] = useState((view?.filters.tags ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof TicketFilters>(key: K, value: TicketFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: Array.isArray(value) && value.length === 0 ? undefined : value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const tagList = tags.split(',').map(normalizeTag).filter(Boolean);
      await onSave({ id: view?.id, name, filters: { ...filters, tags: tagList.length ? tagList : undefined }, sort, shared });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={view ? 'Edit view' : 'New view'}
      wide
      onClose={onClose}
      footer={
        <>
          {onDelete && (
            <button
              type="button"
              className="btn btn-danger btn-sm mr-auto"
              disabled={busy}
              onClick={async () => {
                if (!confirm(`Delete the view "${view?.name}"?`)) return;
                setBusy(true);
                try {
                  await onDelete();
                  onClose();
                } catch (err) {
                  setError(errorMessage(err));
                  setBusy(false);
                }
              }}
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-accent btn-sm" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save view'}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Urgent billing" autoFocus />
      </Field>
      <ChipGroup<TicketStatus>
        label="Status"
        value={filters.status ?? []}
        onChange={(v) => set('status', v)}
        options={TICKET_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
      />
      <ChipGroup<TicketPriority>
        label="Priority"
        value={filters.priority ?? []}
        onChange={(v) => set('priority', v)}
        options={TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
      />
      <ChipGroup<TicketType>
        label="Type"
        value={filters.type ?? []}
        onChange={(v) => set('type', v)}
        options={TICKET_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
      />
      <ChipGroup<TicketChannel>
        label="Channel"
        value={filters.channel ?? []}
        onChange={(v) => set('channel', v)}
        options={TICKET_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
      />
      <ChipGroup<string>
        label="Assignee"
        value={filters.assignee ?? []}
        onChange={(v) => set('assignee', v)}
        options={[{ value: 'me', label: 'Me' }, { value: 'none', label: 'Unassigned' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
      />
      <ChipGroup<string>
        label="Group"
        value={filters.group ?? []}
        onChange={(v) => set('group', v)}
        options={[{ value: 'none', label: 'No group' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
      />
      <Field label="Tags (any of)" hint="Comma-separated">
        <input className={inputClass} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vip, billing" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Sort by">
          <select className={selectClass} value={sort.field} onChange={(e) => setSort({ ...sort, field: e.target.value as SortField })}>
            {SORT_FIELDS.map((f) => (
              <option key={f} value={f}>
                {SORT_LABEL[f]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Order">
          <select
            className={selectClass}
            value={sort.direction}
            onChange={(e) => setSort({ ...sort, direction: e.target.value as 'asc' | 'desc' })}
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-ui text-ink-2">
        <input type="checkbox" checked={shared} disabled={!canShare} onChange={(e) => setShared(e.target.checked)} />
        Share with everyone in the workspace
        {!canShare && <span className="text-ink-3">(admins only)</span>}
      </label>
      {error && <p className="text-xs text-danger">{error}</p>}
    </Modal>
  );
}

/* ── New ticket ───────────────────────────────────────────────────────── */

export function NewTicketDialog({
  agents,
  groups,
  onCreate,
  onClose,
}: {
  agents: { id: string; name: string }[];
  groups: TicketGroup[];
  onCreate: (input: {
    requesterName: string;
    requesterEmail: string;
    subject: string;
    body: string;
    channel: TicketChannel;
    priority: TicketPriority;
    type: TicketType;
    assigneeId: string | null;
    groupId: string | null;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    requesterName: '',
    requesterEmail: '',
    subject: '',
    body: '',
    channel: 'email' as TicketChannel,
    priority: 'normal' as TicketPriority,
    type: 'question' as TicketType,
    assigneeId: '',
    groupId: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate({ ...form, assigneeId: form.assigneeId || null, groupId: form.groupId || null });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New ticket"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-accent btn-sm" onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create ticket'}
          </button>
        </>
      }
    >
      <p className="text-xs text-ink-3">
        For requests that arrive outside the chat, such as an email or a form. Chats become tickets on their own.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Requester name">
          <input className={inputClass} value={form.requesterName} onChange={change('requesterName')} />
        </Field>
        <Field label="Requester email">
          <input className={inputClass} type="email" value={form.requesterEmail} onChange={change('requesterEmail')} required />
        </Field>
      </div>
      <Field label="Subject">
        <input className={inputClass} value={form.subject} onChange={change('subject')} required />
      </Field>
      <Field label="Description" hint="Saved as the requester's first message.">
        <textarea className={`${inputClass} h-28 py-2`} value={form.body} onChange={change('body')} required />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Channel">
          <select className={selectClass} value={form.channel} onChange={change('channel')}>
            {MANUAL_TICKET_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select className={selectClass} value={form.priority} onChange={change('priority')}>
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Type">
          <select className={selectClass} value={form.type} onChange={change('type')}>
            {TICKET_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Assignee">
          <select className={selectClass} value={form.assigneeId} onChange={change('assigneeId')}>
            <option value="">Unassigned</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Group">
          <select className={selectClass} value={form.groupId} onChange={change('groupId')}>
            <option value="">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </Modal>
  );
}

/* ── Groups ───────────────────────────────────────────────────────────── */

export function GroupsDialog({
  groups,
  onCreate,
  onDelete,
  onClose,
}: {
  groups: TicketGroup[];
  onCreate: (name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const wrap = (fn: () => Promise<void>) => async () => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal title="Groups" onClose={onClose}>
      <p className="text-xs text-ink-3">Groups route tickets to a team, such as Billing or Technical support.</p>
      <ul className="divide-y divide-line border border-line rounded-lg">
        {groups.length === 0 && <li className="px-3 py-2.5 text-xs text-ink-3">No groups yet.</li>}
        {groups.map((g) => (
          <li key={g.id} className="flex items-center justify-between px-3 py-2 text-ui">
            {g.name}
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              aria-label={`Delete group ${g.name}`}
              onClick={wrap(async () => {
                if (confirm(`Delete "${g.name}"? Its tickets will have no group.`)) await onDelete(g.id);
              })}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          wrap(async () => {
            await onCreate(name);
            setName('');
          })();
        }}
      >
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="New group name" aria-label="New group name" />
        <button type="submit" className="btn btn-accent btn-sm" disabled={!name.trim()}>
          Add
        </button>
      </form>
      {error && <p className="text-xs text-danger">{error}</p>}
    </Modal>
  );
}
