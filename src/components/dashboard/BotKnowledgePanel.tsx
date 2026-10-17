'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, FileUp, Pencil, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { formatTimeAgo } from '@/lib/utils';
import {
  deleteBotKnowledgeAction,
  embedBotKnowledgeBatchAction,
  getBotKnowledgeAction,
  listBotKnowledgeAction,
  saveBotKnowledgeAction,
  type BotKnowledgeList,
  type BotKnowledgeListItem,
} from '@/app/actions/bot-knowledge';
import { errorMessage } from '@/lib/errors/user-error';

/** Matches the server's per-request limit. */
const BATCH_SIZE = 5;
const MAX_CONTENT = 100_000;
const IMPORTABLE = '.txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json';

interface Draft {
  id: string | null;
  title: string;
  content: string;
}

/**
 * Help Center → Bot knowledge. Information the bot answers from that is not
 * a public article: price lists, delivery areas, plan details. Saving keeps
 * the text; "Generate embeddings" is what makes the bot use it, and an edit
 * puts the entry back to pending until it is embedded again.
 */
export function BotKnowledgePanel({ workspaceId, newEntrySignal }: { workspaceId: string; newEntrySignal?: number }) {
  const toast = useToast();
  const [data, setData] = useState<BotKnowledgeList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'save' | 'embed' | null>(null);
  const [loadingEntry, setLoadingEntry] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<BotKnowledgeListItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const next = await listBotKnowledgeAction(workspaceId);
      if (alive.current) setData(next);
    } catch (err) {
      if (alive.current) setLoadError(errorMessage(err, 'Could not load bot knowledge.'));
    }
  }, [workspaceId]);

  // First load; `load` above is for retries and refreshes after a change.
  useEffect(() => {
    alive.current = true;
    if (workspaceId) {
      listBotKnowledgeAction(workspaceId)
        .then((next) => {
          if (alive.current) setData(next);
        })
        .catch((err: unknown) => {
          if (alive.current) setLoadError(errorMessage(err, 'Could not load bot knowledge.'));
        });
    }
    return () => {
      alive.current = false;
    };
  }, [workspaceId]);

  // The header's "Add data" button bumps the signal; adjusted during render
  // rather than in an effect, so the editor opens in the same pass.
  const [seenSignal, setSeenSignal] = useState(newEntrySignal);
  if (newEntrySignal !== seenSignal) {
    setSeenSignal(newEntrySignal);
    if (newEntrySignal) {
      setDraftError(null);
      setDraft({ id: null, title: '', content: '' });
    }
  }

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const counts = useMemo(() => {
    const c = { ready: 0, pending: 0, failed: 0 };
    for (const e of entries) c[e.status] += 1;
    return c;
  }, [entries]);
  const needsEmbedding = useMemo(
    () => entries.filter((e) => needsRun(e, data?.embeddings.available ?? false)),
    [entries, data]
  );
  const running = progress !== null;

  const embed = async (targets: { id: string; title: string }[]) => {
    if (!targets.length || running) return;
    const titles = new Map(targets.map((t) => [t.id, t.title]));
    const failed: string[] = [];
    setProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      try {
        const { results } = await embedBotKnowledgeBatchAction(workspaceId, batch.map((t) => t.id));
        for (const r of results) {
          if (r.status !== 'ready') failed.push(`${titles.get(r.id) || 'Entry'}: ${r.error || 'failed'}`);
        }
      } catch (err) {
        const message = errorMessage(err, 'Request failed');
        for (const t of batch) failed.push(`${t.title}: ${message}`);
      }
      if (!alive.current) return;
      setProgress({ done: Math.min(i + batch.length, targets.length), total: targets.length });
    }
    setProgress(null);
    const ok = targets.length - failed.length;
    if (failed.length) {
      toast.error(`${ok} of ${targets.length} embedded. ${failed[0]}`);
    } else {
      toast.success(ok === 1 ? 'The bot can now answer from this entry.' : `The bot can now answer from ${ok} entries.`);
    }
    await load();
  };

  const openEditor = async (entry: BotKnowledgeListItem) => {
    setLoadingEntry(entry.id);
    try {
      const full = await getBotKnowledgeAction(workspaceId, entry.id);
      setDraftError(null);
      setDraft({ id: full.id, title: full.title, content: full.content });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not open this entry.'));
    } finally {
      setLoadingEntry(null);
    }
  };

  const save = async (andEmbed: boolean) => {
    if (!draft) return;
    setSaving(andEmbed ? 'embed' : 'save');
    setDraftError(null);
    try {
      const res = await saveBotKnowledgeAction(workspaceId, draft);
      if (!res.success) {
        setDraftError(res.error);
        return;
      }
      setDraft(null);
      if (andEmbed) {
        await embed([{ id: res.entry.id, title: res.entry.title }]);
      } else {
        toast.success('Saved. Generate embeddings so the bot can use it.');
        await load();
      }
    } catch (err) {
      setDraftError(errorMessage(err, 'Could not save.'));
    } finally {
      setSaving(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteBotKnowledgeAction(workspaceId, deleting.id);
      toast.success('Deleted. The bot no longer uses it.');
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete.'));
    } finally {
      setDeleteBusy(false);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file || !draft) return;
    try {
      const text = (await file.text()).trim();
      if (!text) {
        setDraftError('That file is empty.');
        return;
      }
      setDraft({
        ...draft,
        title: draft.title || file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').slice(0, 200),
        content: draft.content ? `${draft.content}\n\n${text}` : text,
      });
    } catch {
      setDraftError('Could not read that file. Use a plain text, Markdown, CSV or JSON file.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const percent = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const tooLong = (draft?.content.length ?? 0) > MAX_CONTENT;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 shrink-0 rounded-xl bg-accent-soft text-accent grid place-items-center">
            <Brain className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-md font-semibold text-ink">Bot knowledge</h2>
            <p className="text-ui text-ink-2 mt-0.5">
              Extra information the bot answers from, alongside your articles: price lists, delivery areas, plan
              details. It is not published in the help center and answers from it carry no article link, but the bot
              can repeat anything here to a customer, so leave out anything private.
            </p>
          </div>
        </div>

        {data && !data.embeddings.available && (
          <p role="alert" className="rounded-lg border border-warn-line bg-warn-soft p-3 text-ui text-ink">
            No embedding service is set up, so entries are stored for keyword search only: the bot finds them when
            the question uses the same words. Set an embedding provider in Platform AI (or GOOGLE_API_KEY /
            OPENAI_API_KEY on the server) to match by meaning.
          </p>
        )}

        {entries.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success" dot>
              {counts.ready} ready
            </Badge>
            {counts.pending > 0 && (
              <Badge tone="warn" dot>
                {counts.pending} waiting for embeddings
              </Badge>
            )}
            {counts.failed > 0 && (
              <Badge tone="danger" dot>
                {counts.failed} failed
              </Badge>
            )}
            <div className="flex-1" />
            <Button
              variant="primary"
              size="sm"
              loading={running}
              disabled={needsEmbedding.length === 0}
              onClick={() => void embed(needsEmbedding)}
            >
              {!running && <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
              {needsEmbedding.length
                ? `Generate embeddings (${needsEmbedding.length})`
                : 'Everything is embedded'}
            </Button>
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
              aria-label="Embedding progress"
            >
              <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-ink-2">
              Embedding {progress.done} of {progress.total}… Keep this page open until it finishes.
            </p>
          </div>
        )}
      </section>

      {!data && !loadError && (
        <div className="space-y-2" role="status" aria-label="Loading bot knowledge">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-16 rounded-xl" />
          ))}
        </div>
      )}

      {loadError && !data && (
        <ErrorState title="Could not load bot knowledge" message={loadError} onRetry={() => void load()} />
      )}

      {data && entries.length === 0 && (
        <EmptyState
          type="custom"
          title="Nothing here yet"
          description="Add what the bot should know that is not in an article, then generate embeddings so it can answer from it."
          actionLabel="Add data"
          onAction={() => {
            setDraftError(null);
            setDraft({ id: null, title: '', content: '' });
          }}
        />
      )}

      {entries.length > 0 && (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li
              key={e.id}
              className="rounded-xl border border-line bg-surface p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-ui font-semibold text-ink break-words">{e.title}</span>
                  <StatusBadge entry={e} />
                </div>
                <p className="text-xs text-ink-3 mt-1">
                  {e.status === 'ready'
                    ? `${e.chunk_count} ${e.chunk_count === 1 ? 'chunk' : 'chunks'}${
                        e.embedded_count < e.chunk_count ? ', keyword search only' : ''
                      } · `
                    : ''}
                  Updated {formatTimeAgo(e.updated_at)}
                </p>
                {e.last_error && (
                  <p className="text-xs text-danger mt-1 break-words">{e.last_error}</p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {needsRun(e, data?.embeddings.available ?? false) && (
                  <Button variant="secondary" size="xs" disabled={running} onClick={() => void embed([e])}>
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                    Embed
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  loading={loadingEntry === e.id}
                  onClick={() => void openEditor(e)}
                  aria-label={`Edit ${e.title}`}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  Edit
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setDeleting(e)} aria-label={`Delete ${e.title}`}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={draft !== null}
        size="lg"
        title={draft?.id ? 'Edit bot knowledge' : 'Add bot knowledge'}
        description="The bot answers customers from this after you generate embeddings."
        onClose={() => (saving ? undefined : setDraft(null))}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={saving !== null} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={saving === 'save'}
              disabled={saving !== null || tooLong}
              onClick={() => void save(false)}
            >
              Save
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={saving === 'embed'}
              disabled={saving !== null || tooLong || running}
              onClick={() => void save(true)}
            >
              Save and generate embeddings
            </Button>
          </>
        }
      >
        {draft && (
          <>
            <Field label="Title" hint="What this is about, e.g. “Delivery charges by city”. The bot uses it to find the entry.">
              <Input
                value={draft.title}
                maxLength={200}
                autoFocus
                onChange={(ev) => setDraft({ ...draft, title: ev.target.value })}
              />
            </Field>
            <Field
              label="Information"
              error={draftError || (tooLong ? `Too long: at most ${MAX_CONTENT.toLocaleString()} characters. Split it into several entries.` : null)}
              hint={`${draft.content.length.toLocaleString()} / ${MAX_CONTENT.toLocaleString()} characters. Plain text or Markdown; headings and short paragraphs work best.`}
            >
              <Textarea
                rows={14}
                value={draft.content}
                onChange={(ev) => setDraft({ ...draft, content: ev.target.value })}
                placeholder={'## Delivery charges\nKarachi: Rs 200, 1-2 days\nLahore: Rs 250, 2-3 days'}
              />
            </Field>
            <div>
              <input
                ref={fileRef}
                type="file"
                accept={IMPORTABLE}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(ev) => void importFile(ev.target.files?.[0])}
              />
              <Button variant="secondary" size="xs" onClick={() => fileRef.current?.click()}>
                <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
                Import from a file
              </Button>
              <span className="ml-2 text-2xs text-ink-3">.txt, .md, .csv or .json</span>
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={deleting !== null}
        size="sm"
        title="Delete this entry?"
        description={deleting ? `“${deleting.title}” will be removed and the bot will stop using it.` : undefined}
        onClose={() => (deleteBusy ? undefined : setDeleting(null))}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={deleteBusy} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={deleteBusy} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-ui text-ink-2">This cannot be undone.</p>
      </Modal>
    </div>
  );
}

function StatusBadge({ entry }: { entry: BotKnowledgeListItem }) {
  if (entry.status === 'ready') {
    return (
      <Badge tone="success" dot>
        Bot uses this
      </Badge>
    );
  }
  if (entry.status === 'failed') {
    return (
      <Badge tone="danger" dot>
        Embedding failed
      </Badge>
    );
  }
  return (
    <Badge tone="warn" dot>
      Not embedded yet
    </Badge>
  );
}

/**
 * Not usable yet, or stored keyword-only although embeddings are available
 * now (added before an embedding service was set up).
 */
function needsRun(entry: BotKnowledgeListItem, embeddingsAvailable: boolean): boolean {
  return entry.status !== 'ready' || (embeddingsAvailable && entry.embedded_count < entry.chunk_count);
}
