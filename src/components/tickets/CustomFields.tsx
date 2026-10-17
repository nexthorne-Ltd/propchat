'use client';

import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { inputClass } from './TicketBits';
import { listTicketFieldsAction, setTicketFieldValuesAction } from '@/app/actions/ticket-fields';
import type { TicketField, TicketFieldValue } from '@/lib/tickets/fields';
import { errorMessage } from '@/lib/errors/user-error';

/**
 * The ticket sidebar's "Fields" section: the workspace's custom fields
 * (Settings → Tickets → Ticket fields). Each value saves on its own when the
 * agent leaves the input or picks an option.
 */
export function TicketCustomFields({
  workspaceId,
  ticketId,
  values,
  disabled,
}: {
  workspaceId: string;
  ticketId: string;
  values: Record<string, TicketFieldValue> | null | undefined;
  disabled: boolean;
}) {
  const [fields, setFields] = useState<TicketField[] | null>(null);
  const [current, setCurrent] = useState<Record<string, TicketFieldValue>>(values || {});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seenTicket, setSeenTicket] = useState(ticketId);

  // Another ticket opened: start from its values (adjusted during render).
  if (seenTicket !== ticketId) {
    setSeenTicket(ticketId);
    setCurrent(values || {});
    setError(null);
  }

  useEffect(() => {
    let alive = true;
    listTicketFieldsAction(workspaceId)
      .then((f) => alive && setFields(f.filter((x) => x.is_active)))
      .catch(() => alive && setFields([]));
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  if (!fields || fields.length === 0) return null;

  async function save(key: string, value: TicketFieldValue | string) {
    setSaving(key);
    setError(null);
    try {
      setCurrent(await setTicketFieldValuesAction(workspaceId, ticketId, { [key]: value }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="p-4 border-t border-line space-y-3" aria-label="Ticket fields">
      <h3 className="text-2xs font-bold uppercase tracking-wide text-ink-3">Fields</h3>
      {fields.map((f) => {
        const v = current[f.key];
        const id = `tf-${f.key}`;
        const missing = f.required && (v === undefined || v === null || v === '');
        return (
          <div key={f.id} className="space-y-1">
            <label htmlFor={id} className="text-xs text-ink-3 flex items-center gap-1">
              {f.label}
              {f.required && <span className={cn(missing ? 'text-danger' : 'text-ink-3')}>*</span>}
              {saving === f.key && <span className="ml-auto text-2xs text-ink-3">Saving…</span>}
            </label>
            {f.type === 'checkbox' ? (
              <input
                id={id}
                type="checkbox"
                className="accent-[var(--ds-accent)]"
                checked={v === true}
                disabled={disabled}
                onChange={(e) => void save(f.key, e.target.checked)}
              />
            ) : f.type === 'dropdown' ? (
              <select
                id={id}
                className={cn(inputClass, 'select h-8 text-xs')}
                value={typeof v === 'string' ? v : ''}
                disabled={disabled}
                onChange={(e) => void save(f.key, e.target.value)}
              >
                <option value="">—</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                key={`${ticketId}:${f.key}:${String(v ?? '')}`}
                type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                className={cn(inputClass, 'h-8 text-xs')}
                defaultValue={v === null || v === undefined ? '' : String(v)}
                disabled={disabled}
                maxLength={f.type === 'text' ? 500 : undefined}
                onBlur={(e) => {
                  if (e.target.value !== (v === null || v === undefined ? '' : String(v))) void save(f.key, e.target.value);
                }}
              />
            )}
            {f.description && <p className="text-2xs text-ink-3">{f.description}</p>}
          </div>
        );
      })}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
