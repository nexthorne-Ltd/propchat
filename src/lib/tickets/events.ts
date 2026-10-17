/**
 * Turns ticket_events rows into the sentences shown in a ticket's audit log:
 * who did it, what changed, from what to what.
 */
import type { TicketEvent, TicketPriority, TicketStatus, TicketType, TicketChannel } from '@/types/database';
import { CHANNEL_LABEL, PRIORITY_LABEL, STATUS_LABEL, TYPE_LABEL } from './views';

export interface EventContext {
  /** Agent and visitor names by id. */
  people: Record<string, string>;
  /** Group names by id. */
  groups: Record<string, string>;
}

export function actorLabel(event: Pick<TicketEvent, 'actor_type' | 'actor_id'>, ctx: EventContext): string {
  if (event.actor_type === 'agent') return (event.actor_id && ctx.people[event.actor_id]) || 'An agent';
  if (event.actor_type === 'customer') return (event.actor_id && ctx.people[event.actor_id]) || 'Customer';
  if (event.actor_type === 'bot') return 'Bot';
  return 'System';
}

const FIELD_LABEL: Record<string, string> = {
  subject: 'Subject',
  status: 'Status',
  priority: 'Priority',
  type: 'Type',
  assignee_id: 'Assignee',
  group_id: 'Group',
  tags: 'Tags',
  requester_id: 'Requester',
  channel: 'Channel',
};

function valueLabel(field: string | null, value: string | null, ctx: EventContext): string {
  if (value === null || value === '') {
    return field === 'assignee_id' ? 'Unassigned' : field === 'group_id' ? 'No group' : '—';
  }
  switch (field) {
    case 'status':
      return STATUS_LABEL[value as TicketStatus] ?? value;
    case 'priority':
      return PRIORITY_LABEL[value as TicketPriority] ?? value;
    case 'type':
      return TYPE_LABEL[value as TicketType] ?? value;
    case 'channel':
      return CHANNEL_LABEL[value as TicketChannel] ?? value;
    case 'assignee_id':
    case 'requester_id':
      return ctx.people[value] ?? 'Someone no longer here';
    case 'group_id':
      return ctx.groups[value] ?? 'A deleted group';
    default:
      return value;
  }
}

/** One line describing what happened, without the actor. */
export function describeEvent(event: TicketEvent, ctx: EventContext): string {
  switch (event.action) {
    case 'created':
      return `Created the ticket as ${valueLabel('status', event.new_value, ctx)}`;
    case 'public_reply':
      return 'Replied to the customer';
    case 'internal_note':
      return 'Added an internal note';
    case 'merged':
      return 'Merged this ticket into another';
    case 'follow_up_created':
      return `Opened this ticket as a follow-up to ${event.new_value ?? 'a closed ticket'}`;
    case 'updated': {
      const field = event.field ?? '';
      const label = FIELD_LABEL[field] ?? field;
      return `${label}: ${valueLabel(field, event.old_value, ctx)} → ${valueLabel(field, event.new_value, ctx)}`;
    }
    default:
      return event.action;
  }
}
