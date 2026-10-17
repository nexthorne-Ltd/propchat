'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Zap, X } from 'lucide-react';
import { listMacrosAction, renderMacroAction, type MacroRow } from '@/app/actions/automation';
import { describeAction } from '@/lib/automation/rules';
import { filterMacros, slashQuery } from '@/lib/automation/macro-search';
import { cn } from '@/lib/utils';

export interface PendingMacro {
  id: string;
  title: string;
  actions: MacroRow['actions'];
}

/**
 * Typing "/" in the reply box lists macros; Enter or a click fills the reply
 * (placeholders already resolved by the database) and remembers the macro's
 * field changes, which the composer applies once the reply is sent.
 */
export function useMacroSlash({
  workspaceId,
  ticketId,
  body,
  setBody,
  enabled,
  canChangeFields,
}: {
  workspaceId: string;
  ticketId: string;
  body: string;
  setBody: (next: string) => void;
  enabled: boolean;
  canChangeFields: boolean;
}) {
  const [macros, setMacros] = useState<MacroRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingMacro | null>(null);

  const slash = enabled ? slashQuery(body) : null;
  const open = Boolean(slash) && dismissed !== body;

  useEffect(() => {
    if (!slash || macros || loadError) return;
    let live = true;
    listMacrosAction(workspaceId).then((res) => {
      if (!live) return;
      if (res.success) setMacros(res.macros);
      else setLoadError(res.error);
    });
    return () => {
      live = false;
    };
  }, [slash, macros, loadError, workspaceId]);

  const results = useMemo(() => (macros && slash ? filterMacros(macros, slash.query) : []), [macros, slash]);
  const safeActive = Math.min(active, Math.max(0, results.length - 1));

  const choose = useCallback(
    async (macro: MacroRow) => {
      if (!slash) return;
      setBusy(true);
      const res = await renderMacroAction(workspaceId, ticketId, macro.id);
      setBusy(false);
      if (!res.success) return setLoadError(res.error);
      setBody(body.slice(0, slash.start) + res.text);
      setPending(canChangeFields && macro.actions.length > 0 ? { id: macro.id, title: macro.title, actions: macro.actions } : null);
      setActive(0);
    },
    [slash, workspaceId, ticketId, body, setBody, canChangeFields]
  );

  /** Returns true when the key was used by the menu (so the textarea should ignore it). */
  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (results.length === 0) return false;
      setActive((safeActive + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
      if (results.length === 0) return false;
      choose(results[safeActive]);
    } else if (e.key === 'Escape') {
      setDismissed(body);
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  };

  const listId = `macro-list-${ticketId}`;

  const menu = open ? (
    <div className="absolute bottom-full left-0 right-0 mb-1 popover rounded-lg shadow-lg overflow-hidden z-[var(--ds-z-popover)]">
      <div className="px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-3 border-b border-line">Macros</div>
      {loadError ? (
        <p role="alert" className="px-3 py-3 text-ui text-danger">
          {loadError}
        </p>
      ) : !macros ? (
        <p role="status" className="px-3 py-3 text-ui text-ink-3">
          Loading macros…
        </p>
      ) : results.length === 0 ? (
        <p role="status" className="px-3 py-3 text-ui text-ink-3">
          {macros.length === 0 ? 'No macros yet. Create one in Settings → Automation → Macros.' : 'No macro matches.'}
        </p>
      ) : (
        <ul id={listId} role="listbox" aria-label="Macros" className="max-h-64 overflow-y-auto py-1">
          {results.map((m, i) => (
            <li key={m.id} id={`${listId}-${m.id}`} role="option" aria-selected={i === safeActive}>
              <button
                type="button"
                tabIndex={-1}
                disabled={busy}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(m)}
                className={cn('w-full text-left px-3 py-2 flex items-start gap-2.5', i === safeActive ? 'bg-accent-soft' : 'hover:bg-surface-3')}
              >
                <Zap className="w-3.5 h-3.5 mt-1 text-ink-3 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-ui font-medium text-ink truncate">
                    {m.title} <span className="text-2xs text-ink-3 font-normal">{m.owner_id ? 'Personal' : 'Shared'}</span>
                  </span>
                  {m.content && <span className="block text-xs text-ink-3 truncate">{m.content.replace(/\s+/g, ' ')}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : null;

  const chip = pending ? (
    <div className="flex items-center gap-2 mb-2 rounded-md bg-accent-soft border border-accent-line px-2.5 py-1.5 text-xs text-ink">
      <Zap className="w-3.5 h-3.5 text-accent shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <strong className="font-semibold">{pending.title}</strong> will also {pending.actions.map((a) => describeAction(a).toLowerCase()).join(', ')} when you send.
      </span>
      <button type="button" aria-label="Don’t apply the macro’s changes" className="text-ink-3 hover:text-ink p-0.5" onClick={() => setPending(null)}>
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  ) : null;

  return {
    menu,
    chip,
    pending,
    clearPending: () => setPending(null),
    onKeyDown,
    comboProps: open
      ? ({ 'aria-autocomplete': 'list', 'aria-controls': listId, 'aria-expanded': true, 'aria-activedescendant': results[safeActive] ? `${listId}-${results[safeActive].id}` : undefined } as const)
      : {},
  };
}
