'use client';

import React, { useId, useMemo, useState } from 'react';
import { saveSlaPolicyAction } from '@/app/actions/sla';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { ChipGroup } from '@/components/tickets/TicketBits';
import { CHANNEL_LABEL, PRIORITY_LABEL, TICKET_CHANNELS } from '@/lib/tickets/views';
import {
  METRIC_LABEL,
  SLA_METRICS,
  SLA_PRIORITIES,
  hasPolicyErrors,
  normalizeConditions,
  normalizeTargets,
  parseList,
  splitMinutes,
  summarizePolicy,
  toMinutes,
  validatePolicyDraft,
  type DurationUnit,
  type SlaMetric,
  type SlaPolicyDraft,
  type SlaPolicyRow,
} from '@/lib/sla/policy';
import type { TicketPriority } from '@/types/database';

const UNIT_OPTIONS: { value: DurationUnit; label: string }[] = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
];

/** A number plus a unit, stored as whole minutes. Empty means "not tracked". */
function DurationField({
  label,
  minutes,
  onChange,
}: {
  label: string;
  minutes: number | undefined;
  onChange: (minutes: number | undefined) => void;
}) {
  const id = useId();
  const initial = minutes === undefined ? { value: NaN, unit: 'hours' as DurationUnit } : splitMinutes(minutes);
  const [unit, setUnit] = useState<DurationUnit>(initial.unit);
  const [text, setText] = useState(minutes === undefined ? '' : String(initial.value));

  const commit = (nextText: string, nextUnit: DurationUnit) => {
    const n = Number(nextText);
    onChange(nextText.trim() === '' || !Number.isFinite(n) || n <= 0 ? undefined : toMinutes(n, nextUnit));
  };

  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="flex gap-1.5">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          placeholder="Not tracked"
          className="min-w-0 flex-1"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value, unit);
          }}
        />
        <Select
          aria-label={`${label} unit`}
          className="w-28 shrink-0"
          value={unit}
          onChange={(e) => {
            const next = e.target.value as DurationUnit;
            setUnit(next);
            commit(text, next);
          }}
        >
          {UNIT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

/** Create or edit one SLA policy; the preview at the bottom is what the list will show. */
export function PolicyEditor({
  workspaceId,
  initial,
  groups,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  initial: SlaPolicyDraft;
  groups: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (row: SlaPolicyRow) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<SlaPolicyDraft>(initial);
  const [tagsText, setTagsText] = useState((initial.conditions.tags ?? []).join(', '));
  const [emailsText, setEmailsText] = useState((initial.conditions.requester_emails ?? []).join(', '));
  const [domainsText, setDomainsText] = useState((initial.conditions.requester_domains ?? []).join(', '));
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // The lists are typed as text; the draft the rest of the code sees has them parsed.
  const current = useMemo<SlaPolicyDraft>(
    () => ({
      ...draft,
      conditions: normalizeConditions({
        ...draft.conditions,
        tags: parseList(tagsText),
        requester_emails: parseList(emailsText),
        requester_domains: parseList(domainsText),
      }),
      targets: normalizeTargets(draft.targets),
    }),
    [draft, tagsText, emailsText, domainsText]
  );
  const errors = useMemo(() => validatePolicyDraft(current), [current]);
  const shown = showErrors ? errors : {};
  const lookups = useMemo(() => ({ groups: Object.fromEntries(groups.map((g) => [g.id, g.name])), channels: CHANNEL_LABEL as Record<string, string> }), [groups]);

  const set = (patch: Partial<SlaPolicyDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setServerError(null);
  };
  const setTarget = (prio: TicketPriority, metric: SlaMetric, minutes: number | undefined) => {
    setDraft((d) => {
      const row = { ...(d.targets[prio] ?? {}) };
      if (minutes === undefined) delete row[metric];
      else row[metric] = minutes;
      return { ...d, targets: { ...d.targets, [prio]: row } };
    });
    setServerError(null);
  };

  async function save() {
    setShowErrors(true);
    if (hasPolicyErrors(errors)) return;
    setSaving(true);
    const res = await saveSlaPolicyAction(workspaceId, current);
    setSaving(false);
    if (!res.success) return setServerError(res.error);
    toast.success(current.id ? 'Policy saved. Open tickets were re-timed.' : 'Policy created.');
    onSaved(res.policy);
  }

  return (
    <Modal
      title={`${current.id ? 'Edit' : 'New'} SLA policy`}
      description="Targets are per priority. Leave a target empty to not track it."
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
            Save policy
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <Field label="Name" error={shown.name}>
          <Input inputSize="md" value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} data-autofocus />
        </Field>
        <Field label="Description (optional)" hint="Shown in the list so teammates know why this policy exists.">
          <Textarea rows={2} value={draft.description} maxLength={500} onChange={(e) => set({ description: e.target.value })} />
        </Field>

        <section aria-labelledby="sla-applies" className="space-y-3">
          <div>
            <h3 id="sla-applies" className="text-md font-semibold text-ink">
              Applies to
            </h3>
            <p className="text-ui text-ink-2">Leave everything empty to cover every ticket not matched by a policy above this one. When you set several, a ticket has to meet all of them.</p>
          </div>
          <ChipGroup<string>
            label="Channel (any of)"
            options={TICKET_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
            value={draft.conditions.channels ?? []}
            onChange={(channels) => set({ conditions: { ...draft.conditions, channels } })}
          />
          {groups.length > 0 && (
            <ChipGroup<string>
              label="Group (any of)"
              options={groups.map((g) => ({ value: g.id, label: g.name }))}
              value={draft.conditions.group_ids ?? []}
              onChange={(group_ids) => set({ conditions: { ...draft.conditions, group_ids } })}
            />
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tags (any of)" hint="Comma-separated, for example vip, enterprise.">
              <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="vip, enterprise" />
            </Field>
            <Field label="Requester domains (any of)" hint="For example acme.com.">
              <Input value={domainsText} onChange={(e) => setDomainsText(e.target.value)} placeholder="acme.com" />
            </Field>
          </div>
          <Field label="Requester emails (any of)" hint="Match specific people. A requester matches if their email or their domain is listed." error={shown.conditions}>
            <Input value={emailsText} onChange={(e) => setEmailsText(e.target.value)} placeholder="ceo@acme.com" />
          </Field>
        </section>

        <section aria-labelledby="sla-targets" className="space-y-3">
          <div>
            <h3 id="sla-targets" className="text-md font-semibold text-ink">
              Targets
            </h3>
            <p className="text-ui text-ink-2">The longest the team should take, per priority.</p>
          </div>
          {SLA_PRIORITIES.map((prio) => (
            <fieldset key={prio} className="rounded-lg border border-line p-3">
              <legend className="px-1 text-xs font-semibold text-ink-2">{PRIORITY_LABEL[prio]}</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                {SLA_METRICS.map((metric) => (
                  <DurationField key={metric} label={METRIC_LABEL[metric]} minutes={draft.targets[prio]?.[metric]} onChange={(m) => setTarget(prio, metric, m)} />
                ))}
              </div>
            </fieldset>
          ))}
          {shown.targets && (
            <p role="alert" className="text-2xs font-medium text-danger">
              {shown.targets}
            </p>
          )}
        </section>

        <section aria-labelledby="sla-clock" className="space-y-3">
          <h3 id="sla-clock" className="text-md font-semibold text-ink">
            Clock
          </h3>
          <Tabs
            variant="pill"
            label="What the clock counts"
            value={draft.business_hours ? 'business' : 'calendar'}
            onChange={(v) => set({ business_hours: v === 'business' })}
            items={[
              { id: 'calendar', label: 'Every hour' },
              { id: 'business', label: 'Business hours only' },
            ]}
          />
          <p className="text-ui text-ink-2">
            {draft.business_hours
              ? 'Only your business hours count, in the workspace timezone, and holidays are skipped (Settings → Automation → SLA calendar).'
              : 'Nights, weekends and holidays count too.'}{' '}
            The clock always pauses while a ticket is Pending or On-hold.
          </p>
        </section>

        <section aria-labelledby="sla-alerts" className="space-y-3">
          <h3 id="sla-alerts" className="text-md font-semibold text-ink">
            Alerts
          </h3>
          <Field label="Warn before a breach (minutes)" hint="Counted in the same hours as the targets. 0 turns the early warning off." error={shown.alert} className="max-w-xs">
            <Input type="number" min={0} max={1440} value={String(draft.alert_before_minutes)} onChange={(e) => set({ alert_before_minutes: Number(e.target.value) })} />
          </Field>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="inline-flex items-center gap-2 text-ui text-ink min-h-9">
              <input type="checkbox" className="w-4 h-4 accent-[var(--ds-accent)]" checked={draft.notify_assignee} onChange={(e) => set({ notify_assignee: e.target.checked })} />
              Email the assignee
            </label>
            <label className="inline-flex items-center gap-2 text-ui text-ink min-h-9">
              <input type="checkbox" className="w-4 h-4 accent-[var(--ds-accent)]" checked={draft.notify_group} onChange={(e) => set({ notify_group: e.target.checked })} />
              Email the ticket&apos;s group
            </label>
          </div>
        </section>

        <section aria-labelledby="sla-summary" className="rounded-lg border border-line bg-surface-2 p-4">
          <h3 id="sla-summary" className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-2">
            In plain language
          </h3>
          <ul className="space-y-1 text-ui text-ink-2" aria-live="polite">
            {summarizePolicy(current, lookups).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}
