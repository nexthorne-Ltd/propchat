'use client';

import React, { useState } from 'react';
import { ArrowDownUp, ChevronLeft, ChevronRight, GitMerge, Tag, UserPlus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/EmptyState';
import { Avatar } from '@/components/ui/Avatar';
import { Menu } from '@/components/ui/Menu';
import {
  SETTABLE_STATUSES,
  SORT_FIELDS,
  SORT_LABEL,
  STATUS_LABEL,
  type SortField,
  type TicketSort,
} from '@/lib/tickets/views';
import type { TicketListItem } from '@/app/actions/tickets';
import type { TicketStatus } from '@/types/database';
import { ChannelIcon, Modal, PriorityLabel, StatusBadge, inputClass, timeAgo } from './TicketBits';
import { SlaBadge } from './SlaBadge';
import { CsatBadge } from './CsatBadge';

export const PAGE_SIZE = 50;

interface Props {
  /** False for roles that cannot change tickets: no selection, no bulk bar. */
  canEdit: boolean;
  tickets: (TicketListItem & { matched_on?: string })[];
  total: number;
  page: number;
  loading: boolean;
  agents: { id: string; name: string }[];
  selected: Set<string>;
  sort: TicketSort;
  showSort: boolean;
  emptyText: string;
  onSort: (sort: TicketSort) => void;
  onPage: (page: number) => void;
  onToggle: (id: string) => void;
  onToggleAll: (select: boolean) => void;
  onOpen: (id: string) => void;
  onBulk: (change: { assigneeId?: string | null; status?: TicketStatus; addTag?: string }) => Promise<void>;
  onMerge: (targetId: string, sourceIds: string[]) => Promise<void>;
}

const MATCH_LABEL: Record<string, string> = {
  number: 'number',
  subject: 'subject',
  requester: 'requester',
  message: 'message text',
};

export function TicketList(props: Props) {
  const { tickets, selected, agents } = props;
  const agentName = (id: string | null) => agents.find((a) => a.id === id)?.name;
  const allSelected = tickets.length > 0 && tickets.every((t) => selected.has(t.id));
  const pages = Math.max(1, Math.ceil(props.total / PAGE_SIZE));

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {props.canEdit && selected.size > 0 ? (
        <BulkBar {...props} />
      ) : (
        <div className="h-11 px-4 flex items-center justify-between border-b border-line text-xs text-ink-3 shrink-0">
          <span>
            {props.loading ? 'Loading…' : `${props.total} ticket${props.total === 1 ? '' : 's'}`}
          </span>
          {props.showSort && (
            <div className="flex items-center gap-1.5">
              <Menu<SortField>
                value={props.sort.field}
                onChange={(field) => props.onSort({ field, direction: field === 'sla_next_due_at' ? 'asc' : props.sort.direction })}
                options={SORT_FIELDS.map((f) => ({ value: f, label: SORT_LABEL[f] }))}
                trigger={() => (
                  <span className="btn btn-ghost btn-xs">
                    <ArrowDownUp className="w-3.5 h-3.5" /> {SORT_LABEL[props.sort.field]}
                  </span>
                )}
              />
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => props.onSort({ ...props.sort, direction: props.sort.direction === 'asc' ? 'desc' : 'asc' })}
              >
                {props.sort.direction === 'asc' ? 'Ascending' : 'Descending'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full text-ui border-separate border-spacing-0">
          <thead className="sticky top-0 z-[1] bg-surface-2 text-2xs uppercase tracking-wide text-ink-3">
            <tr>
              <th className="w-10 px-4 py-2 border-b border-line text-left">
                {props.canEdit && (<input
                  type="checkbox"
                  aria-label="Select all tickets on this page"
                  checked={allSelected}
                  onChange={(e) => props.onToggleAll(e.target.checked)}
                  className="accent-[var(--ds-accent)]"
                />)}
              </th>
              <th className="px-2 py-2 border-b border-line text-left font-semibold">Ticket</th>
              <th className="px-2 py-2 border-b border-line text-left font-semibold hidden md:table-cell">Requester</th>
              <th className="px-2 py-2 border-b border-line text-left font-semibold">Status</th>
              <th className="px-2 py-2 border-b border-line text-left font-semibold hidden sm:table-cell">SLA</th>
              <th className="px-2 py-2 border-b border-line text-left font-semibold hidden lg:table-cell">Priority</th>
              <th className="px-2 py-2 border-b border-line text-left font-semibold hidden lg:table-cell">Assignee</th>
              <th className="px-4 py-2 border-b border-line text-right font-semibold">Updated</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => {
              const isSelected = selected.has(t.id);
              return (
                <tr
                  key={t.id}
                  tabIndex={0}
                  aria-label={`Ticket #${t.number}: ${t.subject || 'no subject'}`}
                  onClick={() => props.onOpen(t.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      props.onOpen(t.id);
                    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const row = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
                      (row as HTMLElement | null)?.focus();
                    }
                  }}
                  className={cn('cursor-pointer group outline-offset-[-2px]', isSelected ? 'bg-accent-soft/60' : 'hover:bg-surface-2')}
                >
                  <td className="px-4 py-2.5 border-b border-line" onClick={(e) => e.stopPropagation()}>
                    {props.canEdit && (
                    <input
                      type="checkbox"
                      aria-label={`Select ticket #${t.number}`}
                      checked={isSelected}
                      onChange={() => props.onToggle(t.id)}
                      className="accent-[var(--ds-accent)]"
                    />
                    )}
                  </td>
                  <td className="px-2 py-2.5 border-b border-line max-w-0 w-[45%]">
                    <div className="flex items-center gap-2 min-w-0">
                      <ChannelIcon channel={t.channel} />
                      <span className="text-ink-3 tabular-nums shrink-0">#{t.number}</span>
                      <span className="font-semibold text-ink truncate">{t.subject || '(no subject)'}</span>
                    </div>
                    {(t.tags.length > 0 || t.matched_on) && (
                      <div className="flex items-center gap-1 mt-1 pl-6 min-w-0 overflow-hidden">
                        {t.matched_on && (
                          <span className="text-2xs text-accent font-medium shrink-0">matched {MATCH_LABEL[t.matched_on] ?? t.matched_on}</span>
                        )}
                        {t.tags.slice(0, 4).map((tag) => (
                          <span key={tag} className="px-1.5 rounded bg-surface-3 text-2xs text-ink-2 shrink-0">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2.5 border-b border-line text-ink-2 hidden md:table-cell max-w-[180px] truncate">
                    {t.requester?.name || t.requester?.email || 'Unknown'}
                  </td>
                  <td className="px-2 py-2.5 border-b border-line">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <StatusBadge status={t.status} />
                      <CsatBadge ticket={t} compact />
                    </div>
                    <SlaBadge ticket={t} className="mt-1 sm:hidden" />
                  </td>
                  <td className="px-2 py-2.5 border-b border-line hidden sm:table-cell">
                    <SlaBadge ticket={t} />
                  </td>
                  <td className="px-2 py-2.5 border-b border-line hidden lg:table-cell">
                    <PriorityLabel priority={t.priority} />
                  </td>
                  <td className="px-2 py-2.5 border-b border-line hidden lg:table-cell">
                    {t.assignee_id ? (
                      <span className="inline-flex items-center gap-1.5 text-ink-2">
                        <Avatar name={agentName(t.assignee_id) || '?'} seed={t.assignee_id} size="xs" />
                        <span className="truncate max-w-[120px]">{agentName(t.assignee_id) || 'Former agent'}</span>
                      </span>
                    ) : (
                      <span className="text-ink-3">Unassigned</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 border-b border-line text-right text-ink-3 whitespace-nowrap" title={t.updated_at}>
                    {timeAgo(t.updated_at)}
                  </td>
                </tr>
              );
            })}
            {props.loading &&
              tickets.length === 0 &&
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={`sk-${i}`} aria-hidden="true">
                  <td className="px-4 py-3 border-b border-line">
                    <div className="skeleton w-4 h-4" />
                  </td>
                  <td className="px-2 py-3 border-b border-line">
                    <div className="skeleton h-3.5 w-3/4" />
                  </td>
                  <td className="px-2 py-3 border-b border-line hidden md:table-cell">
                    <div className="skeleton h-3 w-24" />
                  </td>
                  <td className="px-2 py-3 border-b border-line">
                    <div className="skeleton h-5 w-14 rounded-full" />
                  </td>
                  <td className="px-2 py-3 border-b border-line hidden lg:table-cell">
                    <div className="skeleton h-3 w-16" />
                  </td>
                  <td className="px-2 py-3 border-b border-line hidden lg:table-cell">
                    <div className="skeleton h-3 w-24" />
                  </td>
                  <td className="px-4 py-3 border-b border-line">
                    <div className="skeleton h-3 w-12 ml-auto" />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {!props.loading && tickets.length === 0 && (
          <EmptyState type="custom" title={props.emptyText} description="Tickets appear here as customers start conversations, or create one with New." className="py-14" />
        )}
      </div>

      {pages > 1 && (
        <div className="h-11 px-4 flex items-center justify-end gap-2 border-t border-line text-xs text-ink-3 shrink-0">
          <span>
            Page {props.page + 1} of {pages}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={props.page === 0}
            onClick={() => props.onPage(props.page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={props.page + 1 >= pages}
            onClick={() => props.onPage(props.page + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function BulkBar({ selected, tickets, agents, onBulk, onMerge, onToggleAll }: Props) {
  const [busy, setBusy] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tag, setTag] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const chosen = tickets.filter((t) => selected.has(t.id));

  return (
    <div className="h-11 px-4 flex items-center gap-2 border-b border-accent-line bg-accent-soft shrink-0">
      <span className="text-xs font-semibold text-accent mr-1">{selected.size} selected</span>

      <Menu<string>
        value=""
        label="Assign selected tickets"
        onChange={(v) => run(() => onBulk({ assigneeId: v === '__none' ? null : v }))}
        options={[{ value: '__none', label: 'Unassigned' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
        trigger={() => (
          <span className={cn('btn btn-secondary btn-xs', busy && 'opacity-50 pointer-events-none')}>
            <UserPlus className="w-3.5 h-3.5" /> Assign
          </span>
        )}
      />
      <Menu<TicketStatus>
        value={'' as TicketStatus}
        label="Change status of selected tickets"
        onChange={(status) => run(() => onBulk({ status }))}
        options={SETTABLE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
        trigger={() => (
          <span className={cn('btn btn-secondary btn-xs', busy && 'opacity-50 pointer-events-none')}>Status</span>
        )}
      />
      {tagOpen ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!tag.trim()) return;
            run(async () => {
              await onBulk({ addTag: tag });
              setTag('');
              setTagOpen(false);
            });
          }}
        >
          <input
            autoFocus
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="tag"
            aria-label="Tag to add"
            className={cn(inputClass, 'h-7 w-32 text-xs')}
          />
          <button type="submit" className="btn btn-accent btn-xs" disabled={busy}>
            Add
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setTagOpen(false)} aria-label="Cancel">
            <X className="w-3.5 h-3.5" />
          </button>
        </form>
      ) : (
        <button type="button" className="btn btn-secondary btn-xs" onClick={() => setTagOpen(true)} disabled={busy}>
          <Tag className="w-3.5 h-3.5" /> Add tag
        </button>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-xs"
        disabled={busy || chosen.length < 2}
        title={chosen.length < 2 ? 'Select at least two tickets on this page to merge' : undefined}
        onClick={() => setMergeOpen(true)}
      >
        <GitMerge className="w-3.5 h-3.5" /> Merge
      </button>
      <button type="button" className="btn btn-ghost btn-xs ml-auto" onClick={() => onToggleAll(false)}>
        Clear
      </button>

      {mergeOpen && (
        <MergeDialog
          tickets={chosen}
          onClose={() => setMergeOpen(false)}
          onMerge={(target) =>
            run(async () => {
              await onMerge(
                target,
                chosen.map((t) => t.id).filter((id) => id !== target)
              );
              setMergeOpen(false);
            })
          }
          busy={busy}
        />
      )}
    </div>
  );
}

function MergeDialog({
  tickets,
  onClose,
  onMerge,
  busy,
}: {
  tickets: TicketListItem[];
  onClose: () => void;
  onMerge: (targetId: string) => void;
  busy: boolean;
}) {
  const open = tickets.filter((t) => t.status !== 'closed');
  const [target, setTarget] = useState(open[0]?.id ?? '');
  const closed = tickets.filter((t) => t.status === 'closed');
  return (
    <Modal
      title="Merge tickets"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-accent btn-sm"
            disabled={busy || !target || closed.length > 0}
            onClick={() => onMerge(target)}
          >
            Merge into #{tickets.find((t) => t.id === target)?.number}
          </button>
        </>
      }
    >
      <p className="text-ui text-ink-2">
        The other tickets&apos; conversations move into the one you keep, an internal note is added to each, and they are
        closed. This cannot be undone.
      </p>
      {closed.length > 0 && (
        <p className="text-xs text-danger">
          Closed tickets cannot be merged: {closed.map((t) => `#${t.number}`).join(', ')}. Deselect them first.
        </p>
      )}
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-semibold text-ink-2 mb-1.5">Keep this ticket</legend>
        {open.map((t) => (
          <label
            key={t.id}
            className={cn(
              'flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer text-ui',
              target === t.id ? 'border-accent-line bg-accent-soft' : 'border-line hover:bg-surface-2'
            )}
          >
            <input type="radio" name="merge-target" checked={target === t.id} onChange={() => setTarget(t.id)} />
            <span className="text-ink-3 tabular-nums">#{t.number}</span>
            <span className="truncate text-ink">{t.subject || '(no subject)'}</span>
          </label>
        ))}
      </fieldset>
    </Modal>
  );
}
