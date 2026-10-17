'use client';

import React, { useEffect, useState } from 'react';
import { getAutomationBootstrapAction, type AutomationBootstrap } from '@/app/actions/automation';
import { ErrorState } from '@/components/ui/States';
import { FormSkeleton } from '@/components/settings/parts';
import { MacrosPanel } from './MacrosPanel';
import { RuleLogPanel } from './RuleLogPanel';
import { RulesPanel } from './RulesPanel';
import { errorMessage } from '@/lib/errors/user-error';

export type AutomationTab = 'macros' | 'triggers' | 'automations' | 'log';

/** Settings → Automation: macros, triggers, automations and the rule log (owners and admins). */
export function AutomationPage({ workspaceId, tab }: { workspaceId: string; tab: AutomationTab; onNavigate?: (view: string) => void }) {
  const [data, setData] = useState<AutomationBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (tab === 'log') return;
    let live = true;
    getAutomationBootstrapAction(workspaceId, tab === 'macros' ? 'macros' : 'rules')
      .then((res) => {
        if (!live) return;
        if (!res.success) return setError(res.error);
        setData(res.data);
      })
      .catch((e) => live && setError(errorMessage(e) || 'Could not load automation settings.'));
    return () => {
      live = false;
    };
  }, [workspaceId, attempt, tab]);

  if (tab === 'log') return <RuleLogPanel workspaceId={workspaceId} />;

  if (error) {
    return (
      <ErrorState
        title="Could not load automation settings"
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

  const lookups = { groups: data.groups, people: data.people };
  const reload = () => {
    setData(null);
    setAttempt((n) => n + 1);
  };

  if (tab === 'macros') {
    return <MacrosPanel workspaceId={workspaceId} macros={data.macros} lookups={lookups} meId={data.me} canShare={data.canShare} onChange={(macros) => setData({ ...data, macros })} />;
  }
  return (
    <RulesPanel
      workspaceId={workspaceId}
      kind={tab === 'triggers' ? 'trigger' : 'automation'}
      rules={data.rules}
      lookups={lookups}
      onChange={(rules) => setData({ ...data, rules })}
      onReload={reload}
    />
  );
}
