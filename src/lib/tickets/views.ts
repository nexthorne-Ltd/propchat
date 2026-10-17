/**
 * Inbox views: which tickets a view shows and in what order.
 *
 * Built-in views and saved views are the same thing, a set of filters plus a
 * sort, so the ticket list and the count beside each view are always produced
 * by the same code (`applyTicketFilters`) and can never disagree.
 *
 * Saved filters come back from the database as JSON a user once typed into
 * a form, so everything that reads them goes through `normalizeFilters` first.
 */
import type { TicketChannel, TicketPriority, TicketStatus, TicketType } from '@/types/database';

export const TICKET_STATUSES: readonly TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'solved', 'closed'];
export const TICKET_PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent'];
export const TICKET_TYPES: readonly TicketType[] = ['question', 'incident', 'problem', 'task'];
export const TICKET_CHANNELS: readonly TicketChannel[] = ['chat', 'email', 'web_form', 'whatsapp', 'instagram', 'x', 'linkedin', 'tiktok', 'threads'];
/** Channels an agent can log a ticket under by hand; the others start from the customer. */
export const MANUAL_TICKET_CHANNELS: readonly TicketChannel[] = ['email', 'web_form'];
/** Statuses an agent can choose. New is where tickets start, not a choice. */
export const SETTABLE_STATUSES: readonly TicketStatus[] = ['open', 'pending', 'on_hold', 'solved', 'closed'];
export const UNSOLVED: readonly TicketStatus[] = ['new', 'open', 'pending', 'on_hold'];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: 'New',
  open: 'Open',
  pending: 'Pending',
  on_hold: 'On-hold',
  solved: 'Solved',
  closed: 'Closed',
};
export const PRIORITY_LABEL: Record<TicketPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const TYPE_LABEL: Record<TicketType, string> = { question: 'Question', incident: 'Incident', problem: 'Problem', task: 'Task' };
export const CHANNEL_LABEL: Record<TicketChannel, string> = { chat: 'Chat', email: 'Email', web_form: 'Web form', whatsapp: 'WhatsApp', instagram: 'Instagram', x: 'X', linkedin: 'LinkedIn', tiktok: 'TikTok', threads: 'Threads' };

export interface TicketFilters {
  status?: TicketStatus[];
  priority?: TicketPriority[];
  type?: TicketType[];
  /** Agent ids, plus 'me' (whoever is looking) and 'none' (unassigned). */
  assignee?: string[];
  /** Group ids, plus 'none'. */
  group?: string[];
  /** Tickets carrying any of these tags. */
  tags?: string[];
  channel?: TicketChannel[];
  /** Only tickets solved within this many days. */
  solvedWithinDays?: number;
}

export type SortField = 'updated_at' | 'created_at' | 'number' | 'priority' | 'status' | 'solved_at' | 'sla_next_due_at';
export interface TicketSort {
  field: SortField;
  direction: 'asc' | 'desc';
}

export const SORT_FIELDS: readonly SortField[] = ['updated_at', 'created_at', 'number', 'priority', 'status', 'solved_at', 'sla_next_due_at'];
export const SORT_LABEL: Record<SortField, string> = {
  updated_at: 'Last updated',
  created_at: 'Created',
  number: 'Ticket number',
  priority: 'Priority',
  status: 'Status',
  solved_at: 'Solved',
  // Ascending puts the ticket closest to (or furthest past) its SLA first;
  // tickets with no running SLA clock always sort last.
  sla_next_due_at: 'Next SLA breach',
};
export const DEFAULT_SORT: TicketSort = { field: 'updated_at', direction: 'desc' };

export interface ViewDefinition {
  /** 'system:<key>' for built-in views, the row id for saved ones. */
  id: string;
  name: string;
  filters: TicketFilters;
  sort: TicketSort;
  system: boolean;
  /** Saved views: null means shared with the workspace. */
  ownerId?: string | null;
}

export const SYSTEM_VIEWS: readonly ViewDefinition[] = [
  { id: 'system:my_open', name: 'My open tickets', system: true, filters: { assignee: ['me'], status: ['new', 'open'] }, sort: DEFAULT_SORT },
  { id: 'system:unassigned', name: 'Unassigned', system: true, filters: { assignee: ['none'], status: [...UNSOLVED] }, sort: { field: 'created_at', direction: 'asc' } },
  { id: 'system:all_open', name: 'All open', system: true, filters: { status: ['new', 'open'] }, sort: DEFAULT_SORT },
  { id: 'system:pending', name: 'Pending', system: true, filters: { status: ['pending'] }, sort: DEFAULT_SORT },
  {
    id: 'system:recently_solved',
    name: 'Recently solved',
    system: true,
    filters: { status: ['solved', 'closed'], solvedWithinDays: 7 },
    sort: { field: 'solved_at', direction: 'desc' },
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pick<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = Array.from(new Set(value.filter((v): v is T => typeof v === 'string' && allowed.includes(v as T))));
  return out.length ? out : undefined;
}

function ids(value: unknown, specials: readonly string[]): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = Array.from(
    new Set(value.filter((v): v is string => typeof v === 'string' && (specials.includes(v) || UUID.test(v))))
  );
  return out.length ? out : undefined;
}

/** Tags are stored trimmed and lower-case; this is the one place that decides. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_\-:.]/g, '').slice(0, 40);
}

/** Keeps only filters this code understands, with values it can trust. */
export function normalizeFilters(input: unknown): TicketFilters {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const filters: TicketFilters = {
    status: pick(raw.status, TICKET_STATUSES),
    priority: pick(raw.priority, TICKET_PRIORITIES),
    type: pick(raw.type, TICKET_TYPES),
    assignee: ids(raw.assignee, ['me', 'none']),
    group: ids(raw.group, ['none']),
    channel: pick(raw.channel, TICKET_CHANNELS),
  };
  if (Array.isArray(raw.tags)) {
    const tags = Array.from(new Set(raw.tags.filter((t): t is string => typeof t === 'string').map(normalizeTag).filter(Boolean)));
    if (tags.length) filters.tags = tags.slice(0, 20);
  }
  const days = Number(raw.solvedWithinDays);
  if (Number.isFinite(days) && days > 0) filters.solvedWithinDays = Math.min(Math.floor(days), 365);
  for (const key of Object.keys(filters) as (keyof TicketFilters)[]) {
    if (filters[key] === undefined) delete filters[key];
  }
  return filters;
}

export function normalizeSort(input: unknown): TicketSort {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const field = SORT_FIELDS.includes(raw.field as SortField) ? (raw.field as SortField) : DEFAULT_SORT.field;
  const direction = raw.direction === 'asc' ? 'asc' : raw.direction === 'desc' ? 'desc' : DEFAULT_SORT.direction;
  return { field, direction };
}

/** The subset of the Supabase query builder the filters use. */
export interface FilterableQuery<Q> {
  eq(column: string, value: unknown): Q;
  in(column: string, values: readonly unknown[]): Q;
  is(column: string, value: null): Q;
  or(filters: string): Q;
  overlaps(column: string, values: readonly unknown[]): Q;
  gte(column: string, value: string): Q;
}

/**
 * Applies a view's filters to a tickets query. `meId` resolves 'me'.
 * `now` is injectable for tests.
 */
export function applyTicketFilters<Q extends FilterableQuery<Q>>(
  query: Q,
  filters: TicketFilters,
  meId: string,
  now: Date = new Date()
): Q {
  let q = query;
  if (filters.status?.length) q = q.in('status', filters.status);
  if (filters.priority?.length) q = q.in('priority', filters.priority);
  if (filters.type?.length) q = q.in('type', filters.type);
  if (filters.channel?.length) q = q.in('channel', filters.channel);
  if (filters.tags?.length) q = q.overlaps('tags', filters.tags);

  q = applyIdFilter(q, 'assignee_id', (filters.assignee || []).map((a) => (a === 'me' ? meId : a)));
  q = applyIdFilter(q, 'group_id', filters.group || []);

  if (filters.solvedWithinDays) {
    q = q.gte('solved_at', new Date(now.getTime() - filters.solvedWithinDays * 86_400_000).toISOString());
  }
  return q;
}

function applyIdFilter<Q extends FilterableQuery<Q>>(q: Q, column: string, values: string[]): Q {
  if (!values.length) return q;
  const wantsNone = values.includes('none');
  const real = values.filter((v) => v !== 'none' && UUID.test(v));
  if (wantsNone && real.length) return q.or(`${column}.is.null,${column}.in.(${real.join(',')})`);
  if (wantsNone) return q.is(column, null);
  return real.length ? q.in(column, real) : q;
}

/** The column a sort really orders by: ranks, not alphabetical labels. */
export function sortColumn(sort: TicketSort): string {
  if (sort.field === 'priority') return 'priority_rank';
  if (sort.field === 'status') return 'status_rank';
  return sort.field;
}

/** Turns a saved row into a view definition, dropping anything unreadable. */
export function viewFromRow(row: { id: string; name: string; filters: unknown; sort: unknown; owner_id: string | null }): ViewDefinition {
  return {
    id: row.id,
    name: row.name,
    filters: normalizeFilters(row.filters),
    sort: normalizeSort(row.sort),
    system: false,
    ownerId: row.owner_id,
  };
}

/** "#1042", "1042" → 1042; anything else → null. */
export function parseTicketNumber(query: string): number | null {
  const m = query.trim().match(/^#?(\d{1,9})$/);
  return m ? Number(m[1]) : null;
}
