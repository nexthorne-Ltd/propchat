'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input, Select, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { SettingsCard } from './parts';
import { TICKET_FIELD_TYPES, validateFieldDefinition, type TicketField, type TicketFieldType } from '@/lib/tickets/fields';
import { deleteTicketFieldAction, listTicketFieldsAction, reorderTicketFieldsAction, saveTicketFieldAction } from '@/app/actions/ticket-fields';
import { errorMessage } from '@/lib/errors/user-error';

interface Draft {
  id: string | null;
  label: string;
  type: TicketFieldType;
  optionsText: string;
  description: string;
  required: boolean;
  is_active: boolean;
}

const EMPTY: Draft = { id: null, label: '', type: 'text', optionsText: '', description: '', required: false, is_active: true };

/**
 * Settings → Tickets → Ticket fields: your own fields (order number, plan,
 * product…) shown on every ticket. A field's type cannot change once tickets
 * may hold values for it; turn it off instead.
 */
export function TicketFieldsSettings({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [fields, setFields] = useState<TicketField[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<TicketField | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFields(await listTicketFieldsAction(workspaceId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    let alive = true;
    listTicketFieldsAction(workspaceId)
      .then((f) => alive && setFields(f))
      .catch((e: Error) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  async function save() {
    if (!draft) return;
    const options = draft.optionsText.split('\n');
    const problem = validateFieldDefinition({ label: draft.label, type: draft.type, options });
    if (problem) return setFormError(problem);
    setBusy(true);
    setFormError(null);
    try {
      const saved = await saveTicketFieldAction(workspaceId, {
        id: draft.id,
        label: draft.label,
        type: draft.type,
        options,
        description: draft.description,
        required: draft.required,
        is_active: draft.is_active,
      });
      setFields((all) => (draft.id ? (all || []).map((f) => (f.id === saved.id ? saved : f)) : [...(all || []), saved]));
      toast.success(draft.id ? 'Field saved.' : 'Field added to every ticket.');
      setDraft(null);
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, dir: -1 | 1) {
    if (!fields) return;
    const next = [...fields];
    const [item] = next.splice(index, 1);
    next.splice(index + dir, 0, item);
    setFields(next);
    try {
      await reorderTicketFieldsAction(workspaceId, next.map((f) => f.id));
    } catch (e) {
      toast.error(errorMessage(e));
      await load();
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await deleteTicketFieldAction(workspaceId, deleting.id);
      setFields((all) => (all || []).filter((f) => f.id !== deleting.id));
      toast.success('Field deleted.');
      setDeleting(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard title="Ticket fields" description="Add your own fields, such as order number or plan, to every ticket. Agents fill them in on the ticket.">
      {error && !fields && <ErrorState title="Could not load ticket fields" message={error} onRetry={() => void load()} />}
      {!fields && !error && <div className="skeleton h-24 rounded-xl" role="status" aria-label="Loading ticket fields" />}

      {fields && fields.length === 0 && (
        <EmptyState
          type="custom"
          title="No custom fields yet"
          description="For example: Order number (text), Plan (dropdown), Refund approved (checkbox)."
          actionLabel="Add field"
          onAction={() => setDraft({ ...EMPTY })}
        />
      )}

      {fields && fields.length > 0 && (
        <div className="space-y-3">
          <ul className="divide-y divide-line border border-line rounded-xl overflow-hidden" aria-label="Ticket fields">
            {fields.map((f, i) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-3 bg-surface">
                <div className="flex flex-col">
                  <button type="button" className="btn btn-ghost btn-icon h-5 w-6" disabled={i === 0} onClick={() => void move(i, -1)} aria-label={`Move ${f.label} up`}>
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon h-5 w-6"
                    disabled={i === fields.length - 1}
                    onClick={() => void move(i, 1)}
                    aria-label={`Move ${f.label} down`}
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ui font-semibold text-ink">{f.label}</span>
                    <Badge tone="neutral">{TICKET_FIELD_TYPES.find((t) => t.id === f.type)?.label}</Badge>
                    {f.required && <Badge tone="info">Required</Badge>}
                    {!f.is_active && <Badge tone="warn">Hidden</Badge>}
                  </div>
                  <div className="text-xs text-ink-3 mt-0.5 truncate">
                    <code className="font-mono">{f.key}</code>
                    {f.type === 'dropdown' ? ` · ${f.options.join(', ')}` : ''}
                    {f.description ? ` · ${f.description}` : ''}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setFormError(null);
                    setDraft({ id: f.id, label: f.label, type: f.type, optionsText: f.options.join('\n'), description: f.description, required: f.required, is_active: f.is_active });
                  }}
                  aria-label={`Edit ${f.label}`}
                >
                  <Pencil className="w-3.5 h-3.5" aria-hidden="true" /> Edit
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setDeleting(f)} aria-label={`Delete ${f.label}`}>
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" onClick={() => setDraft({ ...EMPTY })}>
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Add field
          </Button>
        </div>
      )}

      <Modal
        open={draft !== null}
        title={draft?.id ? 'Edit field' : 'Add a ticket field'}
        onClose={() => (busy ? undefined : setDraft(null))}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={busy} onClick={() => void save()}>
              {draft?.id ? 'Save' : 'Add field'}
            </Button>
          </>
        }
      >
        {draft && (
          <>
            <Field label="Name" error={formError}>
              <Input value={draft.label} maxLength={60} autoFocus placeholder="Order number" onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </Field>
            <Field label="Type" hint={draft.id ? 'The type cannot change once the field exists.' : undefined}>
              <Select value={draft.type} disabled={Boolean(draft.id)} onChange={(e) => setDraft({ ...draft, type: e.target.value as TicketFieldType })}>
                {TICKET_FIELD_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            {draft.type === 'dropdown' && (
              <Field label="Options" hint="One per line.">
                <Textarea rows={5} value={draft.optionsText} onChange={(e) => setDraft({ ...draft, optionsText: e.target.value })} placeholder={'Basic\nPro\nEnterprise'} />
              </Field>
            )}
            <Field label="Help text" hint="Optional. Shown under the field on the ticket.">
              <Input value={draft.description} maxLength={200} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-ui text-ink">
              <input type="checkbox" className="accent-[var(--ds-accent)]" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} />
              Agents should fill this in (shown as required)
            </label>
            <label className="flex items-center gap-2 text-ui text-ink">
              <input type="checkbox" className="accent-[var(--ds-accent)]" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} />
              Show on tickets
            </label>
          </>
        )}
      </Modal>

      <Modal
        open={deleting !== null}
        size="sm"
        title={`Delete “${deleting?.label ?? ''}”?`}
        description="The field disappears from every ticket. Values already saved stay in the ticket data but are no longer shown."
        onClose={() => (busy ? undefined : setDeleting(null))}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={busy} onClick={() => void remove()}>
              Delete field
            </Button>
          </>
        }
      >
        <p className="text-ui text-ink-2 flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-ink-3" aria-hidden="true" /> To keep the data but stop asking, edit the field and untick “Show on tickets”.
        </p>
      </Modal>
    </SettingsCard>
  );
}
