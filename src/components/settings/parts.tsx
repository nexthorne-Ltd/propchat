'use client';

import React, { createContext, useContext, useEffect } from 'react';
import { CheckCircle2, Clock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';

/**
 * Pieces every settings page shares: a card, the save bar, the "coming soon"
 * state, and the channel that lets a page tell the hub it has unsaved edits
 * (the hub warns before leaving, switching pages or closing the tab).
 */

const DirtyContext = createContext<(dirty: boolean) => void>(() => {});
export const DirtyProvider = DirtyContext.Provider;

/** Call with `true` while the page has edits that are not saved yet. */
export function useReportDirty(dirty: boolean) {
  const report = useContext(DirtyContext);
  useEffect(() => {
    report(dirty);
    return () => report(false);
  }, [dirty, report]);
}

import { ManagedByZentry } from '@/components/ui/ManagedByZentry';

export function SettingsCard({
  title,
  description,
  children,
  className,
  isLocked,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  isLocked?: boolean;
}) {
  return (
    <section className={cn('card p-5 md:p-6 space-y-4 relative', className)}>
      {(title || description || isLocked) && (
        <header className="flex items-start justify-between gap-4">
          <div>
            {title && <h3 className="text-md font-semibold text-ink">{title}</h3>}
            {description && <p className="mt-0.5 text-ui text-ink-2">{description}</p>}
          </div>
          {isLocked && <ManagedByZentry />}
        </header>
      )}
      <div className={cn(isLocked && 'pointer-events-none opacity-80 select-none')}>
        {children}
      </div>
    </section>
  );
}

/** Sticks to the bottom of the page while there is something to save. */
export function SaveBar({
  dirty,
  saving,
  saved,
  error,
  onSave,
  onDiscard,
  disabled,
  saveLabel = 'Save changes',
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  error?: string | null;
  onSave: () => void;
  onDiscard: () => void;
  disabled?: boolean;
  saveLabel?: string;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 md:-mx-8 px-4 md:px-8 py-3 bg-surface border-t border-line flex flex-wrap items-center gap-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="flex-1 min-w-0 text-ui" aria-live="polite">
        {error ? (
          <span role="alert" className="text-danger font-medium">
            {error}
          </span>
        ) : dirty ? (
          <span className="text-ink-2">You have unsaved changes.</span>
        ) : saved ? (
          <span className="inline-flex items-center gap-1.5 text-success font-medium">
            <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Saved
          </span>
        ) : (
          <span className="text-ink-3">All changes saved.</span>
        )}
      </div>
      <Button variant="ghost" size="sm" onClick={onDiscard} disabled={!dirty || saving}>
        Discard
      </Button>
      <Button variant="primary" size="sm" onClick={onSave} loading={saving} disabled={!dirty || disabled}>
        {saveLabel}
      </Button>
    </div>
  );
}

export function ComingSoon({ title, description, bullets }: { title: string; description: string; bullets?: string[] }) {
  return (
    <section className="card p-8 flex flex-col items-center text-center gap-3 max-w-xl mx-auto">
      <div className="w-10 h-10 rounded-xl bg-surface-2 border border-line text-ink-3 flex items-center justify-center">
        <Clock className="w-5 h-5" aria-hidden="true" />
      </div>
      <Badge tone="info">Coming soon</Badge>
      <h3 className="text-md font-semibold text-ink">{title}</h3>
      <p className="text-ui text-ink-2">{description}</p>
      {bullets && bullets.length > 0 && (
        <ul className="text-ui text-ink-2 text-left list-disc pl-5 space-y-1">
          {bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-3">Nothing here is saved or applied yet.</p>
    </section>
  );
}

/** Loading placeholder shaped like a form. */
export function FormSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="card p-6 space-y-5" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton h-9 w-full" />
        </div>
      ))}
    </div>
  );
}
