'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import {
  bulkUpdateTicketsAction,
  createTicketAction,
  deleteTicketViewAction,
  getTicketsBootstrapAction,
  getViewCountsAction,
  listTicketsAction,
  mergeTicketsAction,
  saveTicketViewAction,
  searchTicketsAction,
  type TicketListItem,
  type TicketsBootstrap,
} from '@/app/actions/tickets';
import type { TicketSort, ViewDefinition } from '@/lib/tickets/views';
import { TicketList } from './TicketList';
import { TicketDetail } from './TicketDetail';
import { NewTicketDialog, ViewEditor } from './TicketDialogs';
import { roleCan } from '@/lib/team/permissions';
import { inputClass } from './TicketBits';
import { ErrorState } from '@/components/ui/States';
import { errorMessage } from '@/lib/errors/user-error';

const DEFAULT_VIEW = 'system:all_open';

/**
 * The ticketing inbox: views with live counts on the left, the selected
 * view's tickets (or search results) in the middle, a ticket when opened.
 */
export function TicketsView({
  workspaceId,
  request,
}: {
  workspaceId: string;
  /** Set by the command palette: open a view or a ticket. `nonce` makes repeats count. */
  request?: { viewId?: string; ticketId?: string; nonce: number } | null;
}) {
  const [boot, setBoot] = useState<TicketsBootstrap | null>(null);
  // Light agents read tickets and add notes; creating and bulk changes are for the other roles.
  const canEdit = roleCan(boot?.me.role, 'edit_ticket');
  const [viewId, setViewId] = useState(DEFAULT_VIEW);
  const [sortOverride, setSortOverride] = useState<TicketSort | null>(null);
  const [page, setPage] = useState(0);
  const [list, setList] = useState<{ key: string; tickets: (TicketListItem & { matched_on?: string })[]; total: number }>({
    key: '',
    tickets: [],
    total: 0,
  });
  // Bumped to refetch without changing what is asked for (realtime, edits).
  const [refreshTick, setRefreshTick] = useState(0);
  const [bootTick, setBootTick] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<ViewDefinition | 'new' | null>(null);
  const [creating, setCreating] = useState(false);

  const view = boot?.views.find((v) => v.id === viewId) ?? null;
  const sort = sortOverride ?? view?.sort ?? { field: 'updated_at', direction: 'desc' };

  const listKey = JSON.stringify({ viewId, sortOverride, page, activeSearch });
  const loading = list.key !== listKey;

  useEffect(() => {
    let cancelled = false;
    getTicketsBootstrapAction(workspaceId)
      .then((b) => !cancelled && setBoot(b))
      .catch((err: Error) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, bootTick]);

  useEffect(() => {
    let cancelled = false;
    const request = activeSearch
      ? searchTicketsAction(workspaceId, activeSearch).then((r) => ({ tickets: r.tickets, total: r.tickets.length }))
      : listTicketsAction(workspaceId, { viewId, sort: sortOverride ?? undefined, page }).then((r) => ({
          tickets: r.tickets,
          total: r.total,
        }));
    request
      .then((r) => {
        if (cancelled) return;
        setList({ key: listKey, ...r });
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setList((l) => ({ ...l, key: listKey }));
        setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, viewId, sortOverride, page, activeSearch, listKey, refreshTick]);

  // Counts follow every refresh after the first load.
  useEffect(() => {
    if (refreshTick === 0) return;
    let cancelled = false;
    getViewCountsAction(workspaceId)
      .then((counts) => !cancelled && setBoot((b) => (b ? { ...b, counts } : b)))
      .catch(() => {
        /* counts are a convenience; the list shows real errors */
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshTick]);

  // Any ticket change in the workspace (a new chat, a colleague's edit, the
  // auto-close job) refreshes the list and the counts.
  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel(`tickets-${workspaceId}-${Math.random().toString(36).slice(2, 7)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `workspace_id=eq.${workspaceId}` }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => setRefreshTick((t) => t + 1), 400);
      })
      .subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [workspaceId]);

  const selectView = (id: string) => {
    setViewId(id);
    setSortOverride(null);
    setPage(0);
    setSelected(new Set());
    setActiveSearch(null);
    setSearch('');
    setOpenId(null);
  };

  // A palette request is applied once, during render (React's "adjust state
  // when a prop changes" pattern), so there is no flash of the old view.
  const [handledNonce, setHandledNonce] = useState<number | null>(null);
  if (request && request.nonce !== handledNonce) {
    setHandledNonce(request.nonce);
    if (request.viewId) selectView(request.viewId);
    if (request.ticketId) setOpenId(request.ticketId);
  }

  const afterChange = useCallback(() => setRefreshTick((t) => t + 1), []);

  const runBulk = async (change: Parameters<typeof bulkUpdateTicketsAction>[2]) => {
    try {
      const res = await bulkUpdateTicketsAction(workspaceId, Array.from(selected), change);
      setMessage(
        `Updated ${res.updated} ticket${res.updated === 1 ? '' : 's'}.` +
          (res.skipped.length
            ? ` Skipped ${res.skipped.map((s) => (s.number ? `#${s.number}` : 'one')).join(', ')}: ${res.skipped[0].reason}.`
            : '')
      );
      setSelected(new Set());
      afterChange();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const systemViews = useMemo(() => boot?.views.filter((v) => v.system) ?? [], [boot]);
  const savedViews = useMemo(() => boot?.views.filter((v) => !v.system) ?? [], [boot]);

  if (!boot && error) {
    return (
      <ErrorState
        className="flex-1"
        title="Couldn't load tickets"
        message={error}
        onRetry={() => {
          setError(null);
          setBootTick((t) => t + 1);
          setRefreshTick((t) => t + 1);
        }}
      />
    );
  }

  const viewButton = (v: ViewDefinition) => (
    <li key={v.id} className="group flex items-center">
      <button
        type="button"
        onClick={() => selectView(v.id)}
        aria-current={viewId === v.id && !activeSearch ? 'page' : undefined}
        className={cn(
          'flex-1 min-w-0 flex items-center justify-between gap-2 px-2.5 h-8 rounded-lg text-ui text-left',
          viewId === v.id && !activeSearch ? 'bg-accent-soft text-accent font-semibold' : 'text-ink-2 hover:bg-surface-2'
        )}
      >
        <span className="truncate">{v.name}</span>
        <span className="tabular-nums text-xs text-ink-3">{boot?.counts[v.id] ?? '–'}</span>
      </button>
      {!v.system && (v.ownerId === boot?.me.id || boot?.me.isAdmin) && (
        <button
          type="button"
          className="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100 focus:opacity-100"
          aria-label={`Edit view ${v.name}`}
          onClick={() => setEditing(v)}
        >
          <Pencil className="w-3 h-3" />
        </button>
      )}
    </li>
  );

  return (
    <div className="flex-1 flex min-h-0 min-w-0 bg-surface">
      <nav className="w-[230px] shrink-0 border-r border-line flex-col hidden md:flex" aria-label="Ticket views">
        <div className="h-14 px-4 flex items-center justify-between border-b border-line">
          <h1 className="text-md font-bold text-ink">Tickets</h1>
          {canEdit && (
            <button type="button" className="btn btn-accent btn-xs" onClick={() => setCreating(true)}>
              <Plus className="w-3.5 h-3.5" /> New
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {!boot ? (
            <div className="space-y-1.5 px-1" aria-hidden="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="skeleton h-7" />
              ))}
            </div>
          ) : (
            <ul className="space-y-0.5">{systemViews.map(viewButton)}</ul>
          )}
          <div className="flex items-center justify-between mt-4 mb-1 px-2.5">
            <h2 className="text-2xs font-bold uppercase tracking-wide text-ink-3">Saved views</h2>
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditing('new')} aria-label="New view">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          {savedViews.length === 0 ? (
            <p className="px-2.5 text-xs text-ink-3">Save filters you use often as a view.</p>
          ) : (
            <ul className="space-y-0.5">{savedViews.map(viewButton)}</ul>
          )}
        </div>
      </nav>

      {openId ? (
        <TicketDetail
          key={openId}
          workspaceId={workspaceId}
          ticketId={openId}
          agents={boot?.agents ?? []}
          groups={boot?.groups ?? []}
          me={boot?.me ?? null}
          onBack={() => setOpenId(null)}
          onOpenTicket={setOpenId}
          onChanged={afterChange}
        />
      ) : (
        <section className="flex-1 flex flex-col min-w-0">
          <header className="h-14 px-4 flex items-center gap-3 border-b border-line shrink-0">
            <div className="min-w-0 flex-1">
              <h2 className="text-md font-bold text-ink truncate">
                {activeSearch ? `Search: “${activeSearch}”` : view?.name ?? 'Tickets'}
              </h2>
            </div>
            <form
              role="search"
              className="relative w-full max-w-[320px]"
              onSubmit={(e) => {
                e.preventDefault();
                const q = search.trim();
                setSelected(new Set());
                setActiveSearch(q || null);
              }}
            >
              <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="#number, subject, requester or message"
                aria-label="Search tickets"
                className={cn(inputClass, 'pl-8 pr-8')}
              />
              {activeSearch && (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs"
                  aria-label="Clear search"
                  onClick={() => {
                    setSearch('');
                    setActiveSearch(null);
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </form>
            {canEdit && (
              <button type="button" className="btn btn-accent btn-sm md:hidden" onClick={() => setCreating(true)} aria-label="New ticket">
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </header>

          {/* Views as a select on small screens, where the rail is hidden. */}
          <div className="md:hidden px-4 py-2 border-b border-line">
            <select className={inputClass} value={viewId} onChange={(e) => selectView(e.target.value)} aria-label="View">
              {boot?.views.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({boot.counts[v.id] ?? 0})
                </option>
              ))}
            </select>
          </div>

          {(error || message) && (
            <div
              role="status"
              className={cn(
                'px-4 py-2 text-xs border-b flex items-center gap-2',
                error ? 'bg-danger-soft border-danger-line text-danger' : 'bg-success-soft border-success-line text-ink'
              )}
            >
              <span className="flex-1">{error || message}</span>
              <button type="button" className="btn btn-ghost btn-xs" aria-label="Dismiss" onClick={() => (setError(null), setMessage(null))}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <TicketList
            canEdit={canEdit}
            tickets={list.tickets}
            total={list.total}
            page={page}
            loading={loading}
            agents={boot?.agents ?? []}
            selected={selected}
            sort={sort}
            showSort={!activeSearch}
            emptyText={activeSearch ? 'No tickets match that search.' : 'No tickets in this view.'}
            onSort={(s) => {
              setSortOverride(s);
              setPage(0);
            }}
            onPage={(p) => {
              setPage(p);
              setSelected(new Set());
            }}
            onToggle={(id) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onToggleAll={(all) => setSelected(all ? new Set(list.tickets.map((t) => t.id)) : new Set())}
            onOpen={setOpenId}
            onBulk={runBulk}
            onMerge={async (target, sources) => {
              try {
                const merged = await mergeTicketsAction(workspaceId, target, sources);
                setMessage(`Merged ${sources.length} ticket${sources.length === 1 ? '' : 's'} into #${merged.number}.`);
                setSelected(new Set());
                afterChange();
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          />
        </section>
      )}

      {editing && boot && (
        <ViewEditor
          view={editing === 'new' ? null : editing}
          agents={boot.agents}
          groups={boot.groups}
          canShare={boot.me.isAdmin}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            const saved = await saveTicketViewAction(workspaceId, input);
            setBootTick((t) => t + 1);
            selectView(saved.id);
          }}
          onDelete={
            editing !== 'new'
              ? async () => {
                  await deleteTicketViewAction(workspaceId, editing.id);
                  setBootTick((t) => t + 1);
                  selectView(DEFAULT_VIEW);
                }
              : undefined
          }
        />
      )}
      {creating && boot && (
        <NewTicketDialog
          agents={boot.agents}
          groups={boot.groups}
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            const ticket = await createTicketAction(workspaceId, input);
            afterChange();
            setOpenId(ticket.id);
          }}
        />
      )}
    </div>
  );
}
