'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Search,
  Trash2,
  Edit2,
  X,
  Lock,
  Bot,
  MessageSquareWarning,
  Check,
  EyeOff,
  FileText,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  listKnowledgeNotesAction,
  saveKnowledgeNoteAction,
  deleteKnowledgeNoteAction,
  listUnansweredQuestionsAction,
  updateUnansweredStatusAction,
  type KnowledgeNote,
  type UnansweredQuestion,
} from '@/app/actions/knowledge';
import { errorMessage } from '@/lib/errors/user-error';

/**
 * Filter out greetings, thanks, and human-handoff requests from knowledge gaps.
 */
function isIgnoredGapQuestion(raw: string): boolean {
  if (!raw) return true;
  const q = raw.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 2) return true;

  // Greetings
  const greetingsRegex = /^(hi|hello|hey|heya|howdy|good\s+(morning|afternoon|evening|day)|greetings|hola|salut|yo)(\s+(there|team|support|bot|assistant|everyone|all|agent))?$/i;
  if (greetingsRegex.test(q)) return true;

  // Thanks
  const thanksRegex = /^(thank\s*you|thanks|thx|ty|many\s*thanks|appreciate\s*it|thank\s*you\s*(so\s*much|very\s*much|a\s*lot))(\s+(all|team|for\s*help))?$/i;
  if (thanksRegex.test(q)) return true;

  // Human handoff requests
  const handoffPatterns = [
    /^(can\s+i\s+)?(talk|speak)\s+to\s+(a\s+)?(human|person|agent|representative|operator|support|someone|somebody)/i,
    /^(can\s+i\s+)?connect\s+(me\s+)?(to|with)\s+(a\s+)?(human|person|agent|representative|operator|support)/i,
    /^(i\s+want\s+to\s+)?(talk|speak)\s+(to|with)\s+(a\s+)?(human|person|agent|real\s+person)/i,
    /^(transfer|hand\s*over)\s+(me\s+)?to\s+(a\s+)?(human|agent|person|operator)/i,
    /^(human|agent|representative|operator|real\s*person)\s*(please)?$/i,
    /^(live\s+agent|customer\s+service|human\s+support|talk\s+to\s+human)$/i,
  ];

  if (handoffPatterns.some((pattern) => pattern.test(q))) return true;

  return false;
}

/**
 * Replace technical/confusing reasons with plain user-friendly text.
 */
function formatGapReason(reason?: string | null): string {
  if (!reason) return 'No article covers this topic';
  const lower = reason.toLowerCase();
  if (
    lower.includes('matched equally') ||
    lower.includes('two article') ||
    lower.includes('tie') ||
    lower.includes('ambiguous') ||
    lower.includes('equal')
  ) {
    return 'Two articles matched equally';
  }
  if (
    lower.includes('uses words no article contains') ||
    lower.includes('no article') ||
    lower.includes('below threshold') ||
    lower.includes('similarity not high') ||
    lower.includes('not high enough') ||
    lower.includes('no matching') ||
    lower.includes('no relevant') ||
    /\d+%\s+of the question/.test(lower)
  ) {
    return 'No article covers this topic';
  }
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/**
 * Computes semantic similarity using vector cosine similarity if available,
 * or token / bigram text similarity as fallback.
 */
function computeSimilarity(
  q1: { text: string; embedding?: number[] | null },
  q2: { text: string; embedding?: number[] | null }
): number {
  if (q1.embedding && q2.embedding && q1.embedding.length > 0 && q1.embedding.length === q2.embedding.length) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < q1.embedding.length; i++) {
      const a = q1.embedding[i];
      const b = q2.embedding[i];
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }
    if (normA > 0 && normB > 0) {
      const cosSim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
      if (cosSim >= 0.82) return cosSim;
    }
  }

  const stopWords = new Set([
    'what', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'how', 'do', 'does', 'did',
    'i', 'can', 'to', 'for', 'my', 'your', 'in', 'on', 'at', 'please', 'me', 'we',
    'you', 'it', 'and', 'or', 'of', 'be', 'this', 'that', 'there', 'have', 'has', 'with'
  ]);

  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));

  const tokensA = clean(q1.text);
  const tokensB = clean(q2.text);

  if (tokensA.length === 0 || tokensB.length === 0) {
    const normA = q1.text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const normB = q2.text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    return normA === normB ? 1 : 0;
  }

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union > 0 ? intersection / union : 0;

  const getBigrams = (s: string) => {
    const norm = s.toLowerCase().replace(/\s+/g, ' ').trim();
    const bg = new Set<string>();
    for (let i = 0; i < norm.length - 1; i++) {
      bg.add(norm.slice(i, i + 2));
    }
    return bg;
  };
  const bgA = getBigrams(q1.text);
  const bgB = getBigrams(q2.text);
  let bgOverlap = 0;
  for (const b of bgA) {
    if (bgB.has(b)) bgOverlap++;
  }
  const dice = (bgA.size + bgB.size > 0) ? (2 * bgOverlap) / (bgA.size + bgB.size) : 0;

  return Math.max(jaccard, dice * 0.85);
}

export interface GroupedGap {
  id: string;
  primaryQuestion: string;
  allQuestions: string[];
  questionCount: number;
  timesAsked: number;
  lastAskedAt: string;
  reason: string;
  rawGaps: UnansweredQuestion[];
}

type Tab = 'notes' | 'gaps';

export function KnowledgePanel({
  workspaceId,
  onCreateArticle,
  newNoteSignal,
}: {
  workspaceId: string;
  /** Turns a gap straight into a draft article. */
  onCreateArticle?: (title: string) => void;
  newNoteSignal?: number;
}) {
  const [tab, setTab] = useState<Tab>('notes');
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [gaps, setGaps] = useState<UnansweredQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Partial<KnowledgeNote> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [n, g] = await Promise.all([
        listKnowledgeNotesAction(workspaceId),
        listUnansweredQuestionsAction(workspaceId, 'open'),
      ]);
      setNotes(n);
      setGaps(g);
    } catch (err: any) {
      setError(errorMessage(err, 'Could not load this workspace’s knowledge.'));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!newNoteSignal) return;
    setTab('notes');
    setEditing({ title: '', content: '', tags: [], visibility: 'agent_only' });
  }, [newNoteSignal]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [notes, query]);

  // Group similar questions with semantic similarity and hide greetings/thanks/handoffs
  const groupedGaps = useMemo<GroupedGap[]>(() => {
    const filtered = gaps.filter((g) => !isIgnoredGapQuestion(g.question));
    const groups: GroupedGap[] = [];

    for (const gap of filtered) {
      const existing = groups.find((grp) => {
        const sim = computeSimilarity(
          { text: gap.question, embedding: gap.embedding },
          { text: grp.primaryQuestion, embedding: grp.rawGaps[0]?.embedding }
        );
        return sim >= 0.5;
      });

      if (existing) {
        if (!existing.allQuestions.includes(gap.question)) {
          existing.allQuestions.push(gap.question);
        }
        existing.questionCount += 1;
        existing.timesAsked += gap.times_asked || 1;
        existing.rawGaps.push(gap);
        if (new Date(gap.last_asked_at).getTime() > new Date(existing.lastAskedAt).getTime()) {
          existing.lastAskedAt = gap.last_asked_at;
        }
      } else {
        groups.push({
          id: gap.id,
          primaryQuestion: gap.question,
          allQuestions: [gap.question],
          questionCount: 1,
          timesAsked: gap.times_asked || 1,
          lastAskedAt: gap.last_asked_at,
          reason: formatGapReason(gap.reason),
          rawGaps: [gap],
        });
      }
    }

    return groups;
  }, [gaps]);

  const handleSave = async (note: Partial<KnowledgeNote>) => {
    try {
      const saved = await saveKnowledgeNoteAction(workspaceId, {
        id: note.id,
        title: note.title || '',
        content: note.content || '',
        tags: note.tags || [],
        visibility: note.visibility || 'agent_only',
      });
      setNotes((prev) => {
        const without = prev.filter((n) => n.id !== saved.id);
        return [saved, ...without];
      });
      setEditing(null);
    } catch (err: any) {
      setError(errorMessage(err, 'Could not save that note.'));
    }
  };

  const handleDelete = async (note: KnowledgeNote) => {
    if (!confirm(`Delete “${note.title}”? This cannot be undone.`)) return;
    setBusyId(note.id);
    try {
      await deleteKnowledgeNoteAction(workspaceId, note.id);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
    } catch (err: any) {
      setError(errorMessage(err, 'Could not delete that note.'));
    } finally {
      setBusyId(null);
    }
  };

  const resolveGroupedGap = async (
    group: GroupedGap,
    status: 'answered' | 'ignored'
  ) => {
    setBusyId(group.id);
    try {
      await Promise.all(
        group.rawGaps.map((g) => updateUnansweredStatusAction(workspaceId, g.id, status))
      );
      const idsToRemove = new Set(group.rawGaps.map((g) => g.id));
      setGaps((prev) => prev.filter((g) => !idsToRemove.has(g.id)));
    } catch (err: any) {
      setError(errorMessage(err, 'Could not update that question.'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center p-0.5 rounded-lg bg-surface-2 border border-line">
          {(
            [
              ['notes', 'Team knowledge', notes.length],
              ['gaps', 'Gaps', groupedGaps.length],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'h-7 px-3 rounded-md text-xs font-medium transition-all inline-flex items-center gap-1.5',
                tab === id
                  ? 'bg-surface text-ink font-semibold shadow-xs'
                  : 'text-ink-3 hover:text-ink'
              )}
            >
              {id === 'notes' ? (
                <Lock className="w-3.5 h-3.5" />
              ) : (
                <MessageSquareWarning className="w-3.5 h-3.5" />
              )}
              {label}
              {count > 0 && <span className="text-2xs opacity-70">({count})</span>}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {tab === 'notes' && (
            <div className="relative w-64">
              <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes..."
                className="w-full h-8 pl-8 pr-2.5 rounded-lg border border-line bg-surface-2/70 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent"
              />
            </div>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-danger-line bg-danger-soft px-4 py-2.5 text-xs text-danger flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center text-ink-3 text-ui flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      ) : tab === 'notes' ? (
        <NotesList
          notes={filteredNotes}
          busyId={busyId}
          onEdit={setEditing}
          onDelete={handleDelete}
          onNew={() =>
            setEditing({ title: '', content: '', tags: [], visibility: 'agent_only' })
          }
          searching={Boolean(query.trim())}
        />
      ) : (
        <GapsList
          gaps={groupedGaps}
          busyId={busyId}
          onResolve={resolveGroupedGap}
          onCreateArticle={onCreateArticle}
          onCreateNote={(group) =>
            setEditing({
              title: group.primaryQuestion.slice(0, 120),
              content: '',
              tags: ['from-a-real-question'],
              visibility: 'assistant',
            })
          }
        />
      )}

      {editing && (
        <NoteEditor
          note={editing}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

/* ── Notes ────────────────────────────────────────────────────────────── */

function NotesList({
  notes,
  busyId,
  onEdit,
  onDelete,
  onNew,
  searching,
}: {
  notes: KnowledgeNote[];
  busyId: string | null;
  onEdit: (n: KnowledgeNote) => void;
  onDelete: (n: KnowledgeNote) => void;
  onNew: () => void;
  searching: boolean;
}) {
  if (notes.length === 0) {
    return (
      <div className="p-12 rounded-2xl border border-dashed border-line text-center space-y-3 bg-surface-2/40">
        <Lock className="w-9 h-9 text-ink-3 mx-auto stroke-[1.5]" />
        <div className="text-md font-semibold text-ink">
          {searching ? 'No notes match that' : 'Nothing here yet'}
        </div>
        <p className="text-xs text-ink-3 max-w-md mx-auto">
          {searching
            ? 'Try a different word.'
            : 'Keep the things your team needs but customers should not read — internal policies, escalation paths, known issues and their workarounds.'}
        </p>
        {!searching && (
          <button
            type="button"
            onClick={onNew}
            className="h-8 px-3.5 rounded-lg bg-accent text-accent-ink text-xs font-semibold inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            Write the first note
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="border border-line rounded-xl overflow-hidden bg-surface divide-y divide-line/80">
      {notes.map((note) => (
        <div
          key={note.id}
          className="p-4 hover:bg-surface-2/50 transition-colors flex items-start justify-between gap-4 group"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <VisibilityBadge visibility={note.visibility} />
              {note.tags.map((t) => (
                <span
                  key={t}
                  className="px-2 py-0.5 rounded-md text-2xs font-medium bg-surface-2 text-ink-3 border border-line/60"
                >
                  {t}
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={() => onEdit(note)}
              className="block text-left text-sm font-semibold text-ink hover:text-accent transition-colors"
            >
              {note.title}
            </button>
            {note.content && (
              <p className="text-xs text-ink-2 line-clamp-2 max-w-3xl">
                {note.content}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onEdit(note)}
              title="Edit note"
              className="h-8 w-8 rounded-md hover:bg-surface-2 grid place-items-center text-ink-2 hover:text-ink transition-colors"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(note)}
              disabled={busyId === note.id}
              title="Delete note"
              className="h-8 w-8 rounded-md hover:bg-danger/10 grid place-items-center text-ink-3 hover:text-danger transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function VisibilityBadge({ visibility }: { visibility: KnowledgeNote['visibility'] }) {
  const isAssistant = visibility === 'assistant';
  return (
    <span
      title={
        isAssistant
          ? 'The assistant may answer customers using this note.'
          : 'Only your team can see this. The assistant will never quote it.'
      }
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-2xs font-semibold border',
        isAssistant
          ? 'bg-accent-soft text-accent border-accent-line'
          : 'bg-surface-2 text-ink-3 border-line/60'
      )}
    >
      {isAssistant ? <Bot className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
      {isAssistant ? 'Assistant can use' : 'Team only'}
    </span>
  );
}

function NoteEditor({
  note,
  onCancel,
  onSave,
}: {
  note: Partial<KnowledgeNote>;
  onCancel: () => void;
  onSave: (n: Partial<KnowledgeNote>) => void;
}) {
  const [title, setTitle] = useState(note.title || '');
  const [content, setContent] = useState(note.content || '');
  const [tags, setTags] = useState((note.tags || []).join(', '));
  const [visibility, setVisibility] = useState<KnowledgeNote['visibility']>(
    note.visibility || 'agent_only'
  );
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    await onSave({
      id: note.id,
      title,
      content,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      visibility,
    });
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-overlay p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-line popover shadow-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-line flex items-center justify-between">
          <h3 className="text-md font-semibold text-ink">
            {note.id ? 'Edit note' : 'New team note'}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="w-7 h-7 grid place-items-center rounded-md text-ink-3 hover:text-ink hover:bg-surface-2"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-2">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              placeholder="Refund policy for annual plans"
              className="w-full h-9 px-3 rounded-lg border border-line bg-surface-2/60 text-ui text-ink focus:outline-none focus:border-accent"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-2">Details</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={9}
              placeholder="Anything the team needs on hand. Plain text or markdown."
              className="w-full px-3 py-2.5 rounded-lg border border-line bg-surface-2/60 text-ui leading-relaxed text-ink focus:outline-none focus:border-accent resize-y"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-2">
              Tags <span className="text-ink-3 font-normal">(comma separated)</span>
            </label>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="billing, escalation"
              className="w-full h-9 px-3 rounded-lg border border-line bg-surface-2/60 text-ui text-ink focus:outline-none focus:border-accent"
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-ink-2 mb-1.5">
              Who can use this
            </legend>
            {(
              [
                [
                  'agent_only',
                  'Team only',
                  'Visible in the dashboard. The assistant will never quote it to a customer.',
                ],
                [
                  'assistant',
                  'Assistant can use it',
                  'The assistant may answer customers from this. Only put things here you would be happy for a customer to read.',
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={cn(
                  'flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-colors',
                  visibility === value
                    ? 'border-accent bg-accent-soft/40'
                    : 'border-line hover:bg-surface-2/60'
                )}
              >
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === value}
                  onChange={() => setVisibility(value)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-ui font-medium text-ink">{label}</span>
                  <span className="block text-xs text-ink-3 mt-0.5">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>

        <div className="px-5 py-3.5 border-t border-line flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 px-3.5 rounded-lg border border-line text-ui font-medium text-ink hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !title.trim()}
            className="h-9 px-4 rounded-lg bg-accent text-accent-ink text-ui font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save note'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Gaps ─────────────────────────────────────────────────────────────── */

function GapsList({
  gaps,
  busyId,
  onResolve,
  onCreateArticle,
  onCreateNote,
}: {
  gaps: GroupedGap[];
  busyId: string | null;
  onResolve: (g: GroupedGap, status: 'answered' | 'ignored') => void;
  onCreateArticle?: (title: string) => void;
  onCreateNote: (g: GroupedGap) => void;
}) {
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(gaps.length / PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [totalPages, page]);

  if (gaps.length === 0) {
    return (
      <div className="p-12 rounded-2xl border border-dashed border-line text-center space-y-2 bg-surface-2/40">
        <Check className="w-9 h-9 text-success mx-auto stroke-[1.5]" />
        <div className="text-md font-semibold text-ink">No open gaps</div>
        <p className="text-xs text-ink-3 max-w-md mx-auto">
          Every question customers have asked was covered by an article or a note.
          Anything the assistant cannot answer will show up here.
        </p>
      </div>
    );
  }

  const paginatedGaps = gaps.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className="border border-line rounded-xl overflow-hidden bg-surface divide-y divide-line/80">
        {paginatedGaps.map((gap) => (
          <div key={gap.id} className="p-4 flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                {gap.timesAsked > 1 && (
                  <span className="px-2 py-0.5 rounded-md text-2xs font-bold bg-warn/10 text-warn border border-warn/20">
                    asked {gap.timesAsked}×
                  </span>
                )}
                {gap.questionCount > 1 && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-2xs font-medium bg-surface-2 text-ink-2 border border-line/60"
                    title={`Grouped similar questions:\n${gap.allQuestions.map((q) => `• ${q}`).join('\n')}`}
                  >
                    <Layers className="w-3 h-3 text-ink-3" />
                    <span>{gap.questionCount} similar questions</span>
                  </span>
                )}
                <span className="text-2xs text-ink-3">
                  last {new Date(gap.lastAskedAt).toLocaleDateString()}
                </span>
              </div>
              <p className="text-sm font-medium text-ink">“{gap.primaryQuestion}”</p>
              {gap.reason && (
                <p className="text-xs text-ink-3">Why it went unanswered: {gap.reason}</p>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {onCreateArticle && (
                <button
                  type="button"
                  onClick={() => onCreateArticle(gap.primaryQuestion)}
                  title="Write a public article answering this"
                  className="h-8 px-2.5 rounded-lg border border-line text-xs font-medium text-ink hover:bg-surface-2 inline-flex items-center gap-1.5"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Write article
                </button>
              )}
              <button
                type="button"
                onClick={() => onCreateNote(gap)}
                title="Answer it in a team note instead"
                className="h-8 px-2.5 rounded-lg border border-line text-xs font-medium text-ink hover:bg-surface-2 inline-flex items-center gap-1.5"
              >
                <Lock className="w-3.5 h-3.5" />
                Note
              </button>
              <button
                type="button"
                onClick={() => onResolve(gap, 'answered')}
                disabled={busyId === gap.id}
                title="Mark as covered"
                className="h-8 w-8 rounded-md hover:bg-success/10 grid place-items-center text-ink-3 hover:text-success disabled:opacity-50"
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => onResolve(gap, 'ignored')}
                disabled={busyId === gap.id}
                title="Out of scope — stop showing this"
                className="h-8 w-8 rounded-md hover:bg-surface-2 grid place-items-center text-ink-3 hover:text-ink disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-2 py-1 text-xs text-ink-3">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1} to{' '}
            {Math.min(page * PAGE_SIZE, gaps.length)} of {gaps.length} gaps
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="h-7 px-2.5 rounded-md border border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-30 disabled:pointer-events-none inline-flex items-center gap-1 text-xs"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Previous
            </button>
            <span className="px-2 text-xs font-medium text-ink">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="h-7 px-2.5 rounded-md border border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-30 disabled:pointer-events-none inline-flex items-center gap-1 text-xs"
            >
              Next
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

