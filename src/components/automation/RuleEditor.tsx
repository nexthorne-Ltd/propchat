'use client';

import React, { useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { saveRuleAction, testRuleAction, type RuleTestResult } from '@/app/actions/automation';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { blankCondition, describeAction, fieldDef, hasErrors, validateRuleDraft, type RuleDraft, type RuleKind, type RuleRow } from '@/lib/automation/rules';
import { ActionRows, ConditionRows, type Lookups } from './RuleFields';

export function newDraft(kind: RuleKind): RuleDraft {
  return { kind, name: '', description: '', is_active: true, match_mode: 'all', conditions: [blankCondition(kind)], actions: [] };
}

export function draftFromRow(row: RuleRow): RuleDraft {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    is_active: row.is_active,
    match_mode: row.match_mode,
    conditions: row.conditions,
    actions: row.actions,
  };
}

function conditionLabel(c: { field: string; op: string }) {
  const def = fieldDef(c.field);
  return `${def?.label ?? c.field} ${def?.ops.find((o) => o.id === c.op)?.label ?? c.op}`;
}

/** Create or edit one trigger or automation, and test it against a real ticket. */
export function RuleEditor({
  workspaceId,
  initial,
  lookups,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  initial: RuleDraft;
  lookups: Lookups;
  onClose: () => void;
  onSaved: (rule: RuleRow) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [ticketNumber, setTicketNumber] = useState('');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ result?: RuleTestResult; error?: string } | null>(null);

  const errors = useMemo(() => validateRuleDraft(draft), [draft]);
  const shown = showErrors ? errors : { conditions: {}, actions: {} };
  const set = (patch: Partial<RuleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setServerError(null);
    setTest(null);
  };
  const isTrigger = draft.kind === 'trigger';

  async function save() {
    setShowErrors(true);
    if (hasErrors(errors)) return;
    setSaving(true);
    const res = await saveRuleAction(workspaceId, draft);
    setSaving(false);
    if (!res.success) return setServerError(res.error);
    toast.success(draft.id ? 'Rule saved.' : 'Rule created.');
    onSaved(res.rule);
  }

  async function runTest() {
    setShowErrors(true);
    if (hasErrors(errors)) return setTest({ error: 'Fix the highlighted problems first.' });
    setTesting(true);
    const res = await testRuleAction(workspaceId, draft, Number(ticketNumber.replace('#', '')));
    setTesting(false);
    setTest(res.success ? { result: res.result } : { error: res.error });
  }

  return (
    <Modal
      title={`${draft.id ? 'Edit' : 'New'} ${isTrigger ? 'trigger' : 'automation'}`}
      description={isTrigger ? 'Runs instantly when a ticket is created or updated.' : 'Checked every hour against open tickets.'}
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
            Save rule
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <Field label="Name" error={shown.name}>
          <Input inputSize="md" value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} data-autofocus />
        </Field>
        <Field label="Description (optional)" hint="Shown in the list so teammates know why this rule exists.">
          <Textarea rows={2} value={draft.description} maxLength={500} onChange={(e) => set({ description: e.target.value })} />
        </Field>

        <section aria-labelledby="rule-conditions" className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h3 id="rule-conditions" className="text-md font-semibold text-ink">
              Conditions
            </h3>
            <Tabs
              variant="pill"
              label="Match mode"
              value={draft.match_mode}
              onChange={(m) => set({ match_mode: m })}
              items={[
                { id: 'all', label: 'Match all' },
                { id: 'any', label: 'Match any' },
              ]}
            />
          </div>
          <ConditionRows kind={draft.kind} conditions={draft.conditions} errors={shown.conditions} lookups={lookups} onChange={(conditions) => set({ conditions })} />
          {shown.form && draft.conditions.length === 0 && (
            <p role="alert" className="text-2xs font-medium text-danger">
              {shown.form}
            </p>
          )}
        </section>

        <section aria-labelledby="rule-actions" className="space-y-3">
          <h3 id="rule-actions" className="text-md font-semibold text-ink">
            Actions
          </h3>
          <ActionRows actions={draft.actions} errors={shown.actions} lookups={lookups} onChange={(actions) => set({ actions })} />
          {shown.form && draft.conditions.length > 0 && (
            <p role="alert" className="text-2xs font-medium text-danger">
              {shown.form}
            </p>
          )}
        </section>

        <section aria-labelledby="rule-test" className="space-y-3 rounded-lg border border-line p-4">
          <div>
            <h3 id="rule-test" className="text-md font-semibold text-ink">
              Test on a ticket
            </h3>
            <p className="text-ui text-ink-2">See what this rule would do to a real ticket. Nothing is changed or sent.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Ticket number" className="w-40">
              <Input inputMode="numeric" placeholder="1001" value={ticketNumber} onChange={(e) => setTicketNumber(e.target.value)} />
            </Field>
            <Button loading={testing} disabled={!ticketNumber.trim()} onClick={runTest}>
              Run test
            </Button>
          </div>
          {test?.error && (
            <p role="alert" className="text-ui text-danger font-medium">
              {test.error}
            </p>
          )}
          {test?.result && (
            <div className="space-y-3" aria-live="polite">
              <p className="text-ui text-ink">
                <Badge tone={test.result.matches ? 'success' : 'neutral'}>{test.result.matches ? 'Would run' : 'Would not run'}</Badge>{' '}
                on #{test.result.ticket.number} {test.result.ticket.subject && <span className="text-ink-2">“{test.result.ticket.subject}”</span>}
              </p>
              <ul className="space-y-1">
                {test.result.conditions.map((c, i) => (
                  <li key={i} className="flex items-center gap-2 text-ui text-ink-2">
                    {c.holds ? <Check className="w-4 h-4 text-success shrink-0" aria-label="Holds" /> : <X className="w-4 h-4 text-danger shrink-0" aria-label="Does not hold" />}
                    <span>{conditionLabel(c.condition)}</span>
                    {c.assumed && <span className="text-2xs text-ink-3">(depends on what happens; assumed true)</span>}
                  </li>
                ))}
              </ul>
              {test.result.matches && (
                <div>
                  <p className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-1">It would</p>
                  <ul className="list-disc pl-5 text-ui text-ink-2 space-y-0.5">
                    {test.result.actions.map((a, i) => (
                      <li key={i}>{describeAction({ type: a.type, value: a.value }, { groups: Object.fromEntries(lookups.groups.map((g) => [g.id, g.name])), people: Object.fromEntries(lookups.people.map((p) => [p.id, p.name])) })}</li>
                    ))}
                  </ul>
                </div>
              )}
              {test.result.email_previews.map((m, i) => (
                <div key={i} className="rounded-md bg-surface-2 border border-line p-3 text-ui">
                  <p className="text-xs text-ink-3">{m.type === 'email_requester' ? 'Email to the requester' : 'Email to the assignee'}</p>
                  <p className="font-semibold text-ink">{m.subject}</p>
                  <p className="text-ink-2 whitespace-pre-wrap">{m.body}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
