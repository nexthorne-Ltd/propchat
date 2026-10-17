'use client';

import React, { useEffect, useState } from 'react';
import { getSlaBootstrapAction, type SlaBootstrap } from '@/app/actions/sla';
import { ErrorState } from '@/components/ui/States';
import { FormSkeleton } from '@/components/settings/parts';
import { PoliciesPanel } from './PoliciesPanel';
import { CalendarPanel } from './CalendarPanel';
import { errorMessage } from '@/lib/errors/user-error';

export type SlaTab = 'policies' | 'calendar';

/** Settings → Automation → SLA policies / SLA calendar (owners and admins). */
export function SlaPage({ workspaceId, tab }: { workspaceId: string; tab: SlaTab }) {
  const [data, setData] = useState<SlaBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getSlaBootstrapAction(workspaceId)
      .then((res) => {
        if (!live) return;
        if (!res.success) return setError(res.error);
        setData(res.data);
      })
      .catch((e) => live && setError(errorMessage(e) || 'Could not load SLA settings.'));
    return () => {
      live = false;
    };
  }, [workspaceId, attempt]);

  if (error) {
    return (
      <ErrorState
        title="Could not load SLA settings"
        message={error}
        onRetry={() => {
          setError(null);
          setData(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (!data) return <FormSkeleton rows={3} />;

  if (tab === 'calendar') {
    return <CalendarPanel workspaceId={workspaceId} holidays={data.holidays} calendar={data.calendar} onChange={(holidays) => setData({ ...data, holidays })} />;
  }
  return (
    <PoliciesPanel
      workspaceId={workspaceId}
      policies={data.policies}
      groups={data.groups}
      calendarOn={Boolean(data.calendar.hours?.enabled)}
      onChange={(policies) => setData({ ...data, policies })}
      onReload={() => {
        setData(null);
        setAttempt((n) => n + 1);
      }}
    />
  );
}
