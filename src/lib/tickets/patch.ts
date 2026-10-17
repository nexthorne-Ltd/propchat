/**
 * What an agent may change on a ticket, and with which values. Shared by the
 * single-ticket and bulk actions so both accept exactly the same input.
 */
import type { TicketPriority, TicketStatus, TicketType } from '@/types/database';
import { SETTABLE_STATUSES, TICKET_PRIORITIES, TICKET_TYPES, normalizeTag } from './views';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TicketPatch {
  subject?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  type?: TicketType;
  assignee_id?: string | null;
  group_id?: string | null;
  tags?: string[];
  csat_rating?: 'good' | 'bad' | null;
  csat_comment?: string | null;
}

/**
 * Keeps only fields an agent may set, with valid values. Workspace, number,
 * links and timestamps are never accepted; New is not a status one can choose.
 */
export function sanitizeTicketPatch(patch: TicketPatch): TicketPatch {
  const out: TicketPatch = {};
  if (typeof patch.subject === 'string') out.subject = patch.subject.trim().slice(0, 250);
  if (patch.status && SETTABLE_STATUSES.includes(patch.status)) out.status = patch.status;
  if (patch.priority && TICKET_PRIORITIES.includes(patch.priority)) out.priority = patch.priority;
  if (patch.type && TICKET_TYPES.includes(patch.type)) out.type = patch.type;
  if (patch.assignee_id === null || (typeof patch.assignee_id === 'string' && UUID.test(patch.assignee_id))) {
    out.assignee_id = patch.assignee_id;
  }
  if (patch.group_id === null || (typeof patch.group_id === 'string' && UUID.test(patch.group_id))) out.group_id = patch.group_id;
  if (Array.isArray(patch.tags)) {
    out.tags = Array.from(new Set(patch.tags.map((t) => normalizeTag(String(t))).filter(Boolean))).slice(0, 30);
  }
  if (patch.csat_rating && ['good', 'bad'].includes(patch.csat_rating)) out.csat_rating = patch.csat_rating;
  if (typeof patch.csat_comment === 'string') out.csat_comment = patch.csat_comment.trim().slice(0, 1000);
  return out;
}
