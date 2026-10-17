/**
 * Emails the team that a customer is waiting for a person: when the bot hands
 * a conversation over, and when a customer writes again in a conversation a
 * person is handling. Sent through the workspace's own SMTP, so it comes from
 * the business's address, or the platform's SMTP when the workspace has none
 * (a new workspace's handovers used to reach nobody).
 *
 * Who gets it is decided by pickRecipients (shifts.ts): with shift hours set,
 * only the people on shift. Each person gets at most one email per
 * conversation every THROTTLE_MINUTES, so a customer typing five short lines
 * is one alert.
 *
 * Never throws: an email problem must not affect the chat. Results are written
 * to team_email_log.
 */
import { serviceClient } from '@/lib/supabase/service';
import { sendSmtpEmail } from '@/lib/email/smtp';
import { teamAlertEmail, type TeamAlertEvent } from '@/lib/email/team-emails';
import { normalizeNotificationPrefs } from '@/lib/settings/validation';
import { localWeekMinute, pickRecipients, type Shift, type ShiftMember } from './shifts';
import { loadTeamAlertSmtp } from '@/lib/email/workspace-smtp';
import { getRequestOrigin } from '@/lib/request-origin';

const THROTTLE_MINUTES = 10;

export interface TeamAlertResult {
  sent: string[];
  skipped?: string;
  reason?: string;
}

async function appUrl(): Promise<string> {
  return getRequestOrigin();
}

export async function notifyTeamByEmail(input: {
  workspaceId: string;
  conversationId: string;
  event: TeamAlertEvent;
  /** The customer's latest words, shown in the email. */
  preview?: string | null;
  reason?: string | null;
}): Promise<TeamAlertResult> {
  try {
    const supabase = serviceClient();
    const [{ data: ws }, { data: conv }] = await Promise.all([
      supabase
        .from('workspaces')
        .select('id, name, owner_id, timezone, business_hours, brand_color')
        .eq('id', input.workspaceId)
        .maybeSingle(),
      supabase
        .from('conversations')
        .select('id, workspace_id, assigned_agent_id, visitor:visitors(name, email)')
        .eq('id', input.conversationId)
        .maybeSingle(),
    ]);
    // The conversation must belong to the workspace: both ids come from callers.
    if (!ws || !conv || conv.workspace_id !== input.workspaceId) return { sent: [], skipped: 'not_found' };
    // The workspace's SMTP, or the platform's when it has none.
    const mailer = await loadTeamAlertSmtp(input.workspaceId);
    if (!mailer) return { sent: [], skipped: 'no_smtp' };
    const smtp = mailer.smtp;

    const [{ data: agents }, { data: shifts }, { data: prefs }] = await Promise.all([
      supabase.from('agents').select('id, email, role, is_active').eq('workspace_id', input.workspaceId),
      supabase.from('agent_shifts').select('agent_id, weekday, start_minute, end_minute').eq('workspace_id', input.workspaceId),
      supabase.from('agent_notification_preferences').select('agent_id, email').eq('workspace_id', input.workspaceId),
    ]);

    const shiftsBy = new Map<string, Shift[]>();
    for (const s of (shifts as (Shift & { agent_id: string })[] | null) || []) {
      shiftsBy.set(s.agent_id, [...(shiftsBy.get(s.agent_id) || []), s]);
    }
    const prefsBy = new Map(
      ((prefs as { agent_id: string; email: unknown }[] | null) || []).map((p) => [p.agent_id, normalizeNotificationPrefs({ email: p.email })])
    );

    type AgentRow = { id: string; email: string | null; role: string | null; is_active: boolean | null };
    const rows = ((agents as AgentRow[] | null) || []).map((a) => ({
      ...a,
      role: a.id === ws.owner_id ? 'owner' : a.role || 'agent',
    }));
    const members: ShiftMember[] = rows.map((a) => ({
      id: a.id,
      email: a.email,
      role: a.role,
      is_active: a.is_active !== false,
      wants_email: (prefsBy.get(a.id)?.email[input.event] ?? true) !== false,
      shifts: shiftsBy.get(a.id) || [],
    }));

    const timeZone = (ws.timezone as string | null) || (ws.business_hours as { timezone?: string } | null)?.timezone || 'UTC';
    const choice = pickRecipients({
      members,
      assigneeId: (conv.assigned_agent_id as string | null) ?? null,
      fallbackIds: rows.filter((a) => a.role === 'owner' || a.role === 'admin').map((a) => a.id),
      at: localWeekMinute(new Date(), timeZone),
    });
    if (!choice.ids.length) return { sent: [], skipped: 'no_recipients', reason: choice.reason };

    // Who was already told about this conversation a moment ago.
    const since = new Date(Date.now() - THROTTLE_MINUTES * 60_000).toISOString();
    const { data: recent } = await supabase
      .from('team_email_log')
      .select('agent_id')
      .eq('conversation_id', input.conversationId)
      .eq('status', 'sent')
      .gte('created_at', since);
    const recentlyTold = new Set(((recent as { agent_id: string }[] | null) || []).map((r) => r.agent_id));

    let preview = input.preview || '';
    if (!preview) {
      const { data: last } = await supabase
        .from('messages')
        .select('content')
        .eq('conversation_id', input.conversationId)
        .eq('sender_type', 'visitor')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      preview = (last?.content as string | null) || '';
    }

    const visitor = (Array.isArray(conv.visitor) ? conv.visitor[0] : conv.visitor) as { name?: string | null; email?: string | null } | null;
    const visitorName = visitor?.name?.trim() || visitor?.email?.trim() || 'A customer';
    const email = teamAlertEmail({
      event: input.event,
      workspaceName: (ws.name as string) || 'Support',
      brandColor: ws.brand_color as string | null,
      visitorName,
      preview,
      reason: input.reason,
      conversationUrl: `${await appUrl()}/dashboard?conversation=${input.conversationId}`,
      onShift: choice.reason === 'on_shift' || choice.reason === 'assignee_on_shift',
    });

    const sent: string[] = [];
    for (const id of choice.ids) {
      if (recentlyTold.has(id)) continue;
      const to = members.find((m) => m.id === id)?.email;
      if (!to) continue;
      const result = await sendSmtpEmail(smtp, {
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
      const { error: logError } = await supabase.from('team_email_log').insert({
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        agent_id: id,
        email: to,
        event: input.event,
        status: result.success ? 'sent' : 'failed',
        error: result.success ? null : (result.error || 'Failed').slice(0, 500),
      });
      if (logError) console.error('[Team Email] Could not log the alert:', logError.message);
      if (result.success) sent.push(id);
      else console.error('[Team Email] Alert failed:', to, result.error);
    }
    return { sent, reason: choice.reason };
  } catch (err) {
    console.error('[Team Email] Alert crashed:', err);
    return { sent: [], skipped: 'error' };
  }
}

/**
 * Sends the alert after the response, so the chat never waits on SMTP. Uses
 * after() (a serverless function is frozen once it responds, which would cut
 * a fire-and-forget send off); outside a request it just runs.
 */
export function notifyTeamByEmailLater(input: Parameters<typeof notifyTeamByEmail>[0]): void {
  const task = () => notifyTeamByEmail(input).then(() => undefined);
  import('next/server')
    .then(({ after }) => {
      try {
        after(task);
      } catch {
        void task();
      }
    })
    .catch(() => void task());
}
