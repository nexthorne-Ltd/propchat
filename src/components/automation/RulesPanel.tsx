'use client';

import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { deleteRuleAction, installDefaultRulesAction, reorderRulesAction, setRuleActiveAction } from '@/app/actions/automation';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { describeAction, fieldDef, type RuleKind, type RuleRow } from '@/lib/automation/rules';
import { RuleEditor, draftFromRow, newDraft } from './RuleEditor';
import type { Lookups } from './RuleFields';

function conditionText(c: RuleRow['conditions'][number]): string {
  const def = fieldDef(c.field);
  const op = def?.ops.find((o) => o.id === c.op)?.label ?? c.op;
  const value = c.value === undefined ? '' : Array.isArray(c.value) ? c.value.join(', ') : String(c.value);
  const shown = def?.options?.find((o) => o.value === value)?.label ?? value;
  return `${def?.label ?? c.field} ${op}${shown ? ` ${shown}` : ''}`;
}

/** Settings → Automation → Triggers / Automations. */
export function RulesPanel({
  workspaceId,
  kind,
  rules,
  lookups,
  onChange,
  onReload,
}: {
  workspaceId: string;
  kind: RuleKind;
  rules: RuleRow[];
  lookups: Lookups;
  onChange: (next: RuleRow[]) => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const mine = rules.filter((r) => r.kind === kind).sort((a, b) => a.position - b.position);
  const [editing, setEditing] = useState<ReturnType<typeof newDraft> | null>(null);
  const [deleting, setDeleting] = useState<RuleRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const names = { groups: Object.fromEntries(lookups.groups.map((g) => [g.id, g.name])), people: Object.fromEntries(lookups.people.map((p) => [p.id, p.name])) };
  const noun = kind === 'trigger' ? 'trigger' : 'automation';

  const merge = (rule: RuleRow) => onChange(rules.some((r) => r.id === rule.id) ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule]);

  async function toggle(rule: RuleRow) {
    setBusy(rule.id);
    const res = await setRuleActiveAction(workspaceId, rule.id, !rule.is_active);
    setBusy(null);
    if (!res.success) return toast.error(res.error);
    merge(res.rule);
  }

  async function move(index: number, dir: -1 | 1) {
    const order = mine.map((r) => r.id);
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    // Optimistic: show the new order now, undo it if the save is refused.
    const positions = new Map(order.map((id, i) => [id, i + 1]));
    onChange(rules.map((r) => (positions.has(r.id) ? { ...r, position: positions.get(r.id)! } : r)));
    const res = await reorderRulesAction(workspaceId, kind, order);
    if (!res.success) {
      toast.error(res.error);
      onReload();
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(deleting.id);
    const res = await deleteRuleAction(workspaceId, deleting.id);
    setBusy(null);
    if (!res.success) return toast.error(res.error);
    onChange(rules.filter((r) => r.id !== deleting.id));
    setDeleting(null);
    toast.success('Rule deleted.');
  }

  async function installDefaults() {
    setBusy('defaults');
    const res = await installDefaultRulesAction(workspaceId);
    setBusy(null);
    if (!res.success) return toast.error(res.error);
    onReload();
    toast.success('Recommended rules added. The ones that send email are switched off.');
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 min-w-[16rem] text-ui text-ink-2">
          {kind === 'trigger'
            ? 'Triggers run in the order shown, top to bottom, every time a ticket is created or updated. A rule that has already run on a ticket will not run again in the same chain of changes.'
            : 'Automations run once an hour. After one fires, it will not fire again on the same ticket until something changes on it.'}
        </p>
        <Button variant="primary" size="sm" onClick={() => setEditing(newDraft(kind))}>
          <Plus className="w-3.5 h-3.5" /> New {noun}
        </Button>
      </div>

      {mine.length === 0 ? (
        <div className="card p-4">
          <EmptyState
            type="custom"
            title={`No ${noun}s yet`}
            description={`Create your first ${noun}, or start from the recommended set.`}
            actionLabel={`New ${noun}`}
            onAction={() => setEditing(newDraft(kind))}
            secondaryActionLabel={busy === 'defaults' ? 'Adding…' : 'Add recommended rules'}
            onSecondaryAction={installDefaults}
          />
        </div>
      ) : (
        <ol className="space-y-3" aria-label={`${noun}s in run order`}>
          {mine.map((rule, i) => (
            <li key={rule.id} className="card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-surface-3 text-ink-2 text-2xs font-semibold flex items-center justify-center shrink-0 tabular-nums" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 basis-60">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-md font-semibold text-ink break-words">{rule.name}</h3>
                    <Badge tone={rule.is_active ? 'success' : 'neutral'} dot>
                      {rule.is_active ? 'On' : 'Off'}
                    </Badge>
                  </div>
                  {rule.description && <p className="text-ui text-ink-2 mt-0.5">{rule.description}</p>}
                  <dl className="mt-2 grid gap-1 text-xs text-ink-2">
                    <div>
                      <dt className="inline font-semibold text-ink-3">If {rule.match_mode === 'all' ? 'all' : 'any'} of: </dt>
                      <dd className="inline">{rule.conditions.map(conditionText).join(' · ')}</dd>
                    </div>
                    <div>
                      <dt className="inline font-semibold text-ink-3">Then: </dt>
                      <dd className="inline">{rule.actions.map((a) => describeAction(a, names)).join(' · ')}</dd>
                    </div>
                  </dl>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <label className="inline-flex items-center gap-1.5 text-xs text-ink-2 mr-1 min-h-9">
                    <input type="checkbox" className="w-4 h-4 accent-[var(--ds-accent)]" checked={rule.is_active} disabled={busy === rule.id} onChange={() => toggle(rule)} />
                    Enabled
                  </label>
                  <Button iconOnly variant="ghost" size="sm" aria-label={`Move ${rule.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="w-4 h-4" />
                  </Button>
                  <Button iconOnly variant="ghost" size="sm" aria-label={`Move ${rule.name} down`} disabled={i === mine.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="w-4 h-4" />
                  </Button>
                  <Button iconOnly variant="ghost" size="sm" aria-label={`Edit ${rule.name}`} onClick={() => setEditing(draftFromRow(rule))}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button iconOnly variant="ghost" size="sm" aria-label={`Delete ${rule.name}`} onClick={() => setDeleting(rule)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {editing && (
        <RuleEditor
          workspaceId={workspaceId}
          initial={editing}
          lookups={lookups}
          onClose={() => setEditing(null)}
          onSaved={(rule) => {
            merge(rule);
            setEditing(null);
          }}
        />
      )}

      {deleting && (
        <Modal
          title={`Delete “${deleting.name}”?`}
          description="Tickets keep any changes the rule already made. The log entries for it stay."
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                Keep it
              </Button>
              <Button variant="danger" loading={busy === deleting.id} onClick={remove}>
                Delete rule
              </Button>
            </>
          }
        >
          <p className="text-ui text-ink-2">If you only want to pause it, switch it off instead.</p>
        </Modal>
      )}
    </div>
  );
}
