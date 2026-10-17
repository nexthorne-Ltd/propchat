import { userError } from '@/lib/errors/user-error';
import { isOnShift, localWeekMinute, type Shift } from './shifts';

/**
 * Picks who should handle a conversation and assigns it. Used by the inbox's
 * "auto-assign" button and by the bot's handover.
 *
 * The choice follows shifts (Settings → Team → shift hours). It used to look
 * only at the online dot, so a handover went to whoever had left a dashboard
 * tab open, and to nobody when the person on shift showed as away.
 *
 *   1. Who can take it at all: active, not a light agent, under their
 *      open-ticket capacity.
 *   2. When anyone has shift hours and someone's shift is running: only the
 *      people on shift, online first, then away, then offline (they are
 *      meant to be working; the alert email reaches them).
 *   3. Otherwise (no shifts, or nobody on shift right now): online people,
 *      as before.
 *   Ties go to the one with the fewest open tickets.
 *
 * With keepAssignee (the handover), a conversation already with someone who
 * passes the same test stays with them: they know the customer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from: (table: string) => any };

export interface AutoAssignResult {
  assigned: boolean;
  reason?: string;
  agent?: { id: string; name: string | null; email: string | null; avatar_url: string | null };
  /** Why this person: their shift is running, or they were online. */
  basis?: 'on_shift' | 'online' | 'kept';
}

export interface AssignCandidate {
  id: string;
  status: string | null;
  is_active: boolean | null;
  role: string | null;
  max_open_tickets: number | null;
  shifts: Shift[];
}

const STATUS_RANK: Record<string, number> = { online: 0, away: 1 };

/** The pure part of the choice, for tests. */
export function chooseAssignee(input: {
  candidates: AssignCandidate[];
  load: Map<string, number>;
  at: { weekday: number; minute: number };
  currentAssigneeId?: string | null;
}): { id: string; basis: 'on_shift' | 'online' | 'kept' } | null {
  const able = input.candidates.filter(
    (a) =>
      a.is_active !== false &&
      a.role !== 'light_agent' &&
      (a.max_open_tickets == null || (input.load.get(a.id) || 0) < a.max_open_tickets)
  );
  const anyShifts = input.candidates.some((a) => a.is_active !== false && a.shifts.length > 0);
  const onShift = anyShifts ? able.filter((a) => a.shifts.length > 0 && isOnShift(a.shifts, input.at)) : [];
  const pool = onShift.length ? onShift : able.filter((a) => a.status === 'online');
  const basis = onShift.length ? 'on_shift' : 'online';

  if (input.currentAssigneeId) {
    // The current assignee's own open ticket counts toward their load, so
    // capacity is not held against keeping them.
    const current = input.candidates.find((a) => a.id === input.currentAssigneeId);
    const keep =
      current &&
      current.is_active !== false &&
      current.role !== 'light_agent' &&
      (onShift.length ? onShift.some((a) => a.id === current.id) : current.status === 'online');
    if (keep) return { id: current.id, basis: 'kept' };
  }

  if (!pool.length) return null;
  const sorted = [...pool].sort(
    (a, b) =>
      (STATUS_RANK[a.status || ''] ?? 2) - (STATUS_RANK[b.status || ''] ?? 2) ||
      (input.load.get(a.id) || 0) - (input.load.get(b.id) || 0)
  );
  return { id: sorted[0].id, basis };
}

export async function autoAssignConversation(
  supabase: Client,
  conversationId: string,
  options: { keepAssignee?: boolean } = {}
): Promise<AutoAssignResult> {
  const { data: conv } = await supabase.from('conversations').select('id, workspace_id, assigned_agent_id').eq('id', conversationId).maybeSingle();
  if (!conv) throw userError('Conversation not found');
  const wsId = conv.workspace_id as string | null;
  if (!wsId) return { assigned: false, reason: 'Conversation has no workspace' };

  const { data: ws } = await supabase.from('workspaces').select('auto_assignment, timezone, business_hours').eq('id', wsId).maybeSingle();
  if (ws?.auto_assignment && ws.auto_assignment.enabled === false) {
    return { assigned: false, reason: 'Auto-assignment is disabled for this workspace' };
  }

  const [{ data: agents }, { data: shifts }, { data: open }] = await Promise.all([
    supabase.from('agents').select('id, name, email, avatar_url, status, role, is_active, max_open_tickets').eq('workspace_id', wsId),
    supabase.from('agent_shifts').select('agent_id, weekday, start_minute, end_minute').eq('workspace_id', wsId),
    supabase.from('tickets').select('assignee_id').eq('workspace_id', wsId).in('status', ['new', 'open']).not('assignee_id', 'is', null),
  ]);
  type A = AssignCandidate & { name: string | null; email: string | null; avatar_url: string | null };
  const rows = (agents as Omit<A, 'shifts'>[] | null) || [];
  if (!rows.length) return { assigned: false, reason: 'No agents in this workspace' };

  // Before the shifts migration the table is missing; everyone is then "no shifts".
  const shiftsBy = new Map<string, Shift[]>();
  for (const s of (shifts as (Shift & { agent_id: string })[] | null) || []) {
    shiftsBy.set(s.agent_id, [...(shiftsBy.get(s.agent_id) || []), s]);
  }
  const load = new Map<string, number>();
  for (const t of (open as { assignee_id: string }[] | null) || []) load.set(t.assignee_id, (load.get(t.assignee_id) || 0) + 1);

  const candidates: A[] = rows.map((a) => ({ ...a, shifts: shiftsBy.get(a.id) || [] }));
  const timeZone = (ws?.timezone as string | null) || (ws?.business_hours as { timezone?: string } | null)?.timezone || 'UTC';
  const choice = chooseAssignee({
    candidates,
    load,
    at: localWeekMinute(new Date(), timeZone),
    currentAssigneeId: options.keepAssignee ? (conv.assigned_agent_id as string | null) : null,
  });
  if (!choice) return { assigned: false, reason: 'Nobody is on shift or online with room for more tickets' };

  const chosen = candidates.find((a) => a.id === choice.id)!;
  const agent = { id: chosen.id, name: chosen.name, email: chosen.email, avatar_url: chosen.avatar_url };
  if (choice.basis === 'kept') return { assigned: true, agent, basis: 'kept' };

  const { error } = await supabase
    .from('conversations')
    .update({ assigned_agent_id: chosen.id, updated_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (error) throw error;
  return { assigned: true, agent, basis: choice.basis };
}
