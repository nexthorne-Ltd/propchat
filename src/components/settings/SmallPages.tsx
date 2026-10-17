'use client';

import React, { useState } from 'react';
import { ArrowRight, Check, Minus } from 'lucide-react';
import type { Agent, Workspace } from '@/types/database';
import { createClient } from '@/lib/supabase/client';
import { CAPABILITIES, ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, roleCan, type Capability } from '@/lib/team/permissions';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { SaveBar, SettingsCard, useReportDirty } from './parts';
import { WorkspaceBillingView } from './WorkspaceBillingView';
import { errorMessage } from '@/lib/errors/user-error';

/** A page whose real settings live on another screen: explain, then link. */
export function LinkCard({ title, description, actionLabel, onClick }: { title: string; description: string; actionLabel: string; onClick: () => void }) {
  return (
    <SettingsCard title={title} description={description}>
      <Button variant="primary" size="sm" onClick={onClick}>
        {actionLabel} <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
      </Button>
    </SettingsCard>
  );
}

const CAPABILITY_LABELS: Record<Capability, string> = {
  view: 'View tickets and conversations',
  add_note: 'Add internal notes',
  reply: 'Reply to customers',
  edit_ticket: 'Change status, priority, assignee and tags',
  edit_content: 'Edit help center articles and saved replies',
  manage_groups: 'Manage groups',
  manage_team: 'Invite people and change roles',
  manage_settings: 'Change workspace settings',
};

/** Settings → Team → Roles: read-only view of the same matrix the database enforces. */
export function RolesMatrix() {
  return (
    <div className="space-y-6">
      <SettingsCard title="What each role can do" description="Roles are set on the Members tab. These rules are fixed and enforced by the database.">
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-ui min-w-[32rem]">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wider text-ink-3">
                <th className="py-2 pr-4 font-medium">Capability</th>
                {ROLES.map((r) => (
                  <th key={r} className="py-2 px-2 font-medium text-center">
                    {ROLE_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPABILITIES.map((c) => (
                <tr key={c} className="border-t border-line">
                  <th scope="row" className="py-2.5 pr-4 text-left font-normal text-ink">
                    {CAPABILITY_LABELS[c]}
                  </th>
                  {ROLES.map((r) => (
                    <td key={r} className="py-2.5 px-2 text-center">
                      {roleCan(r, c) ? (
                        <>
                          <Check className="w-4 h-4 text-success inline" aria-hidden="true" />
                          <span className="sr-only">Allowed</span>
                        </>
                      ) : (
                        <>
                          <Minus className="w-4 h-4 text-ink-3 inline" aria-hidden="true" />
                          <span className="sr-only">Not allowed</span>
                        </>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsCard>
      <ul className="grid gap-3 sm:grid-cols-2">
        {ROLES.map((r) => (
          <li key={r} className="card p-4">
            <div className="text-ui font-semibold text-ink">{ROLE_LABELS[r]}</div>
            <p className="text-xs text-ink-2 mt-1">{ROLE_DESCRIPTIONS[r]}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Settings → Billing. Plan, usage, limits, and coupon redemption. */
export function PlanPanel({ workspace, agents }: { workspace: Workspace; agents: Agent[] }) {
  return <WorkspaceBillingView workspace={workspace} />;
}

/** Auto-close rule: resolve conversations with no activity for N days. */
export function AutoCloseCard({ workspace, onWorkspaceUpdated }: { workspace: Workspace; onWorkspaceUpdated?: (ws: Workspace) => void }) {
  const toast = useToast();
  const savedDays = workspace.auto_close_days ?? 7;
  const [days, setDays] = useState(String(savedDays));
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = Number(days);
  const invalid = !Number.isInteger(n) || n < 1 || n > 365 ? 'Enter a whole number of days from 1 to 365.' : null;
  const dirty = days !== String(savedDays);
  useReportDirty(dirty);
  const [touched, setTouched] = useState(false);

  async function save() {
    setTouched(true);
    if (invalid) return;
    setSaving(true);
    setError(null);
    const { error: err } = await createClient().from('workspaces').update({ auto_close_days: n }).eq('id', workspace.id);
    setSaving(false);
    if (err) return setError(err.message);
    onWorkspaceUpdated?.({ ...workspace, auto_close_days: n });
    setJustSaved(true);
    toast.success('Auto-close rule saved.');
  }

  async function runNow() {
    if (invalid) return setTouched(true);
    setRunning(true);
    try {
      const res = await fetch('/api/conversations/auto-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspace.id, days: n }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Auto-close failed.');
      toast.success(`${data.closed_count} inactive conversation(s) resolved.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsCard title="Auto-close inactive conversations" description="Resolve open conversations with no customer or agent activity for this long.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Days of inactivity" error={touched ? invalid : null} className="w-44">
            <Input
              inputSize="md"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => {
                setDays(e.target.value);
                setJustSaved(false);
              }}
              onBlur={() => setTouched(true)}
            />
          </Field>
          <Button size="md" loading={running} onClick={runNow}>
            Run now
          </Button>
        </div>
      </SettingsCard>
      <SaveBar dirty={dirty} saving={saving} saved={justSaved} error={error} onSave={save} onDiscard={() => setDays(String(savedDays))} />
    </div>
  );
}
