'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Globe, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SkeletonBlock } from '@/components/ui/States';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';
import {
  getVercelDomainsAction,
  syncVercelDomainsAction,
  type DomainSyncResult,
  type ExpectedDomainKind,
  type VercelDomainsView,
} from '@/app/actions/vercel-setup';

const KIND_LABEL: Record<ExpectedDomainKind, string> = {
  platform: 'Platform',
  help_base: 'Help center base',
  help_wildcard: 'Help center subdomains',
  workspace: 'Customer domain',
};

/**
 * Which Vercel project the app adds domains to, and which domains it should
 * have but does not. Built for after a project move, when domains silently
 * stopped reaching the new project.
 */
export function VercelDomainsCard() {
  const [view, setView] = useState<VercelDomainsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [results, setResults] = useState<DomainSyncResult[] | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getVercelDomainsAction();
      if (res.success) setView(res.view);
      else setLoadError(res.error);
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not check the Vercel setup.'));
    } finally {
      setLoading(false);
    }
  }, []);

  // First load without setting state synchronously inside the effect.
  useEffect(() => {
    let alive = true;
    getVercelDomainsAction()
      .then((res) => {
        if (!alive) return;
        if (res.success) setView(res.view);
        else setLoadError(res.error);
      })
      .catch((err) => alive && setLoadError(errorMessage(err, 'Could not check the Vercel setup.')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const sync = async () => {
    setSyncing(true);
    setSyncError(null);
    setResults(null);
    try {
      const res = await syncVercelDomainsAction();
      if (res.success) {
        setResults(res.results);
        setView(res.view);
      } else {
        setSyncError(res.error);
      }
    } catch (err) {
      setSyncError(errorMessage(err, 'The sync could not run.'));
    } finally {
      setSyncing(false);
    }
  };

  const missing = view?.expected.filter((d) => !d.onProject) ?? [];
  const setup = view?.setup;

  return (
    <section className="bg-surface border border-line rounded-2xl p-5 shadow-xs space-y-4" aria-labelledby="vercel-domains-title">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h3 id="vercel-domains-title" className="text-sm font-bold text-ink flex items-center gap-2">
            <Globe className="w-4 h-4 text-accent" aria-hidden="true" /> Vercel domains
          </h3>
          <p className="text-xs text-ink-3 mt-0.5">
            Every customer domain, the help-center domains and the platform domain must be attached to the Vercel project this app runs on.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading && !!view} disabled={syncing}>
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Check
          </Button>
          <Button size="sm" onClick={() => void sync()} loading={syncing} disabled={loading || !setup?.project || missing.length === 0}>
            Add missing domains{missing.length ? ` (${missing.length})` : ''}
          </Button>
        </div>
      </div>

      {loading && !view ? (
        <SkeletonBlock className="h-24 rounded-xl" />
      ) : loadError ? (
        <p role="alert" className="text-xs text-danger">{loadError}</p>
      ) : view && setup ? (
        <>
          <div
            className={cn(
              'rounded-xl border p-3 text-xs space-y-1',
              setup.project ? 'border-line bg-surface-2 text-ink-2' : 'border-danger-line bg-danger-soft text-ink'
            )}
          >
            {setup.project ? (
              <p className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-success shrink-0" aria-hidden="true" />
                Connected to project <span className="font-semibold text-ink">{setup.project.name || setup.project.id}</span>
                {setup.env.teamId ? ' (team set)' : ' (personal account, no VERCEL_TEAM_ID)'}.
              </p>
            ) : (
              <p className="flex items-start gap-1.5">
                <XCircle className="w-4 h-4 text-danger shrink-0" aria-hidden="true" />
                <span>{setup.error}</span>
              </p>
            )}
            <p>
              Settings on this deployment: VERCEL_TOKEN {setup.env.token ? '✓' : '✗'} · VERCEL_PROJECT_ID {setup.env.projectId ? '✓' : '✗'} · VERCEL_TEAM_ID{' '}
              {setup.env.teamId ? '✓' : '–'}
            </p>
            {setup.project && setup.error && <p className="text-warn">{setup.error}</p>}
          </div>

          {view.expected.length === 0 ? (
            <p className="text-xs text-ink-3">No domains expected yet: no platform URL, help-center base domain or customer domain is configured.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {view.expected.map((d) => (
                <li key={d.domain} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                  <span className="min-w-0">
                    <span className="font-medium text-ink break-all">{d.domain}</span>
                    <span className="text-ink-3"> · {KIND_LABEL[d.kind]}{d.workspaceName ? ` · ${d.workspaceName}` : ''}</span>
                  </span>
                  {d.onProject ? (
                    d.verified ? <Badge tone="success">On project</Badge> : <Badge tone="warn">On project, DNS pending</Badge>
                  ) : (
                    <Badge tone="danger">Missing</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {syncError && <p role="alert" className="text-xs text-danger">{syncError}</p>}
      {results && (
        <div className="space-y-1.5" role="status">
          {results.length === 0 && <p className="text-xs text-ink-2">Nothing was missing.</p>}
          {results.map((r) => (
            <p key={r.domain} className={cn('flex items-start gap-1.5 text-xs', r.status === 'added' ? 'text-success' : 'text-danger')}>
              {r.status === 'added' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              )}
              <span className="break-words">
                <span className="font-medium">{r.domain}</span>:{' '}
                {r.status === 'added' ? (r.needsDns ? 'added; the customer still needs to set the DNS records Vercel shows.' : 'added.') : r.message}
              </span>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
