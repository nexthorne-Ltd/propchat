'use server';

import { getWorkspaceAccess } from '@/lib/team/access';
import {
  cleanOptions,
  fieldKeyFrom,
  normalizeFieldValue,
  validateFieldDefinition,
  type TicketField,
  type TicketFieldType,
  type TicketFieldValue,
} from '@/lib/tickets/fields';
import { userError } from '@/lib/errors/user-error';

/**
 * Custom ticket fields: definitions (owners and admins) and values (anyone who
 * can edit tickets). RLS on ticket_fields and the ticket triggers check the
 * same roles again; closed tickets stay read-only.
 */

const COLUMNS = 'id, key, label, type, options, description, required, is_active, position';

export async function listTicketFieldsAction(workspaceId: string): Promise<TicketField[]> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'view');
  const { data, error } = await supabase
    .from('ticket_fields')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('position')
    .order('created_at');
  if (error) throw userError(error.message);
  return (data as TicketField[]) || [];
}

export async function saveTicketFieldAction(
  workspaceId: string,
  input: { id?: string | null; label: string; type: TicketFieldType; options?: string[]; description?: string; required?: boolean; is_active?: boolean }
): Promise<TicketField> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const problem = validateFieldDefinition(input);
  if (problem) throw userError(problem);
  const row = {
    label: input.label.trim(),
    type: input.type,
    options: input.type === 'dropdown' ? cleanOptions(input.options || []) : [],
    description: (input.description || '').trim().slice(0, 200),
    required: Boolean(input.required),
    is_active: input.is_active !== false,
  };

  if (input.id) {
    // The key and type stay as they were: existing tickets hold values under them.
    const { data, error } = await supabase
      .from('ticket_fields')
      .update({ label: row.label, options: row.options, description: row.description, required: row.required, is_active: row.is_active })
      .eq('id', input.id)
      .eq('workspace_id', workspaceId)
      .select(COLUMNS)
      .single();
    if (error) throw userError(error.message);
    return data as TicketField;
  }

  const { data: existing } = await supabase.from('ticket_fields').select('key, position').eq('workspace_id', workspaceId);
  const keys = new Set(((existing as { key: string }[] | null) || []).map((f) => f.key));
  let key = fieldKeyFrom(row.label);
  for (let i = 2; keys.has(key); i++) key = `${fieldKeyFrom(row.label).slice(0, 36)}_${i}`;
  const position = Math.max(0, ...((existing as { position: number }[] | null) || []).map((f) => f.position + 1));

  const { data, error } = await supabase
    .from('ticket_fields')
    .insert({ workspace_id: workspaceId, key, position, ...row })
    .select(COLUMNS)
    .single();
  if (error) throw userError(error.message);
  return data as TicketField;
}

export async function deleteTicketFieldAction(workspaceId: string, id: string): Promise<void> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const { error } = await supabase.from('ticket_fields').delete().eq('id', id).eq('workspace_id', workspaceId);
  if (error) throw userError(error.message);
}

export async function reorderTicketFieldsAction(workspaceId: string, orderedIds: string[]): Promise<void> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await supabase.from('ticket_fields').update({ position: i }).eq('id', orderedIds[i]).eq('workspace_id', workspaceId);
    if (error) throw userError(error.message);
  }
}

/** Sets some of a ticket's field values (others are left as they are). */
export async function setTicketFieldValuesAction(
  workspaceId: string,
  ticketId: string,
  values: Record<string, unknown>
): Promise<Record<string, TicketFieldValue>> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'edit_ticket');
  const [{ data: fields }, { data: ticket, error: ticketError }] = await Promise.all([
    supabase.from('ticket_fields').select(COLUMNS).eq('workspace_id', workspaceId),
    supabase.from('tickets').select('id, status, custom_fields').eq('id', ticketId).eq('workspace_id', workspaceId).maybeSingle(),
  ]);
  if (ticketError) throw userError(ticketError.message);
  if (!ticket) throw userError('That ticket was not found.');
  if (ticket.status === 'closed') throw userError('Closed tickets are read-only.');

  const byKey = new Map(((fields as TicketField[] | null) || []).map((f) => [f.key, f]));
  const next: Record<string, TicketFieldValue> = { ...((ticket.custom_fields as Record<string, TicketFieldValue>) || {}) };
  for (const [key, raw] of Object.entries(values || {})) {
    const field = byKey.get(key);
    if (!field) throw userError('That field no longer exists. Reload the page.');
    const result = normalizeFieldValue(field, raw);
    if ('error' in result) throw userError(result.error);
    if (result.value === null) delete next[key];
    else next[key] = result.value;
  }

  const { error } = await supabase.from('tickets').update({ custom_fields: next }).eq('id', ticketId).eq('workspace_id', workspaceId);
  if (error) throw userError(error.message);
  return next;
}
