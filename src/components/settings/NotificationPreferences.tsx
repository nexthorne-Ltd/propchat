'use client';

import React, { useEffect, useState } from 'react';
import { getNotificationPrefsAction, saveNotificationPrefsAction } from '@/app/actions/settings';
import {
  NOTIFICATION_EVENTS,
  sameNotificationPrefs,
  type NotificationChannel,
  type NotificationEventId,
  type NotificationPrefs,
} from '@/lib/settings/validation';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { FormSkeleton, SaveBar, SettingsCard, useReportDirty } from './parts';
import { errorMessage } from '@/lib/errors/user-error';

/** Settings → Notifications. Per user: everyone with a seat, any role. */
export function NotificationPreferences({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [saved, setSaved] = useState<NotificationPrefs | null>(null);
  const [draft, setDraft] = useState<NotificationPrefs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getNotificationPrefsAction(workspaceId)
      .then((res) => {
        if (!live) return;
        if (!res.success) return setLoadError(res.error);
        setSaved(res.prefs);
        setDraft(res.prefs);
      })
      .catch((e) => live && setLoadError(errorMessage(e) || 'Could not load your preferences.'));
    return () => {
      live = false;
    };
  }, [workspaceId, attempt]);

  const dirty = Boolean(saved && draft && !sameNotificationPrefs(saved, draft));
  useReportDirty(dirty);

  if (loadError) {
    return (
      <ErrorState
        title="Could not load your preferences"
        message={loadError}
        onRetry={() => {
          setLoadError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (!saved || !draft) return <FormSkeleton rows={4} />;

  const toggle = (channel: NotificationChannel, id: NotificationEventId) => {
    setJustSaved(false);
    setSaveError(null);
    setDraft({ ...draft, [channel]: { ...draft[channel], [id]: !draft[channel][id] } });
  };

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveNotificationPrefsAction(workspaceId, draft);
      if (!res.success) return setSaveError(res.error);
      setSaved(res.prefs);
      setDraft(res.prefs);
      setJustSaved(true);
      toast.success('Notification preferences saved.');
    } catch (e) {
      setSaveError(errorMessage(e) || 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Tell me when…"
        description="These choices are yours alone. Teammates keep their own. They are saved to your account now; delivery of agent email alerts is still being rolled out."
      >
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-ui min-w-[28rem]">
            <thead>
              <tr className="text-2xs uppercase tracking-wider text-ink-3 text-left">
                <th className="py-2 pr-4 font-medium">Event</th>
                <th className="py-2 px-3 font-medium text-center w-20">Email</th>
                <th className="py-2 pl-3 font-medium text-center w-20">In-app</th>
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_EVENTS.map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <th scope="row" className="py-3 pr-4 text-left font-normal">
                    <div className="font-medium text-ink">{e.label}</div>
                    <div className="text-xs text-ink-3">{e.description}</div>
                  </th>
                  {(['email', 'in_app'] as const).map((channel) => (
                    <td key={channel} className="py-3 px-3 text-center">
                      <input
                        type="checkbox"
                        className="w-5 h-5 accent-[var(--ds-accent)] align-middle"
                        checked={draft[channel][e.id]}
                        onChange={() => toggle(channel, e.id)}
                        aria-label={`${e.label}: ${channel === 'email' ? 'email' : 'in-app'}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsCard>

      <SaveBar
        dirty={dirty}
        saving={saving}
        saved={justSaved}
        error={saveError}
        onSave={save}
        onDiscard={() => {
          setDraft(saved);
          setSaveError(null);
        }}
      />
    </div>
  );
}
