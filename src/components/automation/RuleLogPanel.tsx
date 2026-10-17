'use client';

import React, { useEffect, useState } from 'react';
import { getRuleLogAction, type RuleRunRow } from '@/app/actions/automation';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/States';
import { Field, Input } from '@/components/ui/Input';
import { describeAction } from '@/lib/automation/rules';
import { FormSkeleton } from '@/components/settings/parts';
import { errorMessage } from '@/lib/errors/user-error';

const EVENT_LABEL: Record<string, string> = { created: 'Ticket created', updated: 'Ticket updated', message: 'New message', hourly: 'Hourly run' };
const OUTCOME: Record<RuleRunRow['outcome'], { label: string; tone: BadgeTone }> = {
  fired: { label: 'Fired', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped_loop: { label: 'Stopped: loop', tone: 'warn' },
};

/** Settings → Automation → Rule log: which rules fired on which ticket. */
export function RuleLogPanel({ workspaceId }: { workspaceId: string }) {
  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState<number | null>(null);
  const [runs, setRuns] = useState<RuleRunRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let live = true;
    getRuleLogAction(workspaceId, { ticketNumber: applied })
      .then((res) => {
        if (!live) return;
        if (!res.success) return setError(res.error);
        setRuns(res.runs);
        setHasMore(res.hasMore);
      })
      .catch((e) => live && setError(errorMessage(e) || 'Could not load the rule log.'));
    return () => {
      live = false;
    };
  }, [workspaceId, applied, attempt]);

  const reset = () => {
    setError(null);
    setRuns(null);
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(filter.replace('#', ''));
    reset();
    setApplied(Number.isInteger(n) && n > 0 ? n : null);
  }

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field label="Show one ticket" hint="Ticket number, such as 1001. Leave empty for everything." className="w-56">
          <Input inputMode="numeric" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="All tickets" />
        </Field>
        <Button type="submit">Show</Button>
        {applied && (
          <Button
            variant="ghost"
            onClick={() => {
              setFilter('');
              reset();
              setApplied(null);
            }}
          >
            Clear
          </Button>
        )}
      </form>

      {error ? (
        <ErrorState
          title="Could not load the rule log"
          message={error}
          onRetry={() => {
            reset();
            setAttempt((n) => n + 1);
          }}
        />
      ) : !runs ? (
        <FormSkeleton rows={4} />
      ) : runs.length === 0 ? (
        <div className="card p-4">
          <EmptyState
            type="custom"
            title={applied ? `No rules have run on #${applied}` : 'Nothing has fired yet'}
            description="When a trigger or automation changes a ticket or queues an email, it is listed here with what it did."
          />
        </div>
      ) : (
        <>
          <ul className="card divide-y divide-line">
            {runs.map((r) => (
              <li key={r.id} className="px-4 py-3 space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>
                  <span className="text-ui font-semibold text-ink">{r.rule_name}</span>
                  <span className="text-xs text-ink-3">{r.kind === 'trigger' ? 'Trigger' : 'Automation'} · {EVENT_LABEL[r.event] ?? r.event}</span>
                  <time className="text-xs text-ink-3 ml-auto" dateTime={r.created_at}>
                    {new Date(r.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </time>
                </div>
                <p className="text-xs text-ink-2">
                  Ticket #{r.ticket?.number ?? '?'}
                  {r.ticket?.subject ? ` “${r.ticket.subject}”` : ''}
                  {r.outcome === 'fired' && r.summary.length > 0 && <> — {r.summary.map((a) => describeAction(a)).join(' · ')}</>}
                </p>
                {r.error && <p className="text-xs text-danger">{r.error}</p>}
              </li>
            ))}
          </ul>
          {hasMore && (
            <Button
              size="sm"
              loading={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                const res = await getRuleLogAction(workspaceId, { ticketNumber: applied, before: runs[runs.length - 1].created_at });
                setLoadingMore(false);
                if (!res.success) return setError(res.error);
                setRuns([...runs, ...res.runs]);
                setHasMore(res.hasMore);
              }}
            >
              Load older entries
            </Button>
          )}
        </>
      )}
    </div>
  );
}
