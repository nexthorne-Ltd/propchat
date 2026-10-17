'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { BookCheck, Pencil, ShieldAlert, ShieldCheck, ShieldQuestion, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/lib/errors/user-error';
import { SaveBar, SettingsCard, useReportDirty } from './parts';
import {
  approveLearningCandidateAction,
  getLearningOverviewAction,
  listLearningCandidatesAction,
  rejectLearningCandidateAction,
  saveLearningSettingsAction,
  type CandidateFilter,
  type LearningCandidate,
  type LearningOverview,
} from '@/app/actions/bot-learning';
import type { LearningSettings } from '@/lib/ai/learning/learner';

/**
 * Settings → AI bot → Self-learning. The bot learns from answers the team
 * gave to questions it could not answer; this screen holds the switches and
 * the review queue. The rules themselves are in src/lib/ai/learning/.
 */

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${checked ? 'bg-accent border-accent' : 'bg-surface-3 border-line'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-surface shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

const ARM_LABEL = { strict: 'Strict', standard: 'Standard', open: 'Open' } as const;

function GroundingBadge({ c }: { c: LearningCandidate }) {
  if (c.grounding === 'grounded') {
    return (
      <Badge tone="success">
        <ShieldCheck className="w-3 h-3" aria-hidden="true" /> Backed by your help center
      </Badge>
    );
  }
  if (c.grounding === 'contradicts') {
    return (
      <Badge tone="danger">
        <ShieldAlert className="w-3 h-3" aria-hidden="true" /> Contradicts your help center
      </Badge>
    );
  }
  return (
    <Badge tone="warn">
      <ShieldQuestion className="w-3 h-3" aria-hidden="true" /> New information: check it
    </Badge>
  );
}

function CandidateCard({
  c,
  filter,
  busy,
  onApprove,
  onReject,
}: {
  c: LearningCandidate;
  filter: CandidateFilter;
  busy: boolean;
  onApprove: (c: LearningCandidate, edits: { question: string; answer: string }) => void;
  onReject: (c: LearningCandidate) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState(c.question);
  const [answer, setAnswer] = useState(c.answer);
  const canApprove = filter !== 'learned' && c.grounding !== 'contradicts';

  return (
    <li className="rounded-xl border border-line bg-surface p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <GroundingBadge c={c} />
        <Badge tone="neutral">Asked {c.occurrences} {c.occurrences === 1 ? 'time' : 'times'}</Badge>
        {c.status === 'auto_approved' && <Badge tone="accent">Learned automatically</Badge>}
        {c.status === 'stale' && <Badge tone="info">Source article changed: being re-checked</Badge>}
      </div>

      {editing ? (
        <div className="space-y-3">
          <Field label="Question">
            <Input value={question} maxLength={500} onChange={(e) => setQuestion(e.target.value)} />
          </Field>
          <Field label="Answer the bot will give" hint="Every visitor can see this. Keep it general: no names, emails or order numbers.">
            <Textarea rows={5} value={answer} maxLength={4000} onChange={(e) => setAnswer(e.target.value)} />
          </Field>
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-ui font-semibold text-ink">{c.question}</p>
          <p className="text-ui text-ink-2 whitespace-pre-wrap">{c.answer}</p>
        </div>
      )}

      {c.reject_reason && filter === 'rejected' && <p className="text-xs text-ink-3">Reason: {c.reject_reason}</p>}
      {c.grounding === 'contradicts' && (
        <p className="text-xs text-ink-2">
          Your team said something different from your help center. If the article is out of date, update the article: the bot answers from it.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canApprove && (
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={() => onApprove(c, { question, answer })}
            disabled={!question.trim() || !answer.trim()}
          >
            <BookCheck className="w-4 h-4" aria-hidden="true" /> {editing ? 'Save and teach the bot' : 'Teach the bot'}
          </Button>
        )}
        {canApprove && !editing && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={busy}>
            <Pencil className="w-4 h-4" aria-hidden="true" /> Edit
          </Button>
        )}
        {editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setQuestion(c.question);
              setAnswer(c.answer);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
        )}
        {filter !== 'rejected' && (
          <Button size="sm" variant={filter === 'learned' ? 'danger' : 'ghost'} onClick={() => onReject(c)} disabled={busy}>
            {filter === 'learned' ? 'Remove from the bot' : 'Reject'}
          </Button>
        )}
      </div>
    </li>
  );
}

export function BotLearningSettings({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [overview, setOverview] = useState<LearningOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<LearningSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [filter, setFilter] = useState<CandidateFilter>('review');
  const [candidates, setCandidates] = useState<LearningCandidate[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Fetchers return their result; state is set in the callers' callbacks, so
  // the effects below only subscribe to the result (react-hooks/set-state-in-effect).
  const fetchOverview = useCallback(async (): Promise<{ overview: LearningOverview | null; error: string | null }> => {
    try {
      const res = await getLearningOverviewAction(workspaceId);
      return res.success ? { overview: res.overview, error: null } : { overview: null, error: res.error };
    } catch (e) {
      return { overview: null, error: errorMessage(e) };
    }
  }, [workspaceId]);

  const fetchList = useCallback(async (f: CandidateFilter): Promise<{ candidates: LearningCandidate[] | null; error: string | null }> => {
    try {
      const res = await listLearningCandidatesAction(workspaceId, f);
      return res.success ? { candidates: res.candidates, error: null } : { candidates: null, error: res.error };
    } catch (e) {
      return { candidates: null, error: errorMessage(e) };
    }
  }, [workspaceId]);

  const applyOverview = (r: { overview: LearningOverview | null; error: string | null }) => {
    if (r.overview) {
      setOverview(r.overview);
      setForm(r.overview.settings);
    }
    setLoadError(r.error);
  };
  const applyList = (r: { candidates: LearningCandidate[] | null; error: string | null }) => {
    setCandidates(r.candidates);
    setListError(r.error);
  };

  useEffect(() => {
    let cancelled = false;
    fetchOverview().then((r) => !cancelled && applyOverview(r));
    return () => {
      cancelled = true;
    };
  }, [fetchOverview]);
  useEffect(() => {
    let cancelled = false;
    fetchList(filter).then((r) => !cancelled && applyList(r));
    return () => {
      cancelled = true;
    };
  }, [fetchList, filter]);

  const loadOverview = async () => {
    setLoadError(null);
    applyOverview(await fetchOverview());
  };
  const loadList = async (f: CandidateFilter) => {
    setCandidates(null);
    setListError(null);
    applyList(await fetchList(f));
  };
  const changeFilter = (f: CandidateFilter) => {
    setCandidates(null);
    setListError(null);
    setFilter(f);
  };

  const saved = overview?.settings;
  const dirty =
    !!saved &&
    !!form &&
    (form.enabled !== saved.enabled ||
      form.autoApprove !== saved.autoApprove ||
      form.minOccurrences !== saved.minOccurrences ||
      form.adaptiveRetrieval !== saved.adaptiveRetrieval);
  useReportDirty(dirty);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveLearningSettingsAction(workspaceId, form);
      if (!res.success) return setSaveError(res.error);
      setOverview((o) => (o ? { ...o, settings: res.settings } : o));
      setForm(res.settings);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const refresh = async () => {
    await Promise.all([loadOverview(), loadList(filter)]);
  };

  const approve = async (c: LearningCandidate, edits: { question: string; answer: string }) => {
    setBusyId(c.id);
    try {
      const res = await approveLearningCandidateAction(workspaceId, c.id, edits);
      if (!res.success) return toast.error(res.error);
      toast.success(
        res.embedded
          ? 'The bot now knows this answer.'
          : 'Saved. The bot will use it once it is indexed (Help Center → Bot knowledge shows the status).'
      );
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (c: LearningCandidate) => {
    setBusyId(c.id);
    try {
      const res = await rejectLearningCandidateAction(workspaceId, c.id);
      if (!res.success) return toast.error(res.error);
      toast.success(filter === 'learned' ? 'Removed. The bot no longer uses this answer.' : 'Rejected. It will not be suggested again.');
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  if (loadError) return <ErrorState title="Could not load self-learning" message={loadError} onRetry={loadOverview} />;
  if (!overview || !form) return <LoadingState label="Loading self-learning…" />;

  const set = (patch: Partial<LearningSettings>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const counts = overview.counts;
  const totalPulls = overview.arms.reduce((n, a) => n + a.pulls, 0);

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Self-learning"
        description="When the bot hands a question to your team and your team solves it, the bot learns the answer for next time. It only learns what your team said, never from visitors or from itself, and it checks every answer against your help center first."
      >
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-ui font-medium text-ink">Learn from solved conversations</p>
              <p className="text-xs text-ink-2">Off: nothing new is suggested. What the bot already learned stays until you remove it.</p>
            </div>
            <Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Learn from solved conversations" />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-ui font-medium text-ink">Approve answers your help center backs up</p>
              <p className="text-xs text-ink-2">
                Answers that match your articles are learned automatically once the question has been asked often enough. New information always waits for you.
              </p>
            </div>
            <Switch checked={form.autoApprove} onChange={(v) => set({ autoApprove: v })} label="Approve answers your help center backs up" />
          </div>

          <Field label="Times asked before automatic approval" hint="Between 2 and 20." className="max-w-xs">
            <Input
              type="number"
              min={2}
              max={20}
              value={form.minOccurrences}
              disabled={!form.autoApprove}
              onChange={(e) => set({ minOccurrences: Number(e.target.value) })}
            />
          </Field>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-ui font-medium text-ink">Tune how closely an article must match</p>
              <p className="text-xs text-ink-2">
                The bot tries three fixed levels and keeps the one visitors respond to best. It changes when the bot answers, never what it says.
              </p>
            </div>
            <Switch checked={form.adaptiveRetrieval} onChange={(v) => set({ adaptiveRetrieval: v })} label="Tune how closely an article must match" />
          </div>

          {totalPulls > 0 && (
            <ul className="grid grid-cols-1 sm:grid-cols-3 gap-2" aria-label="Match levels">
              {overview.arms.map((a) => (
                <li key={a.arm} className="rounded-lg border border-line bg-surface-2 px-3 py-2">
                  <p className="text-xs font-medium text-ink">{ARM_LABEL[a.arm]}</p>
                  <p className="text-2xs text-ink-3">
                    {a.pulls} {a.pulls === 1 ? 'reply' : 'replies'} · {Math.round(a.score * 100)}% helpful
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title="What the bot learned" description="Approve, edit or reject suggestions. Removing a learned answer stops the bot using it at once.">
        <Tabs<CandidateFilter>
          label="Suggestions"
          value={filter}
          onChange={changeFilter}
          items={[
            { id: 'review', label: 'To review', count: counts.review },
            { id: 'learned', label: 'Learned', count: counts.learned },
            { id: 'rejected', label: 'Rejected', count: counts.rejected },
          ]}
        />
        <div className="mt-4">
          {listError ? (
            <ErrorState title="Could not load suggestions" message={listError} onRetry={() => loadList(filter)} />
          ) : !candidates ? (
            <LoadingState label="Loading suggestions…" />
          ) : candidates.length === 0 ? (
            <EmptyState
              type="custom"
              title={filter === 'review' ? 'Nothing to review' : filter === 'learned' ? 'Nothing learned yet' : 'Nothing rejected'}
              description={
                filter === 'review'
                  ? 'Suggestions appear here after your team solves a question the bot could not answer. Checked once an hour.'
                  : filter === 'learned'
                  ? 'Approved answers show here. The bot answers from them like any Bot knowledge entry.'
                  : 'Rejected suggestions are remembered so they are not suggested again.'
              }
            />
          ) : (
            <ul className="space-y-3">
              {candidates.map((c) => (
                <CandidateCard key={c.id} c={c} filter={filter} busy={busyId === c.id} onApprove={approve} onReject={reject} />
              ))}
            </ul>
          )}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-2xs text-ink-3">
          <Sparkles className="w-3 h-3" aria-hidden="true" /> Answers with personal details or about one customer&apos;s account are never suggested.
        </p>
      </SettingsCard>

      <SaveBar dirty={dirty} saving={saving} saved={justSaved} error={saveError} onSave={save} onDiscard={() => setForm(overview.settings)} />
    </div>
  );
}
