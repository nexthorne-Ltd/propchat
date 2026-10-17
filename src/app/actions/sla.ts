'use server';

/**
 * SLA policies and the holiday calendar (Settings → Automation → SLA). All of
 * it needs `manage_settings`. The timing itself lives in the database
 * (supabase/migrations/20261016090000_sla_policies.sql); these actions write
 * policies and holidays and then ask the database to re-evaluate the open
 * tickets, so a saved change shows on tickets straight away.
 */

import { getWorkspaceAccess } from '@/lib/team/access';
import { assertWorkspaceFeature } from '@/lib/plans/enforce';
import {
  hasPolicyErrors,
  holidayError,
  normalizeConditions,
  normalizeTargets,
  validatePolicyDraft,
  type Holiday,
  type HolidayInput,
  type SlaPolicyDraft,
  type SlaPolicyRow,
} from '@/lib/sla/policy';
import type { BusinessHoursConfig } from '@/types/database';
import { userError } from '@/lib/errors/user-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Result<T> = ({ success: true } & T) | { success: false; error: string };
type Supabase = Awaited<ReturnType<typeof getWorkspaceAccess>>['supabase'];

function fail(error: unknown, fallback: string): { success: false; error: string } {
  const message = (error as { message?: string } | null)?.message || fallback;
  console.error('[SLA Error]:', message);
  return { success: false, error: message };
}

function checkId(id: string, what: string) {
  if (!UUID.test(id || '')) throw userError(`${what} was not found.`);
}

/**
 * Re-evaluates every open ticket against the saved policies and calendar.
 * Without this a saved change would only reach a ticket the next time
 * something happens to it.
 */
async function reapply(supabase: Supabase, workspaceId: string): Promise<{ success: false; error: string } | null> {
  const { error } = await supabase.rpc('fn_sla_reapply_workspace', { p_workspace_id: workspaceId });
  if (error) return fail(error, 'Saved, but open tickets could not be updated. Try saving again.');
  return null;
}

export interface SlaBootstrap {
  policies: SlaPolicyRow[];
  holidays: Holiday[];
  groups: { id: string; name: string }[];
  calendar: { hours: BusinessHoursConfig | null; timezone: string };
}

export async function getSlaBootstrapAction(workspaceId: string): Promise<Result<{ data: SlaBootstrap }>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const [policies, holidays, groups, workspace] = await Promise.all([
      supabase.from('sla_policies').select('*').eq('workspace_id', workspaceId).order('position').order('created_at'),
      supabase.from('workspace_holidays').select('id, name, starts_on, ends_on, repeats_yearly').eq('workspace_id', workspaceId).order('starts_on'),
      supabase.from('ticket_groups').select('id, name').eq('workspace_id', workspaceId).order('name'),
      supabase.from('workspaces').select('business_hours, timezone').eq('id', workspaceId).maybeSingle(),
    ]);
    const failed = policies.error || holidays.error || groups.error || workspace.error;
    if (failed) return fail(failed, 'Could not load SLA settings.');
    const hours = (workspace.data?.business_hours as BusinessHoursConfig | null) ?? null;
    return {
      success: true,
      data: {
        policies: (policies.data || []) as SlaPolicyRow[],
        holidays: (holidays.data || []) as Holiday[],
        groups: (groups.data || []) as { id: string; name: string }[],
        calendar: { hours, timezone: hours?.timezone || (workspace.data?.timezone as string | null) || 'UTC' },
      },
    };
  } catch (e) {
    return fail(e, 'Could not load SLA settings.');
  }
}

/* ── Policies ──────────────────────────────────────────────────────────── */

export async function saveSlaPolicyAction(workspaceId: string, draft: SlaPolicyDraft): Promise<Result<{ policy: SlaPolicyRow }>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    await assertWorkspaceFeature(workspaceId, 'sla');
    const clean: SlaPolicyDraft = { ...draft, conditions: normalizeConditions(draft.conditions), targets: normalizeTargets(draft.targets) };
    const errors = validatePolicyDraft(clean);
    if (hasPolicyErrors(errors)) {
      return { success: false, error: errors.name || errors.targets || errors.alert || errors.conditions || 'Check the policy and try again.' };
    }

    if (clean.conditions.group_ids?.length) {
      const { data: found, error } = await supabase.from('ticket_groups').select('id').eq('workspace_id', workspaceId).in('id', clean.conditions.group_ids);
      if (error) return fail(error, 'Could not check the groups.');
      if ((found || []).length !== clean.conditions.group_ids.length) return { success: false, error: 'One of the chosen groups no longer exists.' };
    }

    const stored = {
      name: clean.name.trim(),
      description: clean.description.trim(),
      is_active: clean.is_active,
      conditions: clean.conditions,
      targets: clean.targets,
      business_hours: clean.business_hours,
      alert_before_minutes: clean.alert_before_minutes,
      notify_assignee: clean.notify_assignee,
      notify_group: clean.notify_group,
    };

    let row: SlaPolicyRow;
    if (clean.id) {
      checkId(clean.id, 'That policy');
      const { data, error } = await supabase.from('sla_policies').update(stored).eq('workspace_id', workspaceId).eq('id', clean.id).select('*').maybeSingle();
      if (error || !data) return fail(error, 'Policy not found.');
      row = data as SlaPolicyRow;
    } else {
      const { data: last } = await supabase
        .from('sla_policies')
        .select('position')
        .eq('workspace_id', workspaceId)
        .order('position', { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data, error } = await supabase
        .from('sla_policies')
        .insert({ ...stored, workspace_id: workspaceId, position: ((last?.position as number | undefined) ?? 0) + 1 })
        .select('*')
        .single();
      if (error) return fail(error, 'Could not save the policy.');
      row = data as SlaPolicyRow;
    }
    const refused = await reapply(supabase, workspaceId);
    if (refused) return refused;
    return { success: true, policy: row };
  } catch (e) {
    return fail(e, 'Could not save the policy.');
  }
}

export async function setSlaPolicyActiveAction(workspaceId: string, policyId: string, active: boolean): Promise<Result<{ policy: SlaPolicyRow }>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    checkId(policyId, 'That policy');
    const { data, error } = await supabase.from('sla_policies').update({ is_active: active }).eq('workspace_id', workspaceId).eq('id', policyId).select('*').maybeSingle();
    if (error || !data) return fail(error, 'Policy not found.');
    const refused = await reapply(supabase, workspaceId);
    if (refused) return refused;
    return { success: true, policy: data as SlaPolicyRow };
  } catch (e) {
    return fail(e, 'Could not update the policy.');
  }
}

export async function reorderSlaPoliciesAction(workspaceId: string, orderedIds: string[]): Promise<Result<unknown>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    orderedIds.forEach((id) => checkId(id, 'A policy'));
    const { error } = await supabase.rpc('fn_sla_reorder_policies', { p_workspace_id: workspaceId, p_ids: orderedIds });
    if (error) return fail(error, 'Could not reorder the policies.');
    return { success: true };
  } catch (e) {
    return fail(e, 'Could not reorder the policies.');
  }
}

export async function deleteSlaPolicyAction(workspaceId: string, policyId: string): Promise<Result<unknown>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    checkId(policyId, 'That policy');
    const { error } = await supabase.from('sla_policies').delete().eq('workspace_id', workspaceId).eq('id', policyId);
    if (error) return fail(error, 'Could not delete the policy.');
    const refused = await reapply(supabase, workspaceId);
    if (refused) return refused;
    return { success: true };
  } catch (e) {
    return fail(e, 'Could not delete the policy.');
  }
}

/* ── Holidays ──────────────────────────────────────────────────────────── */

export async function saveHolidayAction(workspaceId: string, input: HolidayInput): Promise<Result<{ holiday: Holiday }>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const problem = holidayError(input);
    if (problem) return { success: false, error: problem };
    const stored = { name: input.name.trim(), starts_on: input.starts_on, ends_on: input.ends_on, repeats_yearly: input.repeats_yearly };
    const select = 'id, name, starts_on, ends_on, repeats_yearly';
    let result;
    if (input.id) {
      checkId(input.id, 'That holiday');
      result = await supabase.from('workspace_holidays').update(stored).eq('workspace_id', workspaceId).eq('id', input.id).select(select).maybeSingle();
    } else {
      result = await supabase.from('workspace_holidays').insert({ ...stored, workspace_id: workspaceId }).select(select).single();
    }
    if (result.error || !result.data) return fail(result.error, 'Holiday not found.');
    const refused = await reapply(supabase, workspaceId);
    if (refused) return refused;
    return { success: true, holiday: result.data as Holiday };
  } catch (e) {
    return fail(e, 'Could not save the holiday.');
  }
}

export async function deleteHolidayAction(workspaceId: string, holidayId: string): Promise<Result<unknown>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    checkId(holidayId, 'That holiday');
    const { error } = await supabase.from('workspace_holidays').delete().eq('workspace_id', workspaceId).eq('id', holidayId);
    if (error) return fail(error, 'Could not delete the holiday.');
    const refused = await reapply(supabase, workspaceId);
    if (refused) return refused;
    return { success: true };
  } catch (e) {
    return fail(e, 'Could not delete the holiday.');
  }
}
