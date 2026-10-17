'use server';

/**
 * Macros, triggers and automations (Settings → Automation, and the reply
 * box's "/" menu). Rules need `manage_settings`; macros are visible to any
 * member and managed through row level security (shared ones by admins,
 * personal ones by their owner). The evaluation itself lives in the database
 * (supabase/migrations/20261014090000_macros_triggers_automations.sql); these
 * actions only read and write rules and report the database's answer.
 */

import { after } from 'next/server';
import { getWorkspaceAccess } from '@/lib/team/access';
import { roleCan } from '@/lib/team/permissions';
import { processAutomationOutbox } from '@/lib/automation/outbox';
import { assertWorkspaceFeature, assertWorkspaceLimit } from '@/lib/plans/enforce';
import {
  hasErrors,
  toStoredAction,
  toStoredRule,
  validateMacroDraft,
  validateRuleDraft,
  type MacroDraft,
  type RuleDraft,
  type RuleKind,
  type RuleRow,
  type RuleAction,
} from '@/lib/automation/rules';
import { userError } from '@/lib/errors/user-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Result<T> = ({ success: true } & T) | { success: false; error: string };

function fail(error: unknown, fallback: string): { success: false; error: string } {
  const message = (error as { message?: string } | null)?.message || fallback;
  console.error('[Automation Error]:', message);
  return { success: false, error: message };
}

function checkId(id: string, what: string) {
  if (!UUID.test(id || '')) throw userError(`${what} was not found.`);
}

export interface MacroRow {
  id: string;
  title: string;
  content: string;
  actions: RuleAction[];
  is_active: boolean;
  owner_id: string | null;
  position: number;
}

export interface AutomationBootstrap {
  rules: RuleRow[];
  macros: MacroRow[];
  groups: { id: string; name: string }[];
  people: { id: string; name: string }[];
  me: string;
  /** Owners and admins may create shared macros. */
  canShare: boolean;
}

/**
 * Everything the Automation pages need in one round trip. Rules are for
 * owners and admins; the macros page is also open to agents, who manage
 * their own personal macros there.
 */
export async function getAutomationBootstrapAction(workspaceId: string, scope: 'rules' | 'macros' = 'rules'): Promise<Result<{ data: AutomationBootstrap }>> {
  try {
    const { supabase, user, role } = await getWorkspaceAccess(workspaceId, scope === 'rules' ? 'manage_settings' : 'reply');
    const [rules, macros, groups, people] = await Promise.all([
      scope === 'rules'
        ? supabase.from('automation_rules').select('*').eq('workspace_id', workspaceId).order('position').order('created_at')
        : Promise.resolve({ data: [], error: null }),
      supabase.from('macros').select('id, title, content, actions, is_active, owner_id, position').eq('workspace_id', workspaceId).order('position').order('title'),
      supabase.from('ticket_groups').select('id, name').eq('workspace_id', workspaceId).order('name'),
      supabase.from('agents').select('id, name').eq('workspace_id', workspaceId).eq('is_active', true).order('name'),
    ]);
    const failed = rules.error || macros.error || groups.error || people.error;
    if (failed) return fail(failed, 'Could not load automation settings.');
    return {
      success: true,
      data: {
        rules: (rules.data || []) as RuleRow[],
        macros: (macros.data || []) as MacroRow[],
        groups: (groups.data || []) as { id: string; name: string }[],
        people: ((people.data || []) as { id: string; name: string | null }[]).map((p) => ({ id: p.id, name: p.name || 'Unnamed' })),
        me: user.id,
        canShare: roleCan(role, 'manage_settings'),
      },
    };
  } catch (e) {
    return fail(e, 'Could not load automation settings.');
  }
}

/* ── Rules ─────────────────────────────────────────────────────────────── */

export async function saveRuleAction(workspaceId: string, draft: RuleDraft): Promise<Result<{ rule: RuleRow }>> {
  try {
    const { supabase, user } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    await assertWorkspaceFeature(workspaceId, 'automations');
    if (!draft.id) {
      await assertWorkspaceLimit(workspaceId, 'max_automations');
    }
    const errors = validateRuleDraft(draft);
    if (hasErrors(errors)) {
      const first = errors.name || errors.form || Object.values(errors.conditions)[0] || Object.values(errors.actions)[0];
      return { success: false, error: first || 'Check the rule and try again.' };
    }
    const stored = toStoredRule(draft);
    if (draft.id) {
      checkId(draft.id, 'That rule');
      const { data, error } = await supabase
        .from('automation_rules')
        .update(stored)
        .eq('workspace_id', workspaceId)
        .eq('id', draft.id)
        .select('*')
        .maybeSingle();
      if (error || !data) return fail(error, 'Rule not found.');
      return { success: true, rule: data as RuleRow };
    }
    const { data: last } = await supabase
      .from('automation_rules')
      .select('position')
      .eq('workspace_id', workspaceId)
      .eq('kind', draft.kind)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data, error } = await supabase
      .from('automation_rules')
      .insert({ ...stored, workspace_id: workspaceId, position: ((last?.position as number | undefined) ?? 0) + 1, created_by: user.id })
      .select('*')
      .single();
    if (error) return fail(error, 'Could not save the rule.');
    return { success: true, rule: data as RuleRow };
  } catch (e) {
    return fail(e, 'Could not save the rule.');
  }
}

export async function setRuleActiveAction(workspaceId: string, ruleId: string, active: boolean): Promise<Result<{ rule: RuleRow }>> {
  try {
    checkId(ruleId, 'That rule');
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const { data, error } = await supabase
      .from('automation_rules')
      .update({ is_active: Boolean(active) })
      .eq('workspace_id', workspaceId)
      .eq('id', ruleId)
      .select('*')
      .maybeSingle();
    if (error || !data) return fail(error, 'Rule not found.');
    return { success: true, rule: data as RuleRow };
  } catch (e) {
    return fail(e, 'Could not update the rule.');
  }
}

export async function deleteRuleAction(workspaceId: string, ruleId: string): Promise<Result<object>> {
  try {
    checkId(ruleId, 'That rule');
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const { error } = await supabase.from('automation_rules').delete().eq('workspace_id', workspaceId).eq('id', ruleId);
    return error ? fail(error, 'Could not delete the rule.') : { success: true };
  } catch (e) {
    return fail(e, 'Could not delete the rule.');
  }
}

export async function reorderRulesAction(workspaceId: string, kind: RuleKind, ids: string[]): Promise<Result<object>> {
  try {
    if (kind !== 'trigger' && kind !== 'automation') throw userError('Unknown rule type.');
    ids.forEach((id) => checkId(id, 'A rule'));
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const { error } = await supabase.rpc('fn_reorder_rules', { p_workspace_id: workspaceId, p_kind: kind, p_ids: ids });
    return error ? fail(error, 'Could not reorder the rules.') : { success: true };
  } catch (e) {
    return fail(e, 'Could not reorder the rules.');
  }
}

export interface RuleTestResult {
  ticket: { number: number; subject: string; status: string };
  matches: boolean;
  conditions: { condition: { field: string; op: string }; holds: boolean; assumed: boolean }[];
  actions: { type: string; value: unknown }[];
  email_previews: { type: string; subject: string; body: string }[];
}

/** Dry run against a real ticket: nothing is changed or sent. */
export async function testRuleAction(workspaceId: string, draft: RuleDraft, ticketNumber: number): Promise<Result<{ result: RuleTestResult }>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    if (!Number.isInteger(ticketNumber) || ticketNumber < 1) return { success: false, error: 'Enter a ticket number, such as 1001.' };
    const errors = validateRuleDraft(draft);
    if (hasErrors(errors)) return { success: false, error: errors.form || Object.values(errors.conditions)[0] || Object.values(errors.actions)[0] || 'Fix the rule first.' };
    const stored = toStoredRule(draft);
    const { data, error } = await supabase.rpc('fn_test_rule', {
      p_workspace_id: workspaceId,
      p_kind: stored.kind,
      p_match: stored.match_mode,
      p_conditions: stored.conditions,
      p_actions: stored.actions,
      p_ticket_number: ticketNumber,
    });
    if (error) return fail(error, 'The test could not run.');
    return { success: true, result: data as RuleTestResult };
  } catch (e) {
    return fail(e, 'The test could not run.');
  }
}

/** For workspaces created before the defaults existed: adds them if there are no rules yet. */
export async function installDefaultRulesAction(workspaceId: string): Promise<Result<object>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const { error } = await supabase.rpc('fn_install_default_automation', { p_workspace_id: workspaceId });
    return error ? fail(error, 'Could not add the recommended rules.') : { success: true };
  } catch (e) {
    return fail(e, 'Could not add the recommended rules.');
  }
}

/* ── The log ───────────────────────────────────────────────────────────── */

export interface RuleRunRow {
  id: string;
  rule_name: string;
  kind: RuleKind;
  event: string;
  outcome: 'fired' | 'failed' | 'skipped_loop';
  summary: { type: string; value: unknown }[];
  error: string | null;
  created_at: string;
  ticket_id: string;
  ticket: { number: number; subject: string } | null;
}

const LOG_PAGE = 30;

export async function getRuleLogAction(
  workspaceId: string,
  opts: { ticketNumber?: number | null; before?: string | null } = {}
): Promise<Result<{ runs: RuleRunRow[]; hasMore: boolean }>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    let ticketId: string | null = null;
    if (opts.ticketNumber) {
      const { data: t } = await supabase.from('tickets').select('id').eq('workspace_id', workspaceId).eq('number', opts.ticketNumber).maybeSingle();
      if (!t) return { success: true, runs: [], hasMore: false };
      ticketId = t.id as string;
    }
    let query = supabase
      .from('automation_rule_runs')
      .select('id, rule_name, kind, event, outcome, summary, error, created_at, ticket_id, tickets(number, subject)')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(LOG_PAGE + 1);
    if (ticketId) query = query.eq('ticket_id', ticketId);
    if (opts.before) query = query.lt('created_at', opts.before);
    const { data, error } = await query;
    if (error) return fail(error, 'Could not load the rule log.');
    const rows = ((data || []) as unknown as (Omit<RuleRunRow, 'ticket'> & { tickets: RuleRunRow['ticket'] | RuleRunRow['ticket'][] })[]).map(({ tickets, ...rest }) => ({
      ...rest,
      ticket: Array.isArray(tickets) ? tickets[0] ?? null : tickets,
    }));
    return { success: true, runs: rows.slice(0, LOG_PAGE), hasMore: rows.length > LOG_PAGE };
  } catch (e) {
    return fail(e, 'Could not load the rule log.');
  }
}

/* ── Macros ────────────────────────────────────────────────────────────── */

/** Macros the caller may use: shared ones and their own, active only. For the reply box. */
export async function listMacrosAction(workspaceId: string): Promise<Result<{ macros: MacroRow[] }>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'view');
    const { data, error } = await supabase
      .from('macros')
      .select('id, title, content, actions, is_active, owner_id, position')
      .eq('workspace_id', workspaceId)
      .eq('is_active', true)
      .order('position')
      .order('title');
    if (error) return fail(error, 'Could not load macros.');
    return { success: true, macros: (data || []) as MacroRow[] };
  } catch (e) {
    return fail(e, 'Could not load macros.');
  }
}

export async function saveMacroAction(workspaceId: string, draft: MacroDraft): Promise<Result<{ macro: MacroRow }>> {
  try {
    const { supabase, user } = await getWorkspaceAccess(workspaceId, 'reply');
    await assertWorkspaceFeature(workspaceId, 'macros');
    const errors = validateMacroDraft(draft);
    const first = errors.title || errors.content || Object.values(errors.actions)[0];
    if (first) return { success: false, error: first };
    const fields = {
      title: draft.title.trim(),
      content: draft.content,
      actions: draft.actions.map(toStoredAction),
      is_active: draft.is_active,
    };
    if (draft.id) {
      checkId(draft.id, 'That macro');
      // Sharing cannot change after creation: moving a macro between personal and
      // shared would silently hand someone's private text to the team.
      const { data, error } = await supabase
        .from('macros')
        .update(fields)
        .eq('workspace_id', workspaceId)
        .eq('id', draft.id)
        .select('id, title, content, actions, is_active, owner_id, position')
        .maybeSingle();
      if (error || !data) return fail(error, 'Macro not found, or you cannot edit it.');
      return { success: true, macro: data as MacroRow };
    }
    const { data, error } = await supabase
      .from('macros')
      .insert({ ...fields, workspace_id: workspaceId, owner_id: draft.shared ? null : user.id, created_by: user.id })
      .select('id, title, content, actions, is_active, owner_id, position')
      .single();
    if (error) return fail(error, 'Could not save the macro.');
    return { success: true, macro: data as MacroRow };
  } catch (e) {
    return fail(e, 'Could not save the macro.');
  }
}

export async function deleteMacroAction(workspaceId: string, macroId: string): Promise<Result<object>> {
  try {
    checkId(macroId, 'That macro');
    const { supabase } = await getWorkspaceAccess(workspaceId, 'reply');
    const { error } = await supabase.from('macros').delete().eq('workspace_id', workspaceId).eq('id', macroId);
    return error ? fail(error, 'Could not delete the macro.') : { success: true };
  } catch (e) {
    return fail(e, 'Could not delete the macro.');
  }
}

/** The macro's reply with placeholders filled in for this ticket and the signed-in agent. */
export async function renderMacroAction(workspaceId: string, ticketId: string, macroId: string): Promise<Result<{ text: string }>> {
  try {
    checkId(ticketId, 'That ticket');
    checkId(macroId, 'That macro');
    const { supabase } = await getWorkspaceAccess(workspaceId, 'add_note');
    // The function checks the ticket belongs to this workspace; this call is also
    // refused if the ticket is in another one (the RPC reads it through the caller's role).
    const { data, error } = await supabase.rpc('fn_render_macro', { p_macro_id: macroId, p_ticket_id: ticketId });
    if (error) return fail(error, 'Could not fill in the macro.');
    return { success: true, text: String(data ?? '') };
  } catch (e) {
    return fail(e, 'Could not fill in the macro.');
  }
}

/** Applies the macro's field changes (status, priority, tags, assignee) as the signed-in agent. */
export async function applyMacroAction(workspaceId: string, ticketId: string, macroId: string): Promise<Result<{ changed: boolean }>> {
  try {
    checkId(ticketId, 'That ticket');
    checkId(macroId, 'That macro');
    const { supabase } = await getWorkspaceAccess(workspaceId, 'edit_ticket');
    const { data, error } = await supabase.rpc('fn_apply_macro', { p_macro_id: macroId, p_ticket_id: ticketId });
    if (error) return fail(error, 'The macro could not be applied.');
    after(() => processAutomationOutbox({ workspaceId, limit: 10 }).catch((e) => console.error('[Automation Outbox Error]:', e)));
    return { success: true, changed: Boolean((data as { changed?: boolean } | null)?.changed) };
  } catch (e) {
    return fail(e, 'The macro could not be applied.');
  }
}

/** Sends anything queued for this workspace by rules; called after agents change tickets. */
export async function drainAutomationOutboxAction(workspaceId: string): Promise<void> {
  try {
    await getWorkspaceAccess(workspaceId, 'view');
    after(() => processAutomationOutbox({ workspaceId, limit: 10 }).catch((e) => console.error('[Automation Outbox Error]:', e)));
  } catch {
    // Not a member: nothing to send.
  }
}
