import { serviceClient } from '@/lib/supabase/service';
import type { SMTPSettingsConfig } from '@/types/database';

/**
 * A workspace's SMTP settings with the password, for sending. Server only.
 *
 * The password is not in workspaces.smtp_settings any more (a trigger moves it
 * to workspace_secrets so it never reaches a member's browser; migration
 * 20261104090000). Before that migration has run the table does not exist and
 * the password is still in the JSON, so both places are read.
 *
 * Returns null when SMTP is off or incomplete: the caller's cue to skip.
 */
export async function loadWorkspaceSmtp(workspaceId: string): Promise<SMTPSettingsConfig | null> {
  const admin = serviceClient();
  const [{ data: ws }, secret] = await Promise.all([
    admin.from('workspaces').select('smtp_settings').eq('id', workspaceId).maybeSingle(),
    admin.from('workspace_secrets').select('smtp_pass').eq('workspace_id', workspaceId).maybeSingle(),
  ]);
  const settings = (ws?.smtp_settings as (SMTPSettingsConfig & { has_pass?: boolean }) | null) ?? null;
  if (!settings) return null;
  const pass = (secret.data?.smtp_pass as string | null | undefined) || settings.pass || '';
  const merged: SMTPSettingsConfig = { ...settings, pass };
  return isSmtpReady(merged) ? merged : null;
}

export function isSmtpReady(smtp: SMTPSettingsConfig | null | undefined): smtp is SMTPSettingsConfig {
  return Boolean(smtp?.enabled && smtp.host && smtp.user && smtp.pass);
}


/** The stored SMTP password whether or not SMTP is switched on (for "Test connection"). */
export async function storedSmtpPassword(workspaceId: string): Promise<string> {
  const admin = serviceClient();
  const [{ data: secret }, { data: ws }] = await Promise.all([
    admin.from('workspace_secrets').select('smtp_pass').eq('workspace_id', workspaceId).maybeSingle(),
    admin.from('workspaces').select('smtp_settings').eq('id', workspaceId).maybeSingle(),
  ]);
  return (secret?.smtp_pass as string | null) || ((ws?.smtp_settings as { pass?: string } | null)?.pass ?? '');
}

/** The platform's own SMTP (Super admin → Settings), with its password. */
export async function loadPlatformSmtp(): Promise<SMTPSettingsConfig | null> {
  const { data } = await serviceClient().from('platform_settings').select('smtp_settings').eq('id', 'default').maybeSingle();
  const smtp = (data?.smtp_settings as SMTPSettingsConfig | null) ?? null;
  return isSmtpReady(smtp) ? smtp : null;
}

/**
 * How to email a workspace's own team (handover alerts, a customer waiting):
 * the workspace's SMTP when it has one, so the alert comes from the business,
 * otherwise the platform's. Team alerts used to be skipped entirely without
 * workspace SMTP, so a bot handover in a new workspace reached nobody.
 */
export async function loadTeamAlertSmtp(workspaceId: string): Promise<{ smtp: SMTPSettingsConfig; source: 'workspace' | 'platform' } | null> {
  const own = await loadWorkspaceSmtp(workspaceId);
  if (own) return { smtp: own, source: 'workspace' };
  const platform = await loadPlatformSmtp();
  return platform ? { smtp: platform, source: 'platform' } : null;
}
