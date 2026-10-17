'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import {
  getKnowledgeIndexStatusAction,
  reindexKnowledgeBatchAction,
  type KnowledgeIndexStatus,
} from '@/app/actions/helpdesk';
import { SettingsCard, useReportDirty } from './parts';
import { SubAgentCoverage } from './SubAgentCoverage';
import { errorMessage } from '@/lib/errors/user-error';

/** Matches the server's per-request limit. */
const BATCH_SIZE = 5;

interface Failure {
  id: string;
  title: string;
  error: string;
}

/**
 * Settings → AI bot → Knowledge sources. Articles published before an
 * embedding key was set have no embeddings, and nothing re-embeds them until
 * they are edited. This card shows how many are affected and re-indexes them
 * a few at a time from the browser, so a large help centre never hits a
 * serverless time limit and one failing article does not stop the rest.
 */
export function KnowledgeIndexCard({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [status, setStatus] = useState<KnowledgeIndexStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Failure[]>([]);
  // Bumped after a re-index run, so the specialist coverage is checked again.
  const [coverageKey, setCoverageKey] = useState(0);
  const cancelled = useRef(false);

  // Leaving mid-run would stop the remaining batches; the hub warns first.
  useReportDirty(progress !== null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await getKnowledgeIndexStatusAction(workspaceId));
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load the knowledge index.'));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // First load; `load` above is for retries and the refresh after a run.
  useEffect(() => {
    cancelled.current = false;
    getKnowledgeIndexStatusAction(workspaceId)
      .then((s) => {
        if (!cancelled.current) setStatus(s);
      })
      .catch((err: unknown) => {
        if (!cancelled.current) setLoadError(errorMessage(err, 'Could not load the knowledge index.'));
      })
      .finally(() => {
        if (!cancelled.current) setLoading(false);
      });
    return () => {
      cancelled.current = true;
    };
  }, [workspaceId]);

  const counts = useMemo(() => {
    const c = { embedded: 0, keyword_only: 0, missing: 0 };
    for (const a of status?.articles || []) c[a.state] += 1;
    return c;
  }, [status]);

  const needsIndex = useMemo(
    () => (status?.articles || []).filter((a) => a.state !== 'embedded'),
    [status]
  );

  const run = async (targets: { id: string; title: string }[]) => {
    if (!targets.length || progress) return;
    const titles = new Map(targets.map((t) => [t.id, t.title]));
    const failed: Failure[] = [];
    setFailures([]);
    setProgress({ done: 0, total: targets.length });

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      if (cancelled.current) return;
      const batch = targets.slice(i, i + BATCH_SIZE);
      try {
        const { results } = await reindexKnowledgeBatchAction(workspaceId, batch.map((t) => t.id));
        for (const r of results) {
          if (r.status === 'failed') {
            failed.push({ id: r.articleId, title: titles.get(r.articleId) || r.articleId, error: r.error || 'Unknown error' });
          }
        }
      } catch (err) {
        const message = errorMessage(err, 'Request failed');
        for (const t of batch) failed.push({ id: t.id, title: t.title, error: message });
      }
      setProgress({ done: Math.min(i + batch.length, targets.length), total: targets.length });
    }

    if (cancelled.current) return;
    setProgress(null);
    setFailures(failed);
    const ok = targets.length - failed.length;
    if (failed.length) {
      toast.error(`${ok} of ${targets.length} articles re-indexed. ${failed.length} failed.`);
    } else {
      toast.success(`${ok} ${ok === 1 ? 'article' : 'articles'} re-indexed.`);
    }
    await load();
    setCoverageKey((k) => k + 1);
  };

  if (loading && !status) {
    return (
      <SettingsCard title="Knowledge index">
        <LoadingState label="Checking the knowledge index…" />
      </SettingsCard>
    );
  }

  if (loadError && !status) {
    return (
      <SettingsCard title="Knowledge index">
        <ErrorState title="Could not load the knowledge index" message={loadError} onRetry={() => void load()} />
      </SettingsCard>
    );
  }

  if (!status) return null;

  const total = status.articles.length;
  const running = progress !== null;
  const percent = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <SettingsCard
      title="Knowledge index"
      description="Embeddings let the bot match a question to an article by meaning, not just shared words. Articles published before an embedding service was set up need re-indexing once."
    >
      <div className="space-y-4">
        {!status.embeddings.available ? (
          <p role="alert" className="rounded-lg border border-warn-line bg-warn-soft p-3 text-ui text-ink">
            No embedding service is available, so re-indexing would store keyword-only entries. In Platform AI, use an
            OpenAI-compatible provider that offers embeddings (for example DeepInfra), or set GOOGLE_API_KEY or
            OPENAI_API_KEY on the server. The bot still answers from keyword search meanwhile.
          </p>
        ) : (
          <p className="text-ui text-ink-2">
            Embeddings by <span className="font-medium text-ink">{status.embeddings.provider}</span>.
          </p>
        )}

        {total === 0 ? (
          <p className="text-ui text-ink-2">No published articles yet. Articles are indexed as soon as you publish them.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2" aria-label="Index status">
            <Badge tone="success" dot>
              {counts.embedded} of {total} indexed
            </Badge>
            {counts.keyword_only > 0 && (
              <Badge tone="warn" dot>
                {counts.keyword_only} keyword-only
              </Badge>
            )}
            {counts.missing > 0 && (
              <Badge tone="danger" dot>
                {counts.missing} not indexed
              </Badge>
            )}
          </div>
        )}

        {running && (
          <div className="space-y-1.5" role="status" aria-live="polite">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              aria-label="Re-index progress"
            >
              <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-ink-2">
              Re-indexing {progress.done} of {progress.total}… Keep this page open until it finishes.
            </p>
          </div>
        )}

        {total > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={running}
              disabled={!status.embeddings.available || needsIndex.length === 0}
              onClick={() => void run(needsIndex)}
            >
              {!running && <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
              {needsIndex.length ? `Re-index ${needsIndex.length} ${needsIndex.length === 1 ? 'article' : 'articles'}` : 'All articles indexed'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={running || !status.embeddings.available}
              onClick={() => void run(status.articles)}
            >
              Re-index all
            </Button>
          </div>
        )}

        {failures.length > 0 && !running && (
          <div className="space-y-2 rounded-lg border border-danger-line bg-danger-soft p-3" role="alert">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-ui font-medium text-ink">
                {failures.length} {failures.length === 1 ? 'article' : 'articles'} could not be re-indexed
              </p>
              <Button variant="secondary" size="xs" onClick={() => void run(failures)}>
                Retry failed
              </Button>
            </div>
            <ul className="space-y-1">
              {failures.slice(0, 8).map((f) => (
                <li key={f.id} className="text-xs text-ink-2 break-words">
                  <span className="font-medium text-ink">{f.title}</span>: {f.error}
                </li>
              ))}
              {failures.length > 8 && <li className="text-xs text-ink-3">…and {failures.length - 8} more</li>}
            </ul>
          </div>
        )}

        <div className="border-t border-line pt-4">
          <SubAgentCoverage workspaceId={workspaceId} refreshKey={coverageKey} />
        </div>
      </div>
    </SettingsCard>
  );
}
