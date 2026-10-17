'use server';

/**
 * Team and group management (Settings → Team members & roles, Groups &
 * routing). Owners and admins only.
 *
 * Role changes, capacity, deactivation and group membership go through the
 * database functions in supabase/migrations/20261010090000_teams_and_roles.sql,
 * which check the caller again and apply the rules (only the owner manages
 * admins, nobody changes themselves, the owner is untouchable). Inviting needs
 * the service role, to create the sign-in account, so it repeats those checks
 * here before doing anything.
 */

import { createHash, randomBytes } from 'node:crypto';
import { getWorkspaceAccess, type WorkspaceAccess } from '@/lib/team/access';
import { hasServiceRole, serviceClient } from '@/lib/supabase/service';
import { ROLE_LABELS, assignableRoles, isRole, type Role } from '@/lib/team/permissions';
import { assertWorkspaceLimit } from '@/lib/plans/enforce';
import { getEffectiveFromEmail, sendSmtpEmail } from '@/lib/email/smtp';
import { inviteEmail } from '@/lib/email/team-emails';
import { loadWorkspaceSmtp } from '@/lib/email/workspace-smtp';
import { validateShifts, type Shift } from '@/lib/team/shifts';
import { userError } from '@/lib/errors/user-error';
import { getRequestOrigin } from '@/lib/request-origin';
import type { TicketGroup } from '@/types/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  role: Role;
  status: 'online' | 'away' | 'offline';
  is_active: boolean;
  deactivated_at: string | null;
  max_open_tickets: number | null;
  open_tickets: number;
  group_ids: string[];
  /** Weekly shift hours in the workspace timezone; empty = no limit on team emails. */
  shifts: Shift[];
}

/** An invitation that has not been accepted or revoked yet. */
export interface PendingInvitation {
  id: string;
  email: string;
  name: string;
  role: Role;
  created_at: string;
  expires_at: string;
  last_sent_at: string | null;
  send_error: string | null;
}

export interface TeamGroup extends TicketGroup {
  round_robin: boolean;
  member_ids: string[];
}

export interface TeamData {
  me: { id: string; role: Role };
  members: TeamMember[];
  groups: TeamGroup[];
  invitations: PendingInvitation[];
  /** The workspace timezone shift hours are in. */
  timezone: string;
  /** Whether team emails can be sent, and from which address. */
  mail: { ready: boolean; from: string | null };
}

function dbError(error: { message?: string } | null | undefined, fallback: string): Error {
  return userError(error?.message || fallback);
}

function checkId(id: string, what = 'That person') {
  if (!UUID.test(id || '')) throw userError(`${what} was not found.`);
}

async function loadTeam(access: WorkspaceAccess, workspaceId: string): Promise<TeamData> {
  const { supabase } = access;
  const [{ data: agents, error }, { data: groups }, { data: memberships }, { data: open }, { data: shifts }, { data: invites }, ws] = await Promise.all([
    supabase
      .from('agents')
      .select('id, name, email, avatar_url, role, status, is_active, deactivated_at, max_open_tickets')
      .eq('workspace_id', workspaceId)
      .order('name'),
    supabase.from('ticket_groups').select('*').eq('workspace_id', workspaceId).order('name'),
    supabase.from('ticket_group_members').select('group_id, agent_id').eq('workspace_id', workspaceId),
    supabase.from('tickets').select('assignee_id').eq('workspace_id', workspaceId).in('status', ['new', 'open']).not('assignee_id', 'is', null),
    supabase.from('agent_shifts').select('agent_id, weekday, start_minute, end_minute').eq('workspace_id', workspaceId),
    supabase
      .from('workspace_invitations')
      .select('id, email, name, role, created_at, expires_at, last_sent_at, send_error')
      .eq('workspace_id', workspaceId)
      .is('accepted_at', null)
      .is('revoked_at', null)
      .order('created_at', { ascending: false }),
    workspaceMail(workspaceId),
  ]);
  if (error) throw dbError(error, 'Could not load the team.');

  const rows = (memberships as { group_id: string; agent_id: string }[] | null) || [];
  const openCount = new Map<string, number>();
  for (const t of (open as { assignee_id: string }[] | null) || []) {
    openCount.set(t.assignee_id, (openCount.get(t.assignee_id) || 0) + 1);
  }
  const shiftsBy = new Map<string, Shift[]>();
  for (const r of (shifts as (Shift & { agent_id: string })[] | null) || []) {
    shiftsBy.set(r.agent_id, [...(shiftsBy.get(r.agent_id) || []), { weekday: r.weekday, start_minute: r.start_minute, end_minute: r.end_minute }]);
  }
  type AgentRow = Omit<TeamMember, 'open_tickets' | 'group_ids' | 'shifts'>;
  return {
    me: { id: access.user.id, role: access.role },
    members: ((agents as AgentRow[] | null) || []).map((a) => ({
      ...a,
      role: isRole(a.role) ? a.role : 'agent',
      is_active: a.is_active !== false,
      open_tickets: openCount.get(a.id) || 0,
      group_ids: rows.filter((r) => r.agent_id === a.id).map((r) => r.group_id),
      shifts: shiftsBy.get(a.id) || [],
    })),
    groups: ((groups as TicketGroup[] | null) || []).map((g) => ({
      ...(g as TeamGroup),
      round_robin: Boolean((g as TeamGroup).round_robin),
      member_ids: rows.filter((r) => r.group_id === g.id).map((r) => r.agent_id),
    })),
    invitations: ((invites as PendingInvitation[] | null) || []).filter((i) => isRole(i.role)),
    timezone: ws.timezone,
    mail: { ready: ws.ready, from: ws.from },
  };
}

/** The workspace's SMTP (with its server-only password), name and timezone. */
async function workspaceMail(workspaceId: string) {
  const { data } = await serviceClient()
    .from('workspaces')
    .select('name, timezone, business_hours, brand_color, logo_url')
    .eq('id', workspaceId)
    .maybeSingle();
  const smtp = await loadWorkspaceSmtp(workspaceId);
  const ready = Boolean(smtp);
  return {
    name: (data?.name as string) || 'your team',
    brandColor: (data?.brand_color as string | null) ?? null,
    logoUrl: (data?.logo_url as string | null) ?? null,
    timezone: (data?.timezone as string | null) || (data?.business_hours as { timezone?: string } | null)?.timezone || 'UTC',
    smtp: ready ? smtp : null,
    ready,
    from: ready && smtp ? getEffectiveFromEmail(smtp) : null,
  };
}

export async function getTeamAction(workspaceId: string): Promise<TeamData> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_team');
  return loadTeam(access, workspaceId);
}

/* ── Members ──────────────────────────────────────────────────────────── */

const INVITE_DAYS = 7;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function appUrl(): Promise<string> {
  return getRequestOrigin();
}

export interface InviteResult {
  team: TeamData;
  email: string;
  /** False when the workspace has no working SMTP, or the send failed. */
  emailed: boolean;
  /** The accept link, so it can be shared by hand when the email did not go. */
  link: string;
  error?: string;
}

/**
 * Gives an invitation a fresh one-time token and emails the link from the
 * workspace's own SMTP. Only the token's hash is stored, so the link is shown
 * to the inviter now and never again (resending makes a new one).
 */
async function sendInvitation(
  access: WorkspaceAccess,
  workspaceId: string,
  invite: { id: string; email: string; name: string; role: Role }
): Promise<{ emailed: boolean; link: string; error?: string }> {
  const token = randomBytes(32).toString('base64url');
  const origin = await getRequestOrigin();
  const link = `${origin}/invite/${token}`;
  const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();

  // The new hash goes in first: an email must never carry a link that does not work yet.
  const { error: updateError } = await serviceClient()
    .from('workspace_invitations')
    .update({ token_hash: hashToken(token), expires_at: expires })
    .eq('id', invite.id)
    .eq('workspace_id', workspaceId);
  if (updateError) throw dbError(updateError, 'Could not save the invitation.');

  const mail = await workspaceMail(workspaceId);
  let emailed = false;
  let error: string | undefined;
  if (!mail.smtp) {
    error = 'Email is not set up for this workspace (Settings → Channels → SMTP), so nothing was sent. Share the link yourself.';
  } else {
    const { data: inviter } = await access.supabase.from('agents').select('name').eq('id', access.user.id).maybeSingle();
    const content = inviteEmail({
      workspaceName: mail.name,
      brandColor: mail.brandColor,
      logoUrl: mail.logoUrl,
      inviteeName: invite.name,
      inviterName: (inviter?.name as string) || 'Your team',
      roleLabel: ROLE_LABELS[invite.role],
      acceptUrl: link,
      expiresInDays: INVITE_DAYS,
    });
    const sent = await sendSmtpEmail(mail.smtp, { to: invite.email, subject: content.subject, html: content.html, text: content.text });
    emailed = sent.success;
    if (!sent.success) error = `The email could not be sent (${sent.error || 'unknown error'}). Share the link yourself.`;
  }

  const { error: logError } = await serviceClient()
    .from('workspace_invitations')
    .update({ last_sent_at: emailed ? new Date().toISOString() : null, send_error: error ?? null })
    .eq('id', invite.id);
  if (logError) console.error('[Team Invite] Could not record the send:', logError.message);
  return { emailed, link, error };
}

/**
 * Invites someone by email. They get a link from the workspace's own address,
 * choose their own password and join when they accept; no account or agent
 * row is made before that. Inviting someone with an open invitation sends it
 * again with a new link. Someone already working in another workspace is
 * refused rather than moved: an agent belongs to one workspace, and taking
 * them would cut off their other team.
 */
export async function inviteMemberAction(
  workspaceId: string,
  input: { name: string; email: string; role: Role; groupIds?: string[] }
): Promise<InviteResult> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_team');
  await assertWorkspaceLimit(workspaceId, 'max_agents');
  const email = (input.email || '').trim().toLowerCase();
  const name = (input.name || '').trim().slice(0, 120);
  if (!EMAIL.test(email)) throw userError('Enter a valid email address.');
  if (!isRole(input.role) || input.role === 'owner' || !assignableRoles(access.role).includes(input.role)) {
    throw userError(access.role === 'admin' && input.role === 'admin' ? 'Only the owner can invite admins.' : 'Choose a role.');
  }
  if (!hasServiceRole()) throw userError('Inviting needs SUPABASE_SERVICE_ROLE_KEY on the server.');
  const admin = serviceClient();

  const { data: existing } = await admin
    .from('agents')
    .select('id, workspace_id, is_active')
    .ilike('email', email)
    .limit(1)
    .maybeSingle();
  if (existing?.workspace_id === workspaceId) {
    throw userError(
      existing.is_active === false
        ? `${email} was deactivated. Reactivate them from the list instead.`
        : `${email} is already on this team.`
    );
  }
  if (existing?.workspace_id) {
    throw userError(`${email} already works in another workspace. They need to leave it before joining this one.`);
  }

  const groupIds = input.role === 'light_agent' ? [] : (input.groupIds || []).filter((g) => UUID.test(g));
  const fields = { name, role: input.role, group_ids: groupIds, invited_by: access.user.id };
  const { data: open } = await admin
    .from('workspace_invitations')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('email', email)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .maybeSingle();

  let inviteId = open?.id as string | undefined;
  if (inviteId) {
    const { error } = await admin.from('workspace_invitations').update(fields).eq('id', inviteId);
    if (error) throw dbError(error, 'Could not update the invitation.');
  } else {
    // A throwaway hash until sendInvitation sets the one for the real link.
    const { data: created, error } = await admin
      .from('workspace_invitations')
      .insert({ workspace_id: workspaceId, email, ...fields, token_hash: hashToken(randomBytes(32).toString('base64url')) })
      .select('id')
      .single();
    if (error) throw dbError(error, 'Could not create the invitation.');
    inviteId = created.id as string;
  }

  const sent = await sendInvitation(access, workspaceId, { id: inviteId, email, name, role: input.role });
  return { team: await loadTeam(access, workspaceId), email, ...sent };
}

/** Sends a pending invitation again, with a new link (the old one stops working). */
export async function resendInvitationAction(workspaceId: string, invitationId: string): Promise<InviteResult> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_team');
  checkId(invitationId, 'That invitation');
  const { data: invite } = await serviceClient()
    .from('workspace_invitations')
    .select('id, email, name, role')
    .eq('id', invitationId)
    .eq('workspace_id', workspaceId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .maybeSingle();
  if (!invite || !isRole(invite.role)) throw userError('That invitation was not found. It may have been accepted or revoked.');
  if (!assignableRoles(access.role).includes(invite.role as Role)) throw userError('Only the owner can invite admins.');
  const sent = await sendInvitation(access, workspaceId, invite as { id: string; email: string; name: string; role: Role });
  return { team: await loadTeam(access, workspaceId), email: invite.email as string, ...sent };
}

export async function revokeInvitationAction(workspaceId: string, invitationId: string): Promise<TeamData> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_team');
  checkId(invitationId, 'That invitation');
  const { error } = await serviceClient()
    .from('workspace_invitations')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', invitationId)
    .eq('workspace_id', workspaceId)
    .is('accepted_at', null);
  if (error) throw dbError(error, 'Could not revoke the invitation.');
  return loadTeam(access, workspaceId);
}

/* ── Shifts ───────────────────────────────────────────────────────────── */

/** Replaces a member's weekly shift hours. An empty list removes them. */
export async function setMemberShiftsAction(workspaceId: string, agentId: string, shifts: Shift[]): Promise<TeamData> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_team');
  checkId(agentId);
  const clean = (Array.isArray(shifts) ? shifts : []).map((s) => ({
    weekday: Number(s.weekday),
    start_minute: Number(s.start_minute),
    end_minute: Number(s.end_minute),
  }));
  const invalid = validateShifts(clean);
  if (invalid) throw userError(invalid);
  const { error } = await access.supabase.rpc('fn_set_member_shifts', {
    p_workspace_id: workspaceId,
    p_agent_id: agentId,
    p_shifts: clean,
  });
  if (error) throw dbError(error, 'Could not save the shift hours.');
  return loadTeam(access, workspaceId);
}

export async function setMemberRoleAction(workspaceId: string, agentId: string, role: Role): Promise<TeamData> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_team');
  checkId(agentId);
  if (!isRole(role)) throw userError('Choose a role.');
  const { error } = await access.supabase.rpc('fn_set_member_role', { p_workspace_id: workspaceId, p_agent_id: agentId, p_role: role });
  if (error) throw dbError(error, 'Could not change their role.');
  return loadTeam(access, workspaceId);
}

export async function setMemberCapacityAction(workspaceId: string, agentId: string, maxOpen: number | null): Promise<TeamData> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_team');
  checkId(agentId);
  const value = maxOpen === null ? null : Math.round(Number(maxOpen));
  if (value !== null && !(value >= 1 && value <= 1000)) throw userError('Capacity is a number from 1 to 1000, or no limit.');
  const { error } = await access.supabase.rpc('fn_set_member_capacity', {
    p_workspace_id: workspaceId,
    p_agent_id: agentId,
    p_max_open: value,
  });
  if (error) throw dbError(error, 'Could not change their capacity.');
  return loadTeam(access, workspaceId);
}

export type ReassignMode = 'agent' | 'round_robin' | 'unassign';

export async function deactivateMemberAction(
  workspaceId: string,
  agentId: string,
  reassign: { mode: ReassignMode; to?: string | null }
): Promise<{ team: TeamData; moved: number }> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_team');
  checkId(agentId);
  if (!['agent', 'round_robin', 'unassign'].includes(reassign.mode)) throw userError('Choose what happens to their tickets.');
  if (reassign.mode === 'agent') checkId(reassign.to || '', 'The new assignee');
  const { data, error } = await access.supabase.rpc('fn_deactivate_member', {
    p_workspace_id: workspaceId,
    p_agent_id: agentId,
    p_mode: reassign.mode,
    p_reassign_to: reassign.mode === 'agent' ? reassign.to : null,
  });
  if (error) throw dbError(error, 'Could not deactivate them.');
  return { team: await loadTeam(access, workspaceId), moved: Number(data) || 0 };
}

export async function reactivateMemberAction(workspaceId: string, agentId: string): Promise<TeamData> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_team');
  checkId(agentId);
  const { error } = await access.supabase.rpc('fn_reactivate_member', { p_workspace_id: workspaceId, p_agent_id: agentId });
  if (error) throw dbError(error, 'Could not reactivate them.');
  return loadTeam(access, workspaceId);
}

/* ── Groups ───────────────────────────────────────────────────────────── */

export async function createGroupAction(workspaceId: string, input: { name: string; roundRobin?: boolean }): Promise<TeamData> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_groups');
  const name = (input.name || '').trim().slice(0, 60);
  if (!name) throw userError('Give the group a name.');
  const { error } = await access.supabase
    .from('ticket_groups')
    .insert({ workspace_id: workspaceId, name, round_robin: Boolean(input.roundRobin) });
  if (error) throw dbError(error, error.code === '23505' ? 'There is already a group with that name.' : 'Could not create the group.');
  return loadTeam(access, workspaceId);
}

export async function updateGroupAction(
  workspaceId: string,
  groupId: string,
  patch: { name?: string; roundRobin?: boolean }
): Promise<TeamData> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_groups');
  checkId(groupId, 'That group');
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 60);
    if (!name) throw userError('Give the group a name.');
    update.name = name;
  }
  if (patch.roundRobin !== undefined) update.round_robin = Boolean(patch.roundRobin);
  if (Object.keys(update).length) {
    const { error } = await access.supabase.from('ticket_groups').update(update).eq('id', groupId).eq('workspace_id', workspaceId);
    if (error) throw dbError(error, error.code === '23505' ? 'There is already a group with that name.' : 'Could not update the group.');
  }
  return loadTeam(access, workspaceId);
}

export async function deleteGroupAction(workspaceId: string, groupId: string): Promise<TeamData> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_groups');
  checkId(groupId, 'That group');
  const { error } = await access.supabase.from('ticket_groups').delete().eq('id', groupId).eq('workspace_id', workspaceId);
  if (error) throw dbError(error, 'Could not delete the group.');
  return loadTeam(access, workspaceId);
}

export async function setGroupMembersAction(workspaceId: string, groupId: string, agentIds: string[]): Promise<TeamData> {
  const access = await getWorkspaceAccess(workspaceId, 'manage_groups');
  checkId(groupId, 'That group');
  const ids = Array.from(new Set((agentIds || []).filter((id) => UUID.test(id))));
  const { data: group } = await access.supabase.from('ticket_groups').select('id').eq('id', groupId).eq('workspace_id', workspaceId).maybeSingle();
  if (!group) throw userError('That group was not found.');
  const { error } = await access.supabase.rpc('fn_set_group_members', { p_group_id: groupId, p_agent_ids: ids });
  if (error) throw dbError(error, 'Could not update the group’s members.');
  return loadTeam(access, workspaceId);
}
