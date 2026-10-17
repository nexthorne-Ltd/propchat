'use server';

/**
 * Settings → Workspace, Notifications and the audit log.
 *
 * Workspace edits need `manage_settings` (owner/admin). Notification
 * preferences belong to whoever is signed in, so they only need membership.
 * The audit log is read-only here: the database triggers in
 * 20261013090000_settings_hub.sql write it, so no action can forge an entry.
 */

import { getWorkspaceAccess } from '@/lib/team/access';
import { assertSettingNotLocked } from '@/lib/settings/precedence';
import {
  normalizeNotificationPrefs,
  validateWorkspaceGeneral,
  type NotificationPrefs,
  type WorkspaceGeneralInput,
} from '@/lib/settings/validation';
import type { Workspace, CsatSettingsConfig } from '@/types/database';

export async function updateWorkspaceGeneralAction(workspaceId: string, input: WorkspaceGeneralInput) {
  await assertSettingNotLocked(workspaceId, 'workspace_general');
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');

  const errors = validateWorkspaceGeneral(input);
  const first = Object.values(errors)[0];
  if (first) return { success: false as const, error: first, fieldErrors: errors };

  const { data, error } = await supabase
    .from('workspaces')
    .update({
      name: input.name.trim(),
      logo_url: input.logo_url.trim() || null,
      timezone: input.timezone,
      language: input.language,
    })
    .eq('id', workspaceId)
    .select()
    .single();

  if (error) {
    console.error('[Settings Error]:', error);
    return { success: false as const, error: error.message };
  }
  return { success: true as const, workspace: data as Workspace };
}

export async function getNotificationPrefsAction(workspaceId: string) {
  const { supabase, user } = await getWorkspaceAccess(workspaceId, 'view');
  const { data, error } = await supabase
    .from('agent_notification_preferences')
    .select('email, in_app')
    .eq('workspace_id', workspaceId)
    .eq('agent_id', user.id)
    .maybeSingle();
  if (error) {
    console.error('[Settings Error]:', error);
    return { success: false as const, error: error.message };
  }
  return { success: true as const, prefs: normalizeNotificationPrefs(data) };
}

export async function saveNotificationPrefsAction(workspaceId: string, prefs: NotificationPrefs) {
  const { supabase, user } = await getWorkspaceAccess(workspaceId, 'view');
  const clean = normalizeNotificationPrefs(prefs);
  const { error } = await supabase.from('agent_notification_preferences').upsert(
    {
      agent_id: user.id,
      workspace_id: workspaceId,
      email: clean.email,
      in_app: clean.in_app,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'agent_id,workspace_id' }
  );
  if (error) {
    console.error('[Settings Error]:', error);
    return { success: false as const, error: error.message };
  }
  return { success: true as const, prefs: clean };
}

export interface AuditEntry {
  id: string;
  actor_name: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

const AUDIT_PAGE = 25;

/** Newest first; pass the last row's `created_at` as `before` for the next page. */
export async function getAuditLogAction(workspaceId: string, before?: string | null) {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  let query = supabase
    .from('workspace_audit_logs')
    .select('id, actor_name, action, target, details, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(AUDIT_PAGE + 1);
  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) {
    console.error('[Settings Error]:', error);
    return { success: false as const, error: error.message };
  }
  const rows = (data || []) as AuditEntry[];
  return { success: true as const, entries: rows.slice(0, AUDIT_PAGE), hasMore: rows.length > AUDIT_PAGE };
}

export async function updateCsatSettingsAction(workspaceId: string, settings: CsatSettingsConfig) {
  await assertSettingNotLocked(workspaceId, 'csat');
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const clean: CsatSettingsConfig = {
    enabled: Boolean(settings.enabled),
    ask_chat: Boolean(settings.ask_chat),
    ask_email: Boolean(settings.ask_email),
    survey_prompt: (settings.survey_prompt || 'How would you rate the support you received?').trim().slice(0, 300),
  };

  const { data, error } = await supabase
    .from('workspaces')
    .update({ csat_settings: clean })
    .eq('id', workspaceId)
    .select()
    .single();

  if (error) {
    console.error('[CSAT Settings Error]:', error);
    return { success: false as const, error: error.message };
  }
  return { success: true as const, workspace: data as Workspace };
}

