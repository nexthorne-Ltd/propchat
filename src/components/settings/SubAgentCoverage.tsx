'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, CircleSlash, RefreshCw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { errorMessage } from '@/lib/errors/user-error';
import { cn } from '@/lib/utils';
import { getSubAgentCoverageAction } from '@/app/actions/helpdesk';
import type { SpecialistCoverage } from '@/lib/ai/coverage';

/**
 * Inside Settings → AI bot → Knowledge sources: which sub-agent the help
 * centre leaves without an answer. Each specialist's checklist
 * (src/lib/ai/coverage.ts) is searched in the published articles and Bot
 * knowledge; what is not found is listed, so the team writes that article in
 * Helpdesk and re-indexes. Re-checked whenever `refreshKey` changes (after a
 * re-index run) and on "Check again".
 */
export function SubAgentCoverage({ workspaceId, refreshKey = 0 }: { workspaceId: string; refreshKey?: number }) {
  const [report, setReport] = useState<SpecialistCoverage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const apply = useCallback((next: SpecialistCoverage[]) => {
    setReport(next);
    setError(null);
    // Open the specialists with gaps the first time, so the gaps are in view.
    setOpen((prev) => (prev.size ? prev : new Set(next.filter((s) => s.enabled && s.covered < s.total).map((s) => s.agent))));
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      apply(await getSubAgentCoverageAction(workspaceId));
    } catch (err) {
      setError(errorMessage(err, 'Could not check the knowledge coverage.'));
    } finally {
      setChecking(false);
    }
  }, [workspaceId, apply]);

  // First check, and again after each re-index run (refreshKey).
  useEffect(() => {
    let cancelled = false;
    getSubAgentCoverageAction(workspaceId)
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Could not check the knowledge coverage.'));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey, apply]);

  if (!report && checking) return <LoadingState label="Checking which specialists have their answers…" />;
  if (!report && error) return <ErrorState title="Could not check the coverage" message={error} onRetry={() => void check()} />;
  if (!report) return null;

  const active = report.filter((s) => s.enabled);
  const missing = active.reduce((n, s) => n + (s.total - s.covered), 0);
  const thin = active.filter((s) => s.covered < s.total);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3" aria-busy={checking}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-ui font-medium text-ink">Knowledge by specialist</p>
          <p className="text-xs text-ink-2">
            What each sub-agent needs to answer traders. The AI reads your published articles and Bot knowledge, so your own wording counts (e.g. "reward share" for profit split).
          </p>
        </div>
        <Button variant="secondary" size="xs" loading={checking} onClick={() => void check()}>
          {!checking && <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          Check again
        </Button>
      </div>

      {missing === 0 ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-success-line bg-success-soft p-3 text-ui text-ink">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          Every specialist has its answers in your help center.
        </p>
      ) : (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-warn-line bg-warn-soft p-3 text-ui text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
          <span>
            {thin.length} {thin.length === 1 ? 'specialist is' : 'specialists are'} missing {missing} {missing === 1 ? 'topic' : 'topics'}:{' '}
            {thin.map((s) => s.name).join(', ')}. Without these the bot hands those questions to your team. Add the articles in
            Helpdesk, then re-index above.
          </span>
        </p>
      )}

      <ul className="divide-y divide-line rounded-lg border border-line">
        {report.map((s) => {
          const gaps = s.total - s.covered;
          const expanded = open.has(s.agent);
          return (
            <li key={s.agent}>
              <button
                type="button"
                onClick={() => toggle(s.agent)}
                aria-expanded={expanded}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {!s.enabled ? (
                    <CircleSlash className="h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
                  ) : gaps ? (
                    <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  )}
                  <span className="truncate text-ui font-medium text-ink">{s.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {!s.enabled ? (
                    <Badge tone="neutral">Off</Badge>
                  ) : gaps ? (
                    <Badge tone="warn">{gaps} missing</Badge>
                  ) : (
                    <Badge tone="success">
                      {s.covered}/{s.total}
                    </Badge>
                  )}
                  <ChevronDown className={cn('h-4 w-4 text-ink-3 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
                </span>
              </button>
              {expanded && (
                <div className="px-3 pb-3">
                  {!s.enabled ? (
                    <p className="text-xs text-ink-2">Switched off in Sub-agents: its questions go to your team, so nothing to fill here.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {s.items.map((item) => (
                        <li key={item.id} className="flex items-start gap-2 text-xs">
                          {item.covered ? (
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-label="Covered" />
                          ) : (
                            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-label="Missing" />
                          )}
                          <span className={item.covered ? 'text-ink-2' : 'text-ink'}>
                            {item.label}
                            {item.covered && item.article ? <span className="text-ink-3"> · {item.article}</span> : null}
                            {!item.covered ? <span className="text-ink-3"> · no article found</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && report && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
