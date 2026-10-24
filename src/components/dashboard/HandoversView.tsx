'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Clock, Hand, Languages, RefreshCw, Search, UserRound } from 'lucide-react';
import type { Agent, Workspace } from '@/types/database';
import { createClient } from '@/lib/supabase/client';
import { friendlyReason, loadHandovers, type HandoverItem, type HandoverState } from '@/lib/inbox/handovers';
import { cn, formatTimeAgo } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { Input } from '@/components/ui/Input';
import { ErrorState, SkeletonBlock } from '@/components/ui/States';

type Tab = HandoverState | 'all';

const PRIORITY_TONE: Record<HandoverItem['priority'], BadgeTone> = {
  urgent: 'danger',
  high: 'warn',
  normal: 'neutral',
  low: 'neutral',
};

const STATE_BADGE: Record<HandoverState, { tone: BadgeTone; label: string }> = {
  waiting: { tone: 'accent', label: 'Waiting for you' },
  answered: { tone: 'success', label: 'Answered' },
  closed: { tone: 'neutral', label: 'Closed without reply' },
};

/**
 * Every question the bot passed to the team, the waiting ones on top. The
 * conversation list mixes them with everything else; here an agent sees what
 * the customer asked, why the bot stepped aside and how long they have
 * waited, and opens the chat to answer. Read-only: answering happens in the
 * chat, which is what clears a card (fn_human_reply_takes_over).
 */
export function HandoversView({
  workspace,
  currentAgent,
  waitingCount,
  onOpenConversation,
}: {
  workspace: Workspace | null;
  currentAgent: Agent | null;
  /** From the live conversation list: a change means a handover came in or was answered. */
  waitingCount: number;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [items, setItems] = useState<HandoverItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('waiting');
  const [query, setQuery] = useState('');
  const [mineOnly, setMineOnly] = useState(false);

  const workspaceId = workspace?.id;

  // State is set only after the query returns, so the effects below can
  // call this directly; the spinner is the Refresh button's own business.
  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const next = await loadHandovers(createClient(), workspaceId);
      setItems(next);
      setError(null);
    } catch (err) {
      console.error('[Handovers Load Error]:', err);
      setError(errorMessage(err, "Couldn't load handovers"));
    }
  }, [workspaceId]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void load();
    };
    const first = setTimeout(run, 0);
    // The waiting time on each card is only right if the list is fresh.
    const timer = setInterval(run, 60_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, waitingCount]);

  const counts = useMemo(() => {
    const c = { waiting: 0, answered: 0, closed: 0, all: 0 };
    for (const i of items || []) {
      c[i.state] += 1;
      c.all += 1;
    }
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items || []).filter((i) => {
      if (tab !== 'all' && i.state !== tab) return false;
      if (mineOnly && i.assignedAgentId !== currentAgent?.id) return false;
      if (!q) return true;
      return [i.question, i.reason, i.summary, i.visitorName, i.visitorEmail, i.topic]
        .some((s) => s?.toLowerCase().includes(q));
    });
  }, [items, tab, query, mineOnly, currentAgent?.id]);

  return (
    <div className="flex-1 flex flex-col h-full bg-canvas overflow-y-auto">
      <header className="shrink-0 px-4 sm:px-6 pt-5 pb-4 border-b border-line bg-surface">
        <div className="max-w-4xl mx-auto flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-accent-soft text-accent flex items-center justify-center shrink-0">
              <Hand className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="text-md font-semibold text-ink">Handovers</h1>
              <p className="text-xs text-ink-3">
                Questions the bot passed to your team. Answer the waiting ones first; a card clears as soon as someone replies in the chat.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="btn btn-sm btn-secondary shrink-0"
            aria-label="Refresh handovers"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} aria-hidden="true" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>

        <div className="max-w-4xl mx-auto mt-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <Tabs<Tab>
            variant="pill"
            label="Handover status"
            value={tab}
            onChange={setTab}
            className="overflow-x-auto"
            items={[
              { id: 'waiting', label: 'Waiting', count: counts.waiting },
              { id: 'answered', label: 'Answered', count: counts.answered },
              { id: 'closed', label: 'Closed', count: counts.closed },
              { id: 'all', label: 'All', count: counts.all },
            ]}
          />
          <div className="flex items-center gap-3 sm:ml-auto">
            <label className="flex items-center gap-1.5 text-xs text-ink-2 cursor-pointer select-none whitespace-nowrap">
              <input
                type="checkbox"
                checked={mineOnly}
                onChange={(e) => setMineOnly(e.target.checked)}
                className="accent-[var(--ds-accent)]"
              />
              Assigned to me
            </label>
            <div className="relative flex-1 sm:w-56">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" aria-hidden="true" />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search questions…"
                aria-label="Search handovers"
                className="w-full pl-8"
              />
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-5">
        <div className="max-w-4xl mx-auto">
          {items === null && !error ? (
            <div className="space-y-3" role="status" aria-label="Loading handovers">
              {[0, 1, 2].map((n) => (
                <div key={n} className="rounded-2xl border border-line bg-surface p-4 space-y-3">
                  <SkeletonBlock className="h-4 w-1/3 rounded" />
                  <SkeletonBlock className="h-10 w-full rounded-lg" />
                  <SkeletonBlock className="h-3 w-1/2 rounded" />
                </div>
              ))}
            </div>
          ) : error && !items ? (
            <ErrorState title="Couldn't load handovers" message={error} onRetry={() => void refresh()} />
          ) : visible.length === 0 ? (
            <div className="py-16 text-center rounded-2xl border border-dashed border-line bg-surface p-8">
              <div className="w-12 h-12 rounded-2xl bg-success-soft text-success flex items-center justify-center mx-auto">
                <Hand className="w-6 h-6" aria-hidden="true" />
              </div>
              <h2 className="mt-3 text-sm font-semibold text-ink">
                {query || mineOnly ? 'Nothing matches' : tab === 'waiting' ? 'Nobody is waiting' : 'No handovers here'}
              </h2>
              <p className="mt-1 text-xs text-ink-3 max-w-sm mx-auto">
                {query || mineOnly
                  ? 'Try another search, or turn off "Assigned to me".'
                  : tab === 'waiting'
                  ? 'Every question the bot passed on has an answer. New handovers appear here the moment they happen.'
                  : 'Handovers from the last 14 days show up here.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {error && (
                <li role="alert" className="px-3 py-2 rounded-lg border border-danger-line bg-danger-soft text-xs text-danger">
                  Couldn&apos;t refresh: {error}
                </li>
              )}
              {visible.map((item) => (
                <HandoverCard
                  key={item.id}
                  item={item}
                  mine={item.assignedAgentId === currentAgent?.id}
                  onOpen={() => onOpenConversation(item.conversationId)}
                />
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

function HandoverCard({ item, mine, onOpen }: { item: HandoverItem; mine: boolean; onOpen: () => void }) {
  const who = item.visitorName || item.visitorEmail || 'Customer';
  const reasonLabel = friendlyReason(item.reason);
  const state = STATE_BADGE[item.state];
  const waiting = item.state === 'waiting';

  return (
    <li
      className={cn(
        'rounded-2xl border bg-surface p-4 transition-colors',
        waiting ? 'border-line-2 shadow-xs' : 'border-line opacity-90'
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar name={who} seed={item.visitorEmail || item.conversationId} size="sm" className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ui font-semibold text-ink truncate max-w-full">{who}</span>
            {item.visitorName && item.visitorEmail && (
              <span className="text-xs text-ink-3 truncate max-w-full">{item.visitorEmail}</span>
            )}
            <span className="ml-auto flex items-center gap-1 text-xs text-ink-3 whitespace-nowrap" title={new Date(item.at).toLocaleString()}>
              <Clock className="w-3 h-3" aria-hidden="true" />
              {waiting ? `Waiting ${formatTimeAgo(item.at)}` : formatTimeAgo(item.at)}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={state.tone} dot>{state.label}</Badge>
            {item.priority !== 'normal' && item.priority !== 'low' && (
              <Badge tone={PRIORITY_TONE[item.priority]} className="capitalize">{item.priority}</Badge>
            )}
            {item.frustrated && <Badge tone="danger">Upset</Badge>}
          </div>
        </div>
      </div>

      <blockquote className="mt-3 px-3 py-2.5 rounded-xl bg-surface-2 border border-line text-ui text-ink whitespace-pre-wrap break-words">
        {item.question}
      </blockquote>

      <dl className="mt-3 grid gap-1.5 text-xs">
        {(reasonLabel || item.reason) && (
          <div className="flex gap-2">
            <dt className="text-ink-3 shrink-0 w-24">Why handed over</dt>
            <dd className="text-ink-2 min-w-0" title={item.reason || undefined}>
              {reasonLabel || item.reason}
            </dd>
          </div>
        )}
        {item.summary && (
          <div className="flex gap-2">
            <dt className="text-ink-3 shrink-0 w-24">Bot&apos;s reading</dt>
            <dd className="text-ink-2 min-w-0">{item.summary}</dd>
          </div>
        )}
        {item.earlier && (
          <div className="flex gap-2">
            <dt className="text-ink-3 shrink-0 w-24">Asked before</dt>
            <dd className="text-ink-2 min-w-0 break-words">{item.earlier}</dd>
          </div>
        )}
        {item.given && (
          <div className="flex gap-2">
            <dt className="text-ink-3 shrink-0 w-24">Already gave</dt>
            <dd className="text-ink-2 min-w-0 break-words">{item.given}</dd>
          </div>
        )}
      </dl>

      <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-1 text-xs text-ink-3">
          <UserRound className="w-3.5 h-3.5" aria-hidden="true" />
          {mine ? 'Assigned to you' : item.assignedAgentName ? `Assigned to ${item.assignedAgentName}` : 'Unassigned'}
        </span>
        {item.language && (
          <span className="flex items-center gap-1 text-xs text-ink-3">
            <Languages className="w-3.5 h-3.5" aria-hidden="true" />
            {item.language}
          </span>
        )}
        <button
          type="button"
          onClick={onOpen}
          className={cn('btn btn-sm ml-auto', waiting ? 'btn-primary' : 'btn-secondary')}
        >
          {waiting ? 'Open chat & answer' : 'Open chat'}
          <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
