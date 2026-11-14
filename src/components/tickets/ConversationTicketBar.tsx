'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowUpRight, ChevronDown, Clock, CornerDownRight, Ticket as TicketIcon } from 'lucide-react';
import type { Ticket, TicketPriority, TicketStatus, TicketType } from '@/types/database';
import { createClient } from '@/lib/supabase/client';
import { Menu } from '@/components/ui/Menu';
import { StatusBadge } from '@/components/tickets/TicketBits';
import { SETTABLE_STATUSES, STATUS_LABEL, TICKET_TYPES, TYPE_LABEL } from '@/lib/tickets/views';
import { updateTicketAction } from '@/app/actions/tickets';
import { errorMessage } from '@/lib/errors/user-error';
import { cn } from '@/lib/utils';

/**
 * The ticket behind a chat, shown above the conversation in the inbox.
 *
 * Every conversation has a ticket (the database makes one; see
 * 20261009110000_ticketing.sql): its number, status, priority and type are
 * what reports, SLAs, views and automations use. Agents chatting in the
 * inbox never saw it; now they can read and change it here, and jump to the
 * full ticket. Status, priority and assignee are kept in step with the
 * conversation by the database, so changing them here or in the chat header
 * is the same thing.
 */

type BarTicket = Pick<
  Ticket,
  'id' | 'number' | 'subject' | 'status' | 'priority' | 'type' | 'follow_up_of_id' | 'sla_next_due_at' | 'sla_state'
>;

const COLUMNS = 'id, number, subject, status, priority, type, follow_up_of_id, sla_next_due_at, sla_state';

/** "Due in 23m", "Due in 2h", "Overdue 5m". */
export function slaDueLabel(dueAt: string | null | undefined, now = Date.now()): { text: string; overdue: boolean; soon: boolean } | null {
  if (!dueAt) return null;
  const mins = Math.round((Date.parse(dueAt) - now) / 60000);
  if (!Number.isFinite(mins)) return null;
  const span = (m: number) => (m >= 1440 ? `${Math.round(m / 1440)}d` : m >= 60 ? `${Math.round(m / 60)}h` : `${Math.max(1, m)}m`);
  if (mins < 0) return { text: `Overdue ${span(-mins)}`, overdue: true, soon: false };
  return { text: `Due in ${span(mins)}`, overdue: false, soon: mins <= 30 };
}

export function ConversationTicketBar({
  workspaceId,
  ticketId,
  canEdit,
  refreshKey,
  onOpenTicket,
}: {
  workspaceId: string;
  ticketId: string;
  /** Light agents can see the ticket but not change it. */
  canEdit: boolean;
  /** Changes when the conversation does (the database syncs the ticket). */
  refreshKey?: string;
  onOpenTicket?: (ticketId: string) => void;
}) {
  const [ticket, setTicket] = useState<BarTicket | null>(null);
  const [parentNumber, setParentNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data, error: err } = await supabase.from('tickets').select(COLUMNS).eq('id', ticketId).maybeSingle();
    if (err) {
      console.error('[Ticket Bar] load:', err.message);
      return;
    }
    const row = (data as BarTicket | null) ?? null;
    setTicket(row);
    if (row?.follow_up_of_id) {
      const { data: parent } = await supabase.from('tickets').select('number').eq('id', row.follow_up_of_id).maybeSingle();
      setParentNumber((parent?.number as number | undefined) ?? null);
    } else {
      setParentNumber(null);
    }
  }, [ticketId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  // The SLA countdown moves on its own.
  useEffect(() => {
    if (!ticket?.sla_next_due_at) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [ticket?.sla_next_due_at]);

  const change = async (patch: { status?: TicketStatus; priority?: TicketPriority; type?: TicketType }) => {
    if (!ticket) return;
    const before = ticket;
    setTicket({ ...ticket, ...patch });
    setSaving(true);
    setError(null);
    try {
      const saved = await updateTicketAction(workspaceId, ticket.id, patch);
      setTicket((t) => (t ? { ...t, ...pick(saved) } : t));
    } catch (err) {
      setTicket(before);
      setError(errorMessage(err, 'The ticket could not be changed.'));
    } finally {
      setSaving(false);
    }
  };

  if (!ticket) return null;

  const closed = ticket.status === 'closed';
  const editable = canEdit && !closed;
  const due = ticket.sla_state === 'running' ? slaDueLabel(ticket.sla_next_due_at) : null;

  return (
    <div className="shrink-0 border-b border-line bg-surface-2/60 px-3 sm:px-4 py-1.5 flex items-center gap-2 min-w-0 text-xs" aria-label="Ticket">
      <button
        type="button"
        onClick={() => onOpenTicket?.(ticket.id)}
        disabled={!onOpenTicket}
        className="inline-flex items-center gap-1.5 shrink-0 font-semibold text-ink hover:text-accent transition-colors"
        title="Open the full ticket"
      >
        <TicketIcon className="w-3.5 h-3.5 text-ink-3" />#{ticket.number}
        {onOpenTicket && <ArrowUpRight className="w-3 h-3 text-ink-3" />}
      </button>

      <span className="hidden md:block min-w-0 truncate text-ink-3" title={ticket.subject}>
        {ticket.subject}
      </span>

      {parentNumber && (
        <span className="hidden lg:inline-flex items-center gap-1 shrink-0 text-ink-3" title="Opened because the customer wrote after the earlier ticket was closed">
          <CornerDownRight className="w-3 h-3" />
          follow-up of #{parentNumber}
        </span>
      )}

      <div className="flex-1" />

      {due && (
        <span
          className={cn(
            'inline-flex items-center gap-1 shrink-0 px-1.5 h-5 rounded-md font-semibold',
            due.overdue ? 'bg-danger-soft text-danger' : due.soon ? 'bg-warn-soft text-warn' : 'text-ink-3'
          )}
          title="Next SLA target for this ticket"
        >
          <Clock className="w-3 h-3" />
          {due.text}
        </span>
      )}

      {editable ? (
        <>
          <Menu<TicketStatus>
            label="Ticket status"
            value={ticket.status}
            options={SETTABLE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
            onChange={(status) => void change({ status })}
            trigger={() => (
              <span className="inline-flex items-center gap-0.5 cursor-pointer">
                <StatusBadge status={ticket.status} />
                <ChevronDown className="w-3 h-3 text-ink-3" />
              </span>
            )}
          />
          {/* Priority is set on the row below (it is the same value, kept in
              step by the database), so it is not repeated here. */}
          <Menu<TicketType>
            label="Ticket type"
            value={ticket.type}
            options={TICKET_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
            onChange={(type) => void change({ type })}
            trigger={() => (
              <span className="hidden sm:inline-flex items-center gap-0.5 cursor-pointer text-ink-2">
                {TYPE_LABEL[ticket.type]}
                <ChevronDown className="w-3 h-3 text-ink-3" />
              </span>
            )}
          />
        </>
      ) : (
        <span
          className="inline-flex items-center gap-2 shrink-0"
          title={closed ? 'Closed tickets are read-only. A new message from the customer opens a follow-up ticket.' : 'You can view this ticket but not change it.'}
        >
          <StatusBadge status={ticket.status} />
        </span>
      )}

      {saving && <span className="sr-only" aria-live="polite">Saving the ticket…</span>}
      {error && (
        <span className="inline-flex items-center gap-1 text-danger shrink-0" role="alert" title={error}>
          <AlertCircle className="w-3.5 h-3.5" />
          <span className="hidden sm:inline max-w-[180px] truncate">{error}</span>
        </span>
      )}
    </div>
  );
}

function pick(t: Ticket): Partial<BarTicket> {
  return { status: t.status, priority: t.priority, type: t.type, sla_next_due_at: t.sla_next_due_at, sla_state: t.sla_state };
}
