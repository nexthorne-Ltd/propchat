'use client';

import React, { useMemo, useState } from 'react';
import { Field, Input, Select, Textarea } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils';
import type { Workspace } from '@/types/database';
import { SaveBar, SettingsCard, useReportDirty } from './parts';
import { updatePrechatAction } from '@/app/actions/admin';
import { normalizePrechat, prechatAsksNothing, type PrechatConfig, type PrechatFieldMode } from '@/lib/widget/prechat';
import { errorMessage } from '@/lib/errors/user-error';

const MODES: { id: PrechatFieldMode; label: string }[] = [
  { id: 'off', label: "Don't ask" },
  { id: 'optional', label: 'Optional' },
  { id: 'required', label: 'Required' },
];

/**
 * Settings → Chat widget → Pre-chat form: what the widget asks before the
 * first message. A topic is added to the ticket as a tag, so triggers can
 * send it to the right group.
 */
export function PrechatSettings({ workspace, onWorkspaceUpdated }: { workspace: Workspace; onWorkspaceUpdated?: (w: Workspace) => void }) {
  const toast = useToast();
  const saved = useMemo(() => normalizePrechat((workspace.navbar_trigger_config as { prechat?: unknown } | null)?.prechat), [workspace]);
  const [c, setC] = useState<PrechatConfig>(saved);
  const [topicsText, setTopicsText] = useState(saved.topics.join('\n'));
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = useMemo(() => normalizePrechat({ ...c, topics: topicsText.split('\n') }), [c, topicsText]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useReportDirty(dirty);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await updatePrechatAction(workspace.id, draft);
      onWorkspaceUpdated?.(res.workspace);
      setC(res.prechat);
      setTopicsText(res.prechat.topics.join('\n'));
      setJustSaved(true);
      toast.success('Pre-chat form saved. The widget uses it on the next page load.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const modeField = (label: string, value: PrechatFieldMode, onChange: (m: PrechatFieldMode) => void) => (
    <Field label={label}>
      <Select value={value} disabled={!c.enabled} onChange={(e) => onChange(e.target.value as PrechatFieldMode)}>
        {MODES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <SettingsCard title="Pre-chat form" description="Ask visitors who they are and what they need before the chat starts.">
          <label className="flex items-center gap-2 text-ui text-ink">
            <input
              type="checkbox"
              className="accent-[var(--ds-accent)]"
              checked={c.enabled}
              onChange={(e) => {
                setC({ ...c, enabled: e.target.checked });
                setJustSaved(false);
              }}
            />
            Show a form before the first message
          </label>

          <div className={cn('space-y-4 mt-4', !c.enabled && 'opacity-60')}>
            <Field label="Heading">
              <Input value={c.title} maxLength={80} disabled={!c.enabled} onChange={(e) => setC({ ...c, title: e.target.value })} />
            </Field>
            <Field label="Message">
              <Textarea rows={2} value={c.intro} maxLength={240} disabled={!c.enabled} onChange={(e) => setC({ ...c, intro: e.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              {modeField('Name', c.name, (m) => setC({ ...c, name: m }))}
              {modeField('Email', c.email, (m) => setC({ ...c, email: m }))}
            </div>
            <Field label="Topics" hint="One per line, up to 12 (for example Billing, Technical, Sales). Leave empty to not ask. The chosen topic is added to the ticket as a tag.">
              <Textarea rows={4} value={topicsText} disabled={!c.enabled} placeholder={'Billing\nTechnical support\nSales'} onChange={(e) => setTopicsText(e.target.value)} />
            </Field>
            {draft.topics.length > 0 && (
              <label className="flex items-center gap-2 text-ui text-ink">
                <input
                  type="checkbox"
                  className="accent-[var(--ds-accent)]"
                  checked={c.topic_required}
                  disabled={!c.enabled}
                  onChange={(e) => setC({ ...c, topic_required: e.target.checked })}
                />
                A topic is required
              </label>
            )}
            {c.enabled && prechatAsksNothing(draft) && (
              <p className="text-xs text-warn">Nothing is asked, so visitors will go straight to the chat.</p>
            )}
            {c.email !== 'required' && c.enabled && (
              <p className="text-xs text-ink-3">Without an email, you cannot reply to visitors who leave before you answer.</p>
            )}
          </div>
        </SettingsCard>

        <div aria-label="Preview" className="rounded-2xl border border-line bg-canvas p-4 h-fit">
          <div className="text-2xs font-semibold uppercase tracking-wide text-ink-3 mb-3">Preview</div>
          {!draft.enabled || prechatAsksNothing(draft) ? (
            <p className="text-ui text-ink-2">Visitors go straight to the message box.</p>
          ) : (
            <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
              <div className="text-md font-semibold text-ink">{draft.title}</div>
              <p className="text-xs text-ink-2">{draft.intro}</p>
              {draft.name !== 'off' && <PreviewInput label="Your name" mode={draft.name} />}
              {draft.email !== 'off' && <PreviewInput label="Email address" mode={draft.email} />}
              {draft.topics.length > 0 && <PreviewInput label="What is it about?" mode={draft.topic_required ? 'required' : 'optional'} select={draft.topics} />}
              <div className="h-9 rounded-lg bg-accent text-accent-ink text-ui font-semibold grid place-items-center">Start conversation</div>
            </div>
          )}
        </div>
      </div>

      <SaveBar
        dirty={dirty}
        saving={saving}
        saved={justSaved && !dirty}
        error={error}
        onSave={() => void save()}
        onDiscard={() => {
          setC(saved);
          setTopicsText(saved.topics.join('\n'));
          setError(null);
        }}
      />
    </div>
  );
}

function PreviewInput({ label, mode, select }: { label: string; mode: PrechatFieldMode; select?: string[] }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-ink-2">
        {label} {mode === 'required' ? <span className="text-danger">*</span> : <span className="text-ink-3">(Optional)</span>}
      </div>
      <div className="h-8 rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink-3 flex items-center">{select ? `${select[0]}…` : ''}</div>
    </div>
  );
}
