'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Bold,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  Code,
  Columns2,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Heading2,
  Heading3,
  ImageIcon,
  Info,
  Italic,
  Lightbulb,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Minus,
  PanelRight,
  PenLine,
  Quote,
  Table,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { Article, HelpSection, Workspace } from '@/types/database';
import { Modal } from '@/components/ui/Modal';
import { MarkdownArticleContent } from '@/components/dashboard/MarkdownArticleContent';
import { cn } from '@/lib/utils';
import { generateSlug } from '@/lib/slug';
import { getWorkspaceHelpCenterUrl } from '@/lib/domain';
import { errorMessage } from '@/lib/errors/user-error';
import { uploadChatImage } from '@/lib/image-upload';
import { BLOCKS, continueList, insertBlock, insertLink, toggleLines, wrap, type Edit } from '@/lib/helpdesk/markdown-edit';
import {
  createArticleAction,
  getArticleAction,
  toggleArticleStatusAction,
  updateArticleAction,
} from '@/app/actions/helpdesk';

/**
 * The help-center article editor: a full-screen writing surface.
 *
 * Saving follows what the article is:
 *   - A draft saves itself to the server a moment after you stop typing.
 *   - A published article never does: half-finished edits must not go live,
 *     and saving it as a draft would take it off the help center (the old
 *     editor did exactly that every 20 seconds). Its unsaved edits are kept
 *     on this device until "Update" publishes them, so a closed tab or a
 *     crash loses nothing.
 */

export interface ArticleTemplate {
  id: string;
  label: string;
  name: string;
  desc?: string;
  content: string;
}

interface ArticleEditorProps {
  workspace: Workspace | null;
  workspaceId: string;
  sections: HelpSection[];
  /** The article to edit (its body may still be missing), or null for a new one. */
  article: Article | null;
  templates?: ArticleTemplate[];
  onClose: () => void;
  /** Published or updated: the editor is done. */
  onSaved: (article: Article) => void;
  /** A draft was saved in the background: refresh the list, stay open. */
  onPersisted?: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type ViewMode = 'write' | 'split' | 'preview';

interface Fields {
  title: string;
  summary: string;
  content: string;
  sectionId: string;
  slug: string;
}

const AUTOSAVE_MS = 2000;
const localKey = (id: string) => `zentry-article-draft:${id}`;
const same = (a: Fields, b: Fields) =>
  a.title.trim() === b.title.trim() &&
  a.summary.trim() === b.summary.trim() &&
  a.content.trim() === b.content.trim() &&
  a.sectionId === b.sectionId &&
  a.slug.trim() === b.slug.trim();

function readLocal(id: string): (Fields & { at: number }) | null {
  try {
    const raw = localStorage.getItem(localKey(id));
    return raw ? (JSON.parse(raw) as Fields & { at: number }) : null;
  } catch {
    return null;
  }
}
function writeLocal(id: string, fields: Fields | null) {
  try {
    if (fields) localStorage.setItem(localKey(id), JSON.stringify({ ...fields, at: Date.now() }));
    else localStorage.removeItem(localKey(id));
  } catch {
    /* storage full or blocked: the server copy is still there */
  }
}

function timeAgo(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function ArticleEditor({
  workspace,
  workspaceId,
  sections,
  article,
  templates = [],
  onClose,
  onSaved,
  onPersisted,
}: ArticleEditorProps) {
  const initial: Fields = {
    title: article?.title || '',
    summary: article?.summary || '',
    content: article?.content || '',
    sectionId: article?.section_id || sections[0]?.id || '',
    slug: article?.slug || '',
  };
  const [fields, setFields] = useState<Fields>(initial);
  const [articleId, setArticleId] = useState<string | null>(article?.id ?? null);
  const [savedStatus, setSavedStatus] = useState<'published' | 'draft'>(article?.status || 'draft');
  const [slugTouched, setSlugTouched] = useState(Boolean(article?.id));
  /** What the server has: edits are compared against it. */
  const [saved, setSaved] = useState<Fields>(initial);

  // The list hands over an article without its body. Nothing can be saved
  // until it is here, or an empty body would replace the real one.
  const [bodyLoading, setBodyLoading] = useState(Boolean(article?.id) && article?.content === undefined);
  const [bodyError, setBodyError] = useState<string | null>(null);

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'publish' | 'unpublish'>(null);
  const [titleError, setTitleError] = useState(false);
  const [contentError, setContentError] = useState(false);

  const [view, setView] = useState<ViewMode>('write');
  // Open beside the text on wide screens; on a phone it covers the text, so it starts closed.
  // Beside the text on wide screens (can be hidden); on a phone it covers the
  // text, so there it opens only when asked.
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [mobileSettings, setMobileSettings] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [restore, setRestore] = useState<(Fields & { at: number }) | null>(null);
  const [uploading, setUploading] = useState(0);
  const [, setTick] = useState(0);

  const textRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const summaryRef = useRef<HTMLTextAreaElement>(null);

  const dirty = !bodyLoading && !same(fields, saved);
  const isPublished = savedStatus === 'published';
  const sectionName = sections.find((s) => s.id === fields.sectionId)?.name;

  /* ── Loading the body ─────────────────────────────────────────────── */
  useEffect(() => {
    if (!article?.id || article.content !== undefined) return;
    let cancelled = false;
    getArticleAction(workspaceId, article.id)
      .then((full) => {
        if (cancelled) return;
        setSaved((prev) => ({ ...prev, content: full.content || '' }));
        setFields((f) => ({ ...f, content: full.content || '' }));
        setBodyLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setBodyError(errorMessage(err, 'Could not load this article.'));
        setBodyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [article?.id, article?.content, workspaceId]);

  // Unsaved edits of a published article left on this device last time.
  const checkedLocal = useRef(false);
  useEffect(() => {
    if (bodyLoading || checkedLocal.current || !article?.id || article.status !== 'published') return;
    const local = readLocal(article.id);
    const serverAt = Date.parse(article.updated_at || '') || 0;
    if (local && local.at > serverAt && !same(local, saved)) {
      // Offered after the editor has drawn, as a banner.
      const t = setTimeout(() => {
        checkedLocal.current = true;
        setRestore(local);
      }, 0);
      return () => clearTimeout(t);
    }
    checkedLocal.current = true;
    if (local) writeLocal(article.id, null);
  }, [bodyLoading, article, saved]);

  // Relative "Saved 12s ago" stays current.
  useEffect(() => {
    if (!savedAt) return;
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [savedAt]);

  /* ── Saving ───────────────────────────────────────────────────────── */
  const payload = useCallback(
    (status: 'published' | 'draft') => ({
      title: fields.title.trim(),
      summary: fields.summary.trim() || null,
      content: fields.content,
      section_id: fields.sectionId || null,
      slug: fields.slug.trim() || undefined,
      status,
      order_index: article?.order_index ?? undefined,
    }),
    [fields, article?.order_index]
  );

  const persist = useCallback(
    async (status: 'published' | 'draft'): Promise<Article | null> => {
      const snapshot = fields;
      const res = articleId
        ? await updateArticleAction(workspaceId, articleId, payload(status))
        : await createArticleAction(workspaceId, payload(status));
      const saved = res.article as Article | undefined;
      if (!saved) return null;
      if (!articleId) setArticleId(saved.id);
      setSaved({ ...snapshot, slug: saved.slug || snapshot.slug });
      if (!slugTouched && saved.slug) {
        setSlugTouched(true);
        setFields((f) => (f.slug === snapshot.slug ? { ...f, slug: saved.slug || f.slug } : f));
      }
      setSavedStatus(saved.status as 'published' | 'draft');
      setSavedAt(Date.now());
      return saved;
    },
    [articleId, fields, payload, slugTouched, workspaceId]
  );

  const saveDraft = useCallback(async () => {
    if (isPublished || bodyLoading || bodyError || !fields.title.trim()) return;
    setSaveState('saving');
    try {
      await persist('draft');
      setSaveState('saved');
      onPersisted?.();
    } catch (err) {
      console.error('[Article Editor] draft save:', err);
      setSaveState('error');
    }
  }, [isPublished, bodyLoading, bodyError, fields.title, persist, onPersisted]);

  // Drafts save themselves shortly after typing stops; published articles
  // keep their edits on this device until "Update".
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      if (isPublished) {
        if (articleId) writeLocal(articleId, fields);
      } else if (saveState !== 'saving') {
        void saveDraft();
      }
    }, isPublished ? 600 : AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, fields, isPublished, articleId, saveDraft, saveState]);

  const validate = () => {
    const noTitle = !fields.title.trim();
    const noBody = !fields.content.trim();
    setTitleError(noTitle);
    setContentError(noBody);
    if (noTitle) titleRef.current?.focus();
    else if (noBody) textRef.current?.focus();
    return !noTitle && !noBody;
  };

  const publish = async () => {
    if (bodyLoading || bodyError) return;
    setActionError(null);
    if (!validate()) return;
    setBusy('publish');
    try {
      const saved = await persist('published');
      if (saved) {
        if (articleId || saved.id) writeLocal(saved.id, null);
        onSaved(saved);
      }
    } catch (err) {
      setActionError(errorMessage(err, 'Could not publish the article.'));
    } finally {
      setBusy(null);
    }
  };

  const unpublish = async () => {
    if (!articleId) return;
    setBusy('unpublish');
    setActionError(null);
    try {
      const res = await toggleArticleStatusAction(workspaceId, articleId, 'draft');
      if (res.article) {
        setSavedStatus('draft');
        onPersisted?.();
      }
    } catch (err) {
      setActionError(errorMessage(err, 'Could not unpublish the article.'));
    } finally {
      setBusy(null);
    }
  };

  const requestClose = () => {
    if (dirty && isPublished) {
      setConfirmClose(true);
      return;
    }
    if (dirty && !isPublished && fields.title.trim()) void saveDraft();
    onClose();
  };

  /* ── Editing ──────────────────────────────────────────────────────── */
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields((f) => ({ ...f, [key]: value }));

  const setTitle = (title: string) => {
    setTitleError(false);
    setFields((f) => ({ ...f, title, slug: slugTouched ? f.slug : generateSlug(title) }));
  };

  const apply = (edit: (text: string, start: number, end: number) => Edit) => {
    const el = textRef.current;
    if (!el) return;
    const r = edit(el.value, el.selectionStart, el.selectionEnd);
    setContentError(false);
    set('content', r.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.start, r.end);
    });
  };

  const uploadImages = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    for (const file of images) {
      const token = `![Uploading ${file.name}…]()`;
      apply((t, s, e) => insertBlock(t, s, e, token));
      setUploading((n) => n + 1);
      try {
        const url = await uploadChatImage(file);
        const alt = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
        setFields((f) => ({ ...f, content: f.content.replace(token, `![${alt}](${url})`) }));
      } catch (err) {
        setFields((f) => ({ ...f, content: f.content.replace(token, '') }));
        setActionError(errorMessage(err, 'The image could not be uploaded.'));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  // Shortcuts that work anywhere in the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isPublished) void publish();
        else void saveDraft();
      } else if (mod && e.key === 'Enter') {
        e.preventDefault();
        void publish();
      } else if (e.key === 'Escape' && !confirmClose && !restore) {
        requestClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Leaving the page with edits that are not saved anywhere.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty && !isPublished) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty, isPublished]);

  const onTextKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    const el = e.currentTarget;
    if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      apply((t, s, en) => wrap(t, s, en, '**'));
    } else if (mod && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      apply((t, s, en) => wrap(t, s, en, '_'));
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      apply(insertLink);
    } else if (e.key === 'Enter' && !e.shiftKey && !mod && el.selectionStart === el.selectionEnd) {
      const r = continueList(el.value, el.selectionStart);
      if (r) {
        e.preventDefault();
        set('content', r.text);
        requestAnimationFrame(() => el.setSelectionRange(r.start, r.end));
      }
    } else if (e.key === 'Tab' && !mod) {
      e.preventDefault();
      apply((t, s, en) => ({ text: `${t.slice(0, s)}  ${t.slice(en)}`, start: s + 2, end: s + 2 }));
    }
  };

  // The writing area grows with its text, like a document.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 420)}px`;
  }, [fields.content, view]);
  useEffect(() => {
    for (const el of [titleRef.current, summaryRef.current]) {
      if (!el) continue;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [fields.title, fields.summary, bodyLoading]);

  const stats = useMemo(() => {
    const words = fields.content.trim() ? fields.content.trim().split(/\s+/).length : 0;
    const headings = (fields.content.match(/^#{1,3}\s/gm) || []).length;
    return { words, minutes: words ? Math.max(1, Math.round(words / 200)) : 0, headings };
  }, [fields.content]);

  const liveUrl =
    workspace && fields.slug && isPublished ? getWorkspaceHelpCenterUrl(workspace, { id: articleId || '', slug: fields.slug } as Article) : null;
  const urlBase = workspace ? getWorkspaceHelpCenterUrl(workspace).replace(/\/+$/, '') : '';

  /* ── Status line ──────────────────────────────────────────────────── */
  const status = (() => {
    if (bodyLoading) return { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, text: 'Loading…', tone: 'text-ink-3' };
    if (uploading) return { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, text: 'Uploading image…', tone: 'text-ink-3' };
    if (saveState === 'saving') return { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, text: 'Saving…', tone: 'text-ink-3' };
    if (saveState === 'error')
      return { icon: <AlertCircle className="w-3.5 h-3.5" />, text: 'Not saved — retry', tone: 'text-danger', retry: true };
    if (isPublished && dirty) return { icon: <span className="w-1.5 h-1.5 rounded-full bg-warn" />, text: 'Unpublished changes', tone: 'text-warn' };
    if (!isPublished && dirty) return { icon: <span className="w-1.5 h-1.5 rounded-full bg-ink-3" />, text: 'Editing…', tone: 'text-ink-3' };
    if (savedAt) return { icon: <CheckCircle2 className="w-3.5 h-3.5" />, text: `Saved ${timeAgo(savedAt)}`, tone: 'text-success' };
    return null;
  })();

  const primaryLabel = isPublished ? (dirty ? 'Update' : 'Published') : 'Publish';

  return (
    <div className="fixed inset-0 z-[60] bg-canvas flex flex-col" role="dialog" aria-modal="true" aria-label={fields.title || 'New article'}>
      {/* Top bar */}
      <header className="shrink-0 h-14 px-3 sm:px-4 flex items-center gap-2 border-b border-line bg-surface">
        <button type="button" onClick={requestClose} className="btn btn-sm btn-ghost px-2" aria-label="Back to Help Desk">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <nav className="min-w-0 flex items-center gap-1.5 text-ui text-ink-3" aria-label="Breadcrumb">
          <span className="hidden sm:inline">Help Desk</span>
          {sectionName && (
            <>
              <span className="hidden sm:inline">/</span>
              <span className="hidden md:inline truncate max-w-[160px]">{sectionName}</span>
            </>
          )}
          <span className="hidden sm:inline">/</span>
          <span className="text-ink font-medium truncate max-w-[220px]">{fields.title.trim() || 'Untitled article'}</span>
        </nav>
        <span
          className={cn(
            'ml-1 hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold',
            isPublished ? 'bg-success-soft text-success' : 'bg-surface-3 text-ink-2'
          )}
        >
          {isPublished ? 'Published' : 'Draft'}
        </span>

        <div className="flex-1" />

        {status && (
          <button
            type="button"
            onClick={status.retry ? () => void saveDraft() : undefined}
            className={cn('hidden md:inline-flex items-center gap-1.5 text-xs mr-1', status.tone, !status.retry && 'cursor-default')}
            aria-live="polite"
          >
            {status.icon}
            {status.text}
          </button>
        )}

        <div className="hidden sm:flex items-center p-0.5 rounded-lg bg-surface-3 border border-line" role="group" aria-label="View">
          {(
            [
              ['write', PenLine, 'Write'],
              ['split', Columns2, 'Side by side'],
              ['preview', Eye, 'Preview'],
            ] as [ViewMode, typeof PenLine, string][]
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-pressed={view === id}
              title={label}
              className={cn('h-7 px-2 rounded-md text-ink-3 hover:text-ink', view === id && 'bg-surface text-ink shadow-xs', id === 'split' && 'hidden xl:block')}
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            if (window.matchMedia('(min-width: 1024px)').matches) setSettingsOpen((v) => !v);
            else setMobileSettings((v) => !v);
          }}
          aria-pressed={settingsOpen}
          className="btn btn-sm btn-ghost px-2"
          title="Article settings"
          aria-label="Article settings"
        >
          <PanelRight className="w-4 h-4" />
        </button>

        {isPublished && (
          <button type="button" onClick={() => void unpublish()} disabled={busy !== null} className="hidden lg:inline-flex btn btn-sm btn-secondary">
            {busy === 'unpublish' ? 'Unpublishing…' : 'Unpublish'}
          </button>
        )}
        {!isPublished && (
          <button
            type="button"
            onClick={() => void saveDraft()}
            disabled={!dirty || saveState === 'saving' || !fields.title.trim()}
            className="hidden lg:inline-flex btn btn-sm btn-secondary"
          >
            Save draft
          </button>
        )}
        <button
          type="button"
          onClick={() => void publish()}
          disabled={busy !== null || bodyLoading || !!bodyError || (isPublished && !dirty)}
          className="btn btn-sm btn-primary min-w-[92px]"
          title={isPublished ? 'Publish your changes (Ctrl+S)' : 'Publish to the help center (Ctrl+Enter)'}
        >
          {busy === 'publish' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          {busy === 'publish' ? 'Publishing…' : primaryLabel}
        </button>
      </header>

      {(actionError || bodyError) && (
        <div className="shrink-0 px-4 py-2 bg-danger-soft text-danger text-xs flex items-center gap-2" role="alert">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{bodyError ? `${bodyError} Close and open the article again before editing.` : actionError}</span>
          {actionError && (
            <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
      {restore && (
        <div className="shrink-0 px-4 py-2 bg-warn-soft text-warn text-xs flex flex-wrap items-center gap-2" role="status">
          <Info className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">You have unpublished changes to this article from {timeAgo(restore.at)} on this device.</span>
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => {
              setFields({ title: restore.title, summary: restore.summary, content: restore.content, sectionId: restore.sectionId, slug: restore.slug });
              setRestore(null);
            }}
          >
            Restore them
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => {
              if (articleId) writeLocal(articleId, null);
              setRestore(null);
            }}
          >
            Discard
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* Writing surface */}
        <main className="flex-1 min-w-0 overflow-y-auto">
          {bodyLoading ? (
            <div className="max-w-3xl mx-auto px-6 py-12 space-y-4" aria-busy="true">
              <div className="h-10 w-3/4 rounded-lg bg-surface-2 animate-pulse" />
              <div className="h-5 w-1/2 rounded bg-surface-2 animate-pulse" />
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-4 rounded bg-surface-2 animate-pulse" style={{ width: `${90 - i * 8}%` }} />
              ))}
            </div>
          ) : (
            <div className={cn('mx-auto px-4 sm:px-8 py-8', view === 'split' ? 'max-w-[1400px]' : 'max-w-3xl')}>
              <textarea
                ref={titleRef}
                value={fields.title}
                onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    textRef.current?.focus();
                  }
                }}
                rows={1}
                placeholder="Article title"
                aria-label="Title"
                aria-invalid={titleError}
                autoFocus={!article}
                className={cn(
                  'w-full resize-none bg-transparent text-3xl sm:text-4xl font-bold tracking-tight text-ink placeholder:text-ink-3/50 outline-none leading-tight',
                  titleError && 'placeholder:text-danger/60'
                )}
              />
              {titleError && <p className="text-xs text-danger mt-1">Give the article a title.</p>}
              <textarea
                ref={summaryRef}
                value={fields.summary}
                onChange={(e) => set('summary', e.target.value.replace(/\n/g, ' ').slice(0, 240))}
                rows={1}
                placeholder="One-line summary, shown in lists and search results (optional)"
                aria-label="Summary"
                className="mt-2 w-full resize-none bg-transparent text-md text-ink-2 placeholder:text-ink-3/60 outline-none"
              />

              {/* Toolbar */}
              <div className="sticky top-0 z-10 -mx-2 mt-4 mb-3 px-2 py-1.5 bg-canvas/95 backdrop-blur border-b border-line flex items-center gap-0.5 overflow-x-auto">
                <Tool icon={Heading2} label="Heading" onClick={() => apply((t, s, e) => toggleLines(t, s, e, 'h2'))} />
                <Tool icon={Heading3} label="Subheading" onClick={() => apply((t, s, e) => toggleLines(t, s, e, 'h3'))} />
                <Sep />
                <Tool icon={Bold} label="Bold (Ctrl+B)" onClick={() => apply((t, s, e) => wrap(t, s, e, '**'))} />
                <Tool icon={Italic} label="Italic (Ctrl+I)" onClick={() => apply((t, s, e) => wrap(t, s, e, '_'))} />
                <Tool icon={Code} label="Inline code" onClick={() => apply((t, s, e) => wrap(t, s, e, '`', 'code'))} />
                <Tool icon={Link2} label="Link (Ctrl+K)" onClick={() => apply(insertLink)} />
                <Sep />
                <Tool icon={List} label="Bulleted list" onClick={() => apply((t, s, e) => toggleLines(t, s, e, 'bullet'))} />
                <Tool icon={ListOrdered} label="Numbered list" onClick={() => apply((t, s, e) => toggleLines(t, s, e, 'number'))} />
                <Tool icon={CheckSquare} label="Checklist" onClick={() => apply((t, s, e) => toggleLines(t, s, e, 'task'))} />
                <Tool icon={Quote} label="Quote" onClick={() => apply((t, s, e) => toggleLines(t, s, e, 'quote'))} />
                <Sep />
                <Tool icon={Info} label="Note box" onClick={() => apply((t, s, e) => insertBlock(t, s, e, BLOCKS.note))} />
                <Tool icon={Lightbulb} label="Tip box" onClick={() => apply((t, s, e) => insertBlock(t, s, e, BLOCKS.tip))} />
                <Tool icon={TriangleAlert} label="Warning box" onClick={() => apply((t, s, e) => insertBlock(t, s, e, BLOCKS.warning))} />
                <Tool icon={Table} label="Table" onClick={() => apply((t, s, e) => insertBlock(t, s, e, BLOCKS.table))} />
                <Tool icon={Minus} label="Divider" onClick={() => apply((t, s, e) => insertBlock(t, s, e, BLOCKS.divider))} />
                <label className="h-8 w-8 grid place-items-center rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 cursor-pointer" title="Image (or paste / drop one)">
                  <ImageIcon className="w-4 h-4" />
                  <span className="sr-only">Add an image</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      void uploadImages(Array.from(e.target.files || []));
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>

              {/* Start from a template, for a new empty article. */}
              {!fields.content.trim() && templates.length > 0 && view !== 'preview' && (
                <div className="mb-4">
                  <p className="text-xs text-ink-3 mb-2">Start from a template, or just start writing.</p>
                  <div className="flex flex-wrap gap-2">
                    {templates.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setContentError(false);
                          setFields((f) => ({ ...f, content: t.content }));
                        }}
                        title={t.desc}
                        className="px-3 py-1.5 rounded-lg border border-line bg-surface text-xs font-medium text-ink-2 hover:border-accent-line hover:text-accent transition-colors"
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className={cn(view === 'split' && 'grid grid-cols-2 gap-8')}>
                {view !== 'preview' && (
                  <div>
                    <textarea
                      ref={textRef}
                      value={fields.content}
                      onChange={(e) => {
                        setContentError(false);
                        set('content', e.target.value);
                      }}
                      onKeyDown={onTextKey}
                      onPaste={(e) => {
                        const files = Array.from(e.clipboardData.files || []);
                        if (files.some((f) => f.type.startsWith('image/'))) {
                          e.preventDefault();
                          void uploadImages(files);
                        }
                      }}
                      onDrop={(e) => {
                        const files = Array.from(e.dataTransfer.files || []);
                        if (files.length) {
                          e.preventDefault();
                          void uploadImages(files);
                        }
                      }}
                      placeholder={'Write the answer here.\n\n## Headings, - lists, **bold** and [links](https://…) all work. Paste an image to add it.'}
                      aria-label="Article content"
                      aria-invalid={contentError}
                      spellCheck
                      className="w-full min-h-[420px] resize-none bg-transparent text-md leading-[1.8] text-ink placeholder:text-ink-3/60 outline-none"
                    />
                    {contentError && <p className="text-xs text-danger">Write the article before publishing it.</p>}
                  </div>
                )}
                {view !== 'write' && (
                  <div className={cn(view === 'split' && 'border-l border-line pl-8')}>
                    {view === 'preview' && (
                      <h1 className="text-3xl font-bold tracking-tight text-ink mb-2">{fields.title || 'Untitled article'}</h1>
                    )}
                    {fields.content.trim() ? (
                      <div className="text-md leading-[1.75]">
                        <MarkdownArticleContent content={fields.content} />
                      </div>
                    ) : (
                      <p className="text-ui text-ink-3">Nothing to preview yet.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        {/* Settings */}
        <aside
          className={cn(
            'w-full lg:w-80 shrink-0 border-l border-line bg-surface overflow-y-auto',
            mobileSettings ? 'fixed inset-0 top-14 z-20' : 'hidden',
            'lg:static lg:z-auto',
            settingsOpen ? 'lg:block' : 'lg:hidden'
          )}
        >
            <div className="p-5 space-y-6">
              <div className="flex items-center justify-between lg:hidden">
                <h2 className="text-md font-semibold text-ink">Article settings</h2>
                <button type="button" onClick={() => setMobileSettings(false)} className="btn btn-sm btn-ghost px-2" aria-label="Close settings">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <Setting label="Collection">
                <div className="relative">
                  <select
                    value={fields.sectionId}
                    onChange={(e) => set('sectionId', e.target.value)}
                    className="input input-sm select w-full appearance-none pr-8"
                    aria-label="Collection"
                  >
                    {sections.length === 0 && <option value="">No collections yet</option>}
                    {sections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.icon && !/^(https?:|\/|data:)/.test(s.icon) ? `${s.icon} ` : ''}
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-3.5 h-3.5 text-ink-3 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </Setting>

              <Setting label="Address" hint={isPublished ? 'Changing it keeps the old address working.' : 'Made from the title until you edit it.'}>
                <div className="flex items-stretch rounded-lg border border-line bg-surface focus-within:border-accent overflow-hidden">
                  <span className="px-2 grid place-items-center text-2xs text-ink-3 bg-surface-2 border-r border-line max-w-[110px] truncate" title={urlBase}>
                    /
                  </span>
                  <input
                    value={fields.slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      set('slug', generateSlug(e.target.value) || e.target.value.toLowerCase());
                    }}
                    placeholder="article-address"
                    aria-label="Article address"
                    className="flex-1 min-w-0 px-2 py-1.5 text-xs font-mono bg-transparent outline-none"
                  />
                </div>
              </Setting>

              <Setting label="Status">
                <p className="text-ui text-ink-2">
                  {isPublished
                    ? dirty
                      ? 'Published. Your edits go live when you press Update.'
                      : 'Published on the help center. The bot answers from it.'
                    : 'Draft. Only your team can see it, and the bot does not use it yet.'}
                </p>
                {liveUrl && (
                  <div className="mt-2 flex items-center gap-2">
                    <a href={liveUrl} target="_blank" rel="noreferrer" className="btn btn-xs btn-secondary gap-1">
                      <ExternalLink className="w-3 h-3" />
                      View live
                    </a>
                    <button type="button" onClick={() => void navigator.clipboard?.writeText(liveUrl)} className="btn btn-xs btn-ghost gap-1">
                      <Copy className="w-3 h-3" />
                      Copy link
                    </button>
                  </div>
                )}
              </Setting>

              <Setting label="Length">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Stat value={stats.words} label="words" />
                  <Stat value={`${stats.minutes}m`} label="read" />
                  <Stat value={stats.headings} label="headings" />
                </div>
                {stats.words > 0 && stats.words < 25 && (
                  <p className="mt-2 text-2xs text-warn">Very short articles give the bot little to answer from. A few full sentences help.</p>
                )}
              </Setting>

              <Setting label="Writing tips">
                <ul className="text-xs text-ink-3 space-y-1.5 list-disc pl-4">
                  <li>Write the title as the question customers ask.</li>
                  <li>Answer in the first sentence; details after.</li>
                  <li>One topic per article: the bot and search find it faster.</li>
                </ul>
              </Setting>

              <p className="text-2xs text-ink-3 flex items-center gap-1.5">
                <FileText className="w-3 h-3" />
                Ctrl+S save · Ctrl+Enter publish · Esc close
              </p>
            </div>
        </aside>
      </div>

      {/* Leaving a published article with edits that are not live. */}
      <Modal
        open={confirmClose}
        title="Publish your changes?"
        description="Your edits to this published article are not live yet. They stay saved on this device if you leave."
        onClose={() => setConfirmClose(false)}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmClose(false)}>
              Keep editing
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                if (articleId) writeLocal(articleId, null);
                setConfirmClose(false);
                onClose();
              }}
            >
              Discard edits
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setConfirmClose(false);
                void publish();
              }}
            >
              Update article
            </button>
          </div>
        }
      >
        <span />
      </Modal>
    </div>
  );
}

function Tool({ icon: Icon, label, onClick }: { icon: typeof Bold; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={label}
      aria-label={label}
      className="h-8 w-8 shrink-0 grid place-items-center rounded-md text-ink-3 hover:text-ink hover:bg-surface-2"
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

function Sep() {
  return <span className="w-px h-5 bg-line mx-1 shrink-0" aria-hidden />;
}

function Setting({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-2xs font-semibold uppercase tracking-wider text-ink-3 mb-2">{label}</h3>
      {children}
      {hint && <p className="mt-1.5 text-2xs text-ink-3">{hint}</p>}
    </section>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="rounded-lg bg-surface-2 py-2">
      <div className="text-md font-semibold text-ink">{value}</div>
      <div className="text-2xs text-ink-3">{label}</div>
    </div>
  );
}
