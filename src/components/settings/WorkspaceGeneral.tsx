'use client';

import React, { useId, useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import type { Workspace } from '@/types/database';
import { updateWorkspaceGeneralAction } from '@/app/actions/settings';
import { Field, Input, Select } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { LANGUAGES, NAME_MAX, validateWorkspaceGeneral, type WorkspaceGeneralInput } from '@/lib/settings/validation';
import { SaveBar, SettingsCard, useReportDirty } from './parts';
import { errorMessage } from '@/lib/errors/user-error';

function initialValues(ws: Workspace): WorkspaceGeneralInput {
  return {
    name: ws.name || '',
    logo_url: ws.logo_url || '',
    timezone: ws.timezone || ws.business_hours?.timezone || 'UTC',
    language: ws.language || 'en',
  };
}

function allTimezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

/** Settings → Workspace → General. Owners and admins. */
export function WorkspaceGeneral({
  workspace,
  onWorkspaceUpdated,
}: {
  workspace: Workspace;
  onWorkspaceUpdated?: (ws: Workspace) => void;
}) {
  const toast = useToast();
  const saved = useMemo(() => initialValues(workspace), [workspace]);
  const [values, setValues] = useState<WorkspaceGeneralInput>(saved);
  const [touched, setTouched] = useState<Partial<Record<keyof WorkspaceGeneralInput, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const zoneListId = useId();
  const zones = useMemo(() => allTimezones(), []);

  const dirty = (Object.keys(saved) as (keyof WorkspaceGeneralInput)[]).some((k) => saved[k] !== values[k]);
  useReportDirty(dirty);

  const errors = validateWorkspaceGeneral(values);
  const shown = (k: keyof WorkspaceGeneralInput) => (touched[k] ? errors[k] : undefined);
  const set = (k: keyof WorkspaceGeneralInput, v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    setJustSaved(false);
    setServerError(null);
  };
  const blur = (k: keyof WorkspaceGeneralInput) => setTouched((t) => ({ ...t, [k]: true }));

  async function save() {
    setTouched({ name: true, logo_url: true, timezone: true, language: true });
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setServerError(null);
    try {
      const res = await updateWorkspaceGeneralAction(workspace.id, values);
      if (!res.success) {
        setServerError(res.error);
        return;
      }
      onWorkspaceUpdated?.(res.workspace);
      setJustSaved(true);
      toast.success('Workspace settings saved.');
    } catch (e) {
      setServerError(errorMessage(e) || 'Could not save. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body });
      const data = await res.json();
      if (!data.url) throw new Error(data.error || 'Upload failed.');
      set('logo_url', data.url);
      blur('logo_url');
    } catch (err) {
      toast.error(errorMessage(err) || 'Could not upload the logo. Try a smaller image.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="space-y-6">
      <SettingsCard title="Identity" description="Shown in the agent app and used as the default for your widget and emails.">
        <Field label="Workspace name" error={shown('name')} hint={`${values.name.trim().length}/${NAME_MAX}`}>
          <Input
            inputSize="md"
            value={values.name}
            maxLength={NAME_MAX + 20}
            onChange={(e) => set('name', e.target.value)}
            onBlur={() => blur('name')}
            autoComplete="organization"
          />
        </Field>

        <div className="flex flex-wrap items-end gap-4">
          <div className="w-14 h-14 rounded-lg bg-surface-2 border border-line flex items-center justify-center overflow-hidden shrink-0">
            {values.logo_url && !errors.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={values.logo_url} alt="Workspace logo preview" className="w-full h-full object-cover" />
            ) : (
              <span className="text-md font-semibold text-accent" aria-hidden="true">
                {(values.name || 'W').charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <Field label="Logo link" error={shown('logo_url')} hint="Square images work best." className="flex-1 min-w-[14rem]">
            <Input
              inputSize="md"
              value={values.logo_url}
              placeholder="https://…"
              onChange={(e) => set('logo_url', e.target.value)}
              onBlur={() => blur('logo_url')}
              inputMode="url"
            />
          </Field>
          <input ref={fileRef} type="file" accept="image/*" className="sr-only" onChange={upload} aria-label="Upload logo" />
          <Button size="md" loading={uploading} onClick={() => fileRef.current?.click()}>
            <Upload className="w-4 h-4" aria-hidden="true" /> Upload
          </Button>
          {values.logo_url && (
            <Button variant="ghost" size="md" onClick={() => set('logo_url', '')}>
              Remove
            </Button>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title="Region" description="Used for timestamps in reports and as the default for business hours.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Timezone" error={shown('timezone')} hint="For example Asia/Karachi or Europe/London.">
            <Input
              inputSize="md"
              list={zoneListId}
              value={values.timezone}
              onChange={(e) => set('timezone', e.target.value)}
              onBlur={() => blur('timezone')}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <datalist id={zoneListId}>
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <Field label="Language" error={shown('language')} hint="The default language of the widget and help center.">
            <Select inputSize="md" value={values.language} onChange={(e) => set('language', e.target.value)} onBlur={() => blur('language')}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </SettingsCard>

      <SaveBar
        dirty={dirty}
        saving={saving}
        saved={justSaved}
        error={serverError}
        onSave={save}
        onDiscard={() => {
          setValues(saved);
          setTouched({});
          setServerError(null);
        }}
      />
    </div>
  );
}
