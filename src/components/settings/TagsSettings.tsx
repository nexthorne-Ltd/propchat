'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Search, Tag, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { formatTimeAgo } from '@/lib/utils';
import { SettingsCard } from './parts';
import { deleteTagAction, listTagsAction, renameTagAction, type WorkspaceTag } from '@/app/actions/tags';
import { errorMessage } from '@/lib/errors/user-error';

/**
 * Settings → Tickets → Tags: every tag in use, how many tickets carry it, and
 * rename / merge / delete. Closed tickets keep their tags (they are history).
 */
export function TagsSettings({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [tags, setTags] = useState<WorkspaceTag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<WorkspaceTag | null>(null);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<WorkspaceTag | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTags(await listTagsAction(workspaceId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    let alive = true;
    listTagsAction(workspaceId)
      .then((t) => alive && setTags(t))
      .catch((e: Error) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tags || []).filter((t) => !q || t.tag.toLowerCase().includes(q));
  }, [tags, query]);
  const mergeTarget = renaming && (tags || []).find((t) => t.tag !== renaming.tag && t.tag.toLowerCase() === newName.trim().toLowerCase());

  async function rename() {
    if (!renaming) return;
    setBusy(true);
    setFormError(null);
    try {
      const target = mergeTarget ? mergeTarget.tag : newName.trim();
      const { changed } = await renameTagAction(workspaceId, renaming.tag, target);
      toast.success(`${mergeTarget ? 'Merged into' : 'Renamed to'} "${target}" on ${changed} ticket${changed === 1 ? '' : 's'}.`);
      setRenaming(null);
      await load();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      const { changed } = await deleteTagAction(workspaceId, deleting.tag);
      toast.success(`Removed "${deleting.tag}" from ${changed} ticket${changed === 1 ? '' : 's'}.`);
      setDeleting(null);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard title="Tags" description="Rename, merge or remove tags across your tickets. Closed tickets keep their tags as history.">
      {error && !tags && <ErrorState title="Could not load tags" message={error} onRetry={() => void load()} />}
      {!tags && !error && (
        <div className="space-y-2" role="status" aria-label="Loading tags">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-11 rounded-lg" />
          ))}
        </div>
      )}
      {tags && tags.length === 0 && (
        <EmptyState type="custom" title="No tags yet" description="Tags appear here once your team adds them to tickets, by hand, with macros or with rules." />
      )}
      {tags && tags.length > 0 && (
        <div className="space-y-3">
          <div className="relative max-w-xs">
            <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tags" aria-label="Search tags" className="pl-9" />
          </div>
          <ul className="divide-y divide-line border border-line rounded-xl overflow-hidden" aria-label="Tags">
            {shown.map((t) => (
              <li key={t.tag} className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-surface">
                <span className="pill pill-neutral inline-flex items-center gap-1.5 max-w-full">
                  <Tag className="w-3 h-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{t.tag}</span>
                </span>
                <span className="text-xs text-ink-3 flex-1 min-w-[8rem]">
                  {t.tickets} ticket{t.tickets === 1 ? '' : 's'} · {t.open_tickets} open{t.last_used ? ` · used ${formatTimeAgo(t.last_used)}` : ''}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setRenaming(t);
                      setNewName(t.tag);
                      setFormError(null);
                    }}
                    aria-label={`Rename ${t.tag}`}
                  >
                    <Pencil className="w-3.5 h-3.5" aria-hidden="true" /> Rename
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => setDeleting(t)} aria-label={`Delete ${t.tag}`}>
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
            {shown.length === 0 && <li className="px-4 py-6 text-center text-ui text-ink-3 bg-surface">No tag matches “{query}”.</li>}
          </ul>
        </div>
      )}

      <Modal
        open={renaming !== null}
        title={`Rename “${renaming?.tag ?? ''}”`}
        description="Type an existing tag's name to merge the two."
        onClose={() => (busy ? undefined : setRenaming(null))}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={busy} disabled={!newName.trim() || newName.trim() === renaming?.tag} onClick={() => void rename()}>
              {mergeTarget ? 'Merge' : 'Rename'}
            </Button>
          </>
        }
      >
        <Field
          label="New name"
          error={formError}
          hint={mergeTarget ? `“${mergeTarget.tag}” already exists: tickets with either tag will have “${mergeTarget.tag}”.` : 'Changes every open ticket that has this tag.'}
        >
          <Input value={newName} maxLength={50} autoFocus onChange={(e) => setNewName(e.target.value)} />
        </Field>
      </Modal>

      <Modal
        open={deleting !== null}
        size="sm"
        title={`Delete “${deleting?.tag ?? ''}”?`}
        description="It is removed from every ticket that is not closed. Macros and rules that add it are not changed."
        onClose={() => (busy ? undefined : setDeleting(null))}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={busy} onClick={() => void remove()}>
              Delete tag
            </Button>
          </>
        }
      >
        <p className="text-ui text-ink-2">{deleting ? `${deleting.open_tickets} open ticket${deleting.open_tickets === 1 ? '' : 's'} use it.` : ''}</p>
      </Modal>
    </SettingsCard>
  );
}
