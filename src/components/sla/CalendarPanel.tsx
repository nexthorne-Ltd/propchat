'use client';

import React, { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { deleteHolidayAction, saveHolidayAction } from '@/app/actions/sla';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { SettingsCard } from '@/components/settings/parts';
import { holidayError, type Holiday, type HolidayInput } from '@/lib/sla/policy';
import type { BusinessHoursConfig } from '@/types/database';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

function dayLabel(day: string) {
  return day[0].toUpperCase() + day.slice(1);
}

/** "2026-03-20" shown as a date without shifting it through the viewer's timezone. */
function dateText(iso: string, withYear: boolean): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
}

function rangeText(h: Holiday): string {
  const same = h.starts_on === h.ends_on;
  const year = !h.repeats_yearly;
  return same ? dateText(h.starts_on, year) : `${dateText(h.starts_on, year)} – ${dateText(h.ends_on, year)}`;
}

/** Settings → Automation → SLA calendar: the hours (set elsewhere) and the holidays (set here). */
export function CalendarPanel({
  workspaceId,
  holidays,
  calendar,
  onChange,
}: {
  workspaceId: string;
  holidays: Holiday[];
  calendar: { hours: BusinessHoursConfig | null; timezone: string };
  onChange: (next: Holiday[]) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<HolidayInput | null>(null);
  const [deleting, setDeleting] = useState<Holiday | null>(null);
  const [busy, setBusy] = useState(false);
  const hours = calendar.hours;

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    const res = await deleteHolidayAction(workspaceId, deleting.id);
    setBusy(false);
    if (!res.success) return toast.error(res.error);
    onChange(holidays.filter((h) => h.id !== deleting.id));
    setDeleting(null);
    toast.success('Holiday removed. Open tickets were re-timed.');
  }

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Business hours"
        description="Business-hour SLA policies count only these hours, in this timezone. They are the same hours your widget uses to show you as available. Change them under Settings → Workspace → Business hours."
      >
        <p className="text-ui text-ink">
          Timezone: <span className="font-semibold">{calendar.timezone}</span>
        </p>
        {!hours?.enabled ? (
          <p role="status" className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-ui text-warn">
            Business hours are switched off, so business-hour policies count every hour for now.
          </p>
        ) : (
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 text-ui">
            {DAYS.map((day) => {
              const d = hours.schedule?.[day];
              return (
                <div key={day} className="flex items-center justify-between gap-3 border-b border-line py-1.5">
                  <dt className="text-ink-2">{dayLabel(day)}</dt>
                  <dd className="text-ink tabular-nums">{d?.enabled ? `${d.start} – ${d.end}` : 'Closed'}</dd>
                </div>
              );
            })}
          </dl>
        )}
      </SettingsCard>

      <SettingsCard title="Holidays" description="Days your team is closed. The clock does not run on them for business-hour policies.">
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing({ name: '', starts_on: '', ends_on: '', repeats_yearly: false })}>
            <Plus className="w-3.5 h-3.5" /> Add holiday
          </Button>
        </div>
        {holidays.length === 0 ? (
          <EmptyState
            type="custom"
            title="No holidays yet"
            description="Add the days you are closed, such as public holidays, so business-hour targets are not missed while nobody is in."
            actionLabel="Add holiday"
            onAction={() => setEditing({ name: '', starts_on: '', ends_on: '', repeats_yearly: false })}
          />
        ) : (
          <ul className="divide-y divide-line border-y border-line" aria-label="Holidays">
            {holidays.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="text-ui font-semibold text-ink break-words">{h.name}</p>
                  <p className="text-xs text-ink-2">{rangeText(h)}</p>
                </div>
                {h.repeats_yearly && <Badge tone="info">Every year</Badge>}
                <div className="flex items-center gap-1">
                  <Button iconOnly variant="ghost" size="sm" aria-label={`Edit ${h.name}`} onClick={() => setEditing({ ...h })}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button iconOnly variant="ghost" size="sm" aria-label={`Delete ${h.name}`} onClick={() => setDeleting(h)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      {editing && (
        <HolidayEditor
          workspaceId={workspaceId}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(h) => {
            onChange(
              (holidays.some((x) => x.id === h.id) ? holidays.map((x) => (x.id === h.id ? h : x)) : [...holidays, h]).sort((a, b) => a.starts_on.localeCompare(b.starts_on))
            );
            setEditing(null);
          }}
        />
      )}

      {deleting && (
        <Modal
          title={`Remove “${deleting.name}”?`}
          description="Business-hour clocks will count that day again."
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                Keep it
              </Button>
              <Button variant="danger" loading={busy} onClick={remove}>
                Remove holiday
              </Button>
            </>
          }
        >
          <p className="text-ui text-ink-2">Open tickets are re-timed straight away.</p>
        </Modal>
      )}
    </div>
  );
}

function HolidayEditor({
  workspaceId,
  initial,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  initial: HolidayInput;
  onClose: () => void;
  onSaved: (holiday: Holiday) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<HolidayInput>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const problem = holidayError(draft);
  const set = (patch: Partial<HolidayInput>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setServerError(null);
  };

  async function save() {
    setShowErrors(true);
    if (problem) return;
    setSaving(true);
    const res = await saveHolidayAction(workspaceId, draft);
    setSaving(false);
    if (!res.success) return setServerError(res.error);
    toast.success(draft.id ? 'Holiday saved. Open tickets were re-timed.' : 'Holiday added. Open tickets were re-timed.');
    onSaved(res.holiday);
  }

  return (
    <Modal
      title={draft.id ? 'Edit holiday' : 'Add holiday'}
      size="md"
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
            Save holiday
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" error={showErrors && problem && /name/i.test(problem) ? problem : undefined}>
          <Input inputSize="md" value={draft.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} data-autofocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First day closed">
            <Input type="date" value={draft.starts_on} onChange={(e) => set({ starts_on: e.target.value, ends_on: draft.ends_on && draft.ends_on >= e.target.value ? draft.ends_on : e.target.value })} />
          </Field>
          <Field label="Last day closed">
            <Input type="date" min={draft.starts_on || undefined} value={draft.ends_on} onChange={(e) => set({ ends_on: e.target.value })} />
          </Field>
        </div>
        <label className="inline-flex items-center gap-2 text-ui text-ink min-h-9">
          <input type="checkbox" className="w-4 h-4 accent-[var(--ds-accent)]" checked={draft.repeats_yearly} onChange={(e) => set({ repeats_yearly: e.target.checked })} />
          Repeats every year on these dates
        </label>
        {showErrors && problem && !/name/i.test(problem) && (
          <p role="alert" className="text-2xs font-medium text-danger">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}
