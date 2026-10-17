'use client';

import React, { useMemo, useRef, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { deleteMacroAction, saveMacroAction, type MacroRow } from '@/app/actions/automation';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { describeAction, validateMacroDraft, type MacroDraft } from '@/lib/automation/rules';
import { ActionRows, PlaceholderHelp, type Lookups } from './RuleFields';

const blank = (shared: boolean): MacroDraft => ({ title: '', content: '', shared, is_active: true, actions: [] });

/** Settings → Automation → Macros. Admins manage shared macros; anyone who can reply manages their own. */
export function MacrosPanel({
  workspaceId,
  macros,
  lookups,
  meId,
  canShare,
  onChange,
}: {
  workspaceId: string;
  macros: MacroRow[];
  lookups: Lookups;
  meId: string;
  canShare: boolean;
  onChange: (next: MacroRow[]) => void;
}) {
  const toast = useToast();
  const [scope, setScope] = useState<'shared' | 'mine'>('shared');
  const [editing, setEditing] = useState<MacroDraft | null>(null);
  const [deleting, setDeleting] = useState<MacroRow | null>(null);
  const [busy, setBusy] = useState(false);
  const names = { groups: Object.fromEntries(lookups.groups.map((g) => [g.id, g.name])), people: Object.fromEntries(lookups.people.map((p) => [p.id, p.name])) };

  const shared = useMemo(() => macros.filter((m) => m.owner_id === null), [macros]);
  const mine = useMemo(() => macros.filter((m) => m.owner_id === meId), [macros, meId]);
  const list = scope === 'shared' ? shared : mine;

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    const res = await deleteMacroAction(workspaceId, deleting.id);
    setBusy(false);
    if (!res.success) return toast.error(res.error);
    onChange(macros.filter((m) => m.id !== deleting.id));
    setDeleting(null);
    toast.success('Macro deleted.');
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          variant="pill"
          label="Macro scope"
          value={scope}
          onChange={setScope}
          items={[
            { id: 'shared', label: 'Shared with team', count: shared.length },
            { id: 'mine', label: 'My macros', count: mine.length },
          ]}
        />
        <p className="flex-1 min-w-[14rem] text-ui text-ink-2">Agents type “/” in the reply box to find a macro. Personal macros are visible only to you.</p>
        <Button variant="primary" size="sm" disabled={scope === 'shared' && !canShare} onClick={() => setEditing(blank(scope === 'shared'))}>
          <Plus className="w-3.5 h-3.5" /> New macro
        </Button>
      </div>

      {list.length === 0 ? (
        <div className="card p-4">
          <EmptyState
            type="custom"
            title={scope === 'shared' ? 'No shared macros yet' : 'You have no personal macros yet'}
            description="A macro inserts a reply and can set status, priority, tags or assignee in one click."
            actionLabel="New macro"
            onAction={scope === 'shared' && !canShare ? undefined : () => setEditing(blank(scope === 'shared'))}
          />
        </div>
      ) : (
        <ul className="space-y-3">
          {list.map((m) => {
            const editable = m.owner_id !== null || canShare;
            return (
              <li key={m.id} className="card p-4 flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1 basis-60">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-md font-semibold text-ink break-words">{m.title}</h3>
                    {!m.is_active && <Badge>Off</Badge>}
                  </div>
                  {m.content && <p className="text-ui text-ink-2 mt-1 line-clamp-2 whitespace-pre-line">{m.content}</p>}
                  {m.actions.length > 0 && <p className="text-xs text-ink-3 mt-1.5">Also: {m.actions.map((a) => describeAction(a, names)).join(' · ')}</p>}
                </div>
                {editable && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button iconOnly variant="ghost" size="sm" aria-label={`Edit ${m.title}`} onClick={() => setEditing({ id: m.id, title: m.title, content: m.content, shared: m.owner_id === null, is_active: m.is_active, actions: m.actions })}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button iconOnly variant="ghost" size="sm" aria-label={`Delete ${m.title}`} onClick={() => setDeleting(m)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <MacroEditor
          workspaceId={workspaceId}
          initial={editing}
          lookups={lookups}
          onClose={() => setEditing(null)}
          onSaved={(macro) => {
            onChange(macros.some((m) => m.id === macro.id) ? macros.map((m) => (m.id === macro.id ? macro : m)) : [...macros, macro]);
            setEditing(null);
          }}
        />
      )}

      {deleting && (
        <Modal
          title={`Delete “${deleting.title}”?`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                Keep it
              </Button>
              <Button variant="danger" loading={busy} onClick={remove}>
                Delete macro
              </Button>
            </>
          }
        >
          <p className="text-ui text-ink-2">Replies already sent with it are not affected.</p>
        </Modal>
      )}
    </div>
  );
}

function MacroEditor({
  workspaceId,
  initial,
  lookups,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  initial: MacroDraft;
  lookups: Lookups;
  onClose: () => void;
  onSaved: (macro: MacroRow) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState(initial);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const errors = validateMacroDraft(draft);
  const shown = showErrors ? errors : { actions: {} as Record<number, string> };
  const set = (patch: Partial<MacroDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setServerError(null);
  };

  function insert(token: string) {
    const el = contentRef.current;
    const start = el?.selectionStart ?? draft.content.length;
    const end = el?.selectionEnd ?? start;
    set({ content: draft.content.slice(0, start) + token + draft.content.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save() {
    setShowErrors(true);
    if (errors.title || errors.content || Object.keys(errors.actions).length) return;
    setSaving(true);
    const res = await saveMacroAction(workspaceId, draft);
    setSaving(false);
    if (!res.success) return setServerError(res.error);
    toast.success(draft.id ? 'Macro saved.' : 'Macro created.');
    onSaved(res.macro);
  }

  return (
    <Modal
      title={`${draft.id ? 'Edit' : 'New'} ${draft.shared ? 'shared' : 'personal'} macro`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {serverError && (
            <span role="alert" className="mr-auto text-ui text-danger font-medium">
              {serverError}
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            Save macro
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Title" hint="What agents search for after typing “/”." error={showErrors ? errors.title : undefined}>
          <Input inputSize="md" value={draft.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} data-autofocus />
        </Field>
        <div className="space-y-2">
          <Field label="Reply (optional)" error={showErrors ? errors.content : undefined}>
            <Textarea ref={contentRef} rows={6} value={draft.content} onChange={(e) => set({ content: e.target.value })} placeholder="Hi {{ticket.requester.first_name}}, …" />
          </Field>
          <PlaceholderHelp onInsert={insert} />
        </div>
        <section className="space-y-2" aria-labelledby="macro-actions">
          <h3 id="macro-actions" className="text-md font-semibold text-ink">
            Also change
          </h3>
          <p className="text-ui text-ink-2">Applied when the agent sends the reply.</p>
          <ActionRows macro actions={draft.actions} errors={shown.actions} lookups={lookups} onChange={(actions) => set({ actions })} />
        </section>
        <label className="inline-flex items-center gap-2 text-ui text-ink">
          <input type="checkbox" className="w-4 h-4 accent-[var(--ds-accent)]" checked={draft.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
          Available in the reply box
        </label>
      </div>
    </Modal>
  );
}
