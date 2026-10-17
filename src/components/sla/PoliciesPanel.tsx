'use client';

import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { deleteSlaPolicyAction, reorderSlaPoliciesAction, setSlaPolicyActiveAction } from '@/app/actions/sla';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { CHANNEL_LABEL } from '@/lib/tickets/views';
import { blankPolicy, draftFromRow, summarizePolicy, type SlaPolicyDraft, type SlaPolicyRow } from '@/lib/sla/policy';
import { PolicyEditor } from './PolicyEditor';

/** Settings → Automation → SLA policies: ordered, first match wins. */
export function PoliciesPanel({
  workspaceId,
  policies,
  groups,
  calendarOn,
  onChange,
  onReload,
}: {
  workspaceId: string;
  policies: SlaPolicyRow[];
  groups: { id: string; name: string }[];
  /** Business hours are switched on for the workspace. */
  calendarOn: boolean;
  onChange: (next: SlaPolicyRow[]) => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const sorted = [...policies].sort((a, b) => a.position - b.position);
  const [editing, setEditing] = useState<SlaPolicyDraft | null>(null);
  const [deleting, setDeleting] = useState<SlaPolicyRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lookups = { groups: Object.fromEntries(groups.map((g) => [g.id, g.name])), channels: CHANNEL_LABEL as Record<string, string> };
  const usesBusinessHours = sorted.some((p) => p.is_active && p.business_hours);

  const merge = (row: SlaPolicyRow) => onChange(policies.some((p) => p.id === row.id) ? policies.map((p) => (p.id === row.id ? row : p)) : [...policies, row]);

  async function toggle(policy: SlaPolicyRow) {
    setBusy(policy.id);
    const res = await setSlaPolicyActiveAction(workspaceId, policy.id, !policy.is_active);
    setBusy(null);
    if (!res.success) return toast.error(res.error);
    merge(res.policy);
  }

  async function move(index: number, dir: -1 | 1) {
    const order = sorted.map((p) => p.id);
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    // Optimistic: show the new order now, undo it if the save is refused.
    const positions = new Map(order.map((id, i) => [id, i + 1]));
    onChange(policies.map((p) => ({ ...p, position: positions.get(p.id) ?? p.position })));
    const res = await reorderSlaPoliciesAction(workspaceId, order);
    if (!res.success) {
      toast.error(res.error);
      onReload();
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(deleting.id);
    const res = await deleteSlaPolicyAction(workspaceId, deleting.id);
    setBusy(null);
    if (!res.success) return toast.error(res.error);
    onChange(policies.filter((p) => p.id !== deleting.id));
    setDeleting(null);
    toast.success('Policy deleted. Past breach records are kept for reports.');
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 min-w-[16rem] text-ui text-ink-2">
          Each ticket gets the first enabled policy, from the top, whose conditions it meets. Targets depend on the ticket&apos;s priority; when the priority or the matching policy changes, the clocks are recalculated.
        </p>
        <Button variant="primary" size="sm" onClick={() => setEditing(blankPolicy())}>
          <Plus className="w-3.5 h-3.5" /> New policy
        </Button>
      </div>

      {usesBusinessHours && !calendarOn && (
        <p role="status" className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-ui text-warn">
          A policy counts business hours, but business hours are switched off for this workspace, so it currently counts every hour. Turn them on under Settings → Workspace → Business hours.
        </p>
      )}

      {sorted.length === 0 ? (
        <div className="card p-4">
          <EmptyState
            type="custom"
            title="No SLA policies yet"
            description="Set how fast your team should reply and resolve, per priority. You get a badge on every ticket and an email before a target is missed."
            actionLabel="New policy"
            onAction={() => setEditing(blankPolicy())}
          />
        </div>
      ) : (
        <ol className="space-y-3" aria-label="SLA policies in matching order">
          {sorted.map((policy, i) => (
            <li key={policy.id} className="card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-surface-3 text-ink-2 text-2xs font-semibold flex items-center justify-center shrink-0 tabular-nums" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 basis-60">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-md font-semibold text-ink break-words">{policy.name}</h3>
                    <Badge tone={policy.is_active ? 'success' : 'neutral'} dot>
                      {policy.is_active ? 'On' : 'Off'}
                    </Badge>
                    <Badge tone="info">{policy.business_hours ? 'Business hours' : 'Every hour'}</Badge>
                  </div>
                  {policy.description && <p className="text-ui text-ink-2 mt-0.5">{policy.description}</p>}
                  <ul className="mt-2 space-y-1 text-xs text-ink-2">
                    {summarizePolicy(policy, lookups).map((line, n) => (
                      <li key={n}>{line}</li>
                    ))}
                  </ul>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <label className="inline-flex items-center gap-1.5 text-xs text-ink-2 mr-1 min-h-9">
                    <input type="checkbox" className="w-4 h-4 accent-[var(--ds-accent)]" checked={policy.is_active} disabled={busy === policy.id} onChange={() => toggle(policy)} />
                    Enabled
                  </label>
                  <Button iconOnly variant="ghost" size="sm" aria-label={`Move ${policy.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="w-4 h-4" />
                  </Button>
                  <Button iconOnly variant="ghost" size="sm" aria-label={`Move ${policy.name} down`} disabled={i === sorted.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="w-4 h-4" />
                  </Button>
                  <Button iconOnly variant="ghost" size="sm" aria-label={`Edit ${policy.name}`} onClick={() => setEditing(draftFromRow(policy))}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button iconOnly variant="ghost" size="sm" aria-label={`Delete ${policy.name}`} onClick={() => setDeleting(policy)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {editing && (
        <PolicyEditor
          workspaceId={workspaceId}
          initial={editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            merge(row);
            setEditing(null);
          }}
        />
      )}

      {deleting && (
        <Modal
          title={`Delete “${deleting.name}”?`}
          description="Tickets it applied to are re-evaluated against the remaining policies. Met and breached records stay available for reports."
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                Keep it
              </Button>
              <Button variant="danger" loading={busy === deleting.id} onClick={remove}>
                Delete policy
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
