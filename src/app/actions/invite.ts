'use server';

/**
 * Accepting a team invitation (/invite/<token>). Public: the token is the
 * credential. Everything about the new member (email, workspace, role,
 * groups) comes from the invitation row, never from the browser.
 *
 * Someone whose email already has an account must sign in with it first; the
 * link never sets the password of an existing account, or anyone holding the
 * link could take that account over.
 */

import { createHash } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { serviceClient, hasServiceRole } from '@/lib/supabase/service';
import { checkWorkspaceLimit } from '@/lib/plans/enforce';
import { ROLE_LABELS, isRole, type Role } from '@/lib/team/permissions';
import { errorMessage, userError } from '@/lib/errors/user-error';
import { findAuthUserByEmail } from '@/lib/auth/verification-code';

const MIN_PASSWORD = 8;

type InviteRow = {
  id: string;
  workspace_id: string;
  email: string;
  name: string;
  role: string;
  group_ids: string[] | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

export type InviteProblem = 'invalid' | 'used' | 'revoked' | 'expired';

export interface InvitationView {
  ok: boolean;
  problem?: InviteProblem;
  message?: string;
  email?: string;
  name?: string;
  workspaceName?: string;
  roleLabel?: string;
  /** The account this browser is signed in to, if any. */
  signedInAs?: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

async function loadInvite(token: string): Promise<{ invite: InviteRow | null; problem?: InviteProblem; message?: string }> {
  if (typeof token !== 'string' || token.trim().length < 20) {
    return { invite: null, problem: 'invalid', message: 'This invitation link is not complete. Open the full link from your email.' };
  }
  const { data } = await serviceClient()
    .from('workspace_invitations')
    .select('id, workspace_id, email, name, role, group_ids, expires_at, accepted_at, revoked_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  const invite = data as InviteRow | null;
  if (!invite) {
    return { invite: null, problem: 'invalid', message: 'This invitation link is not valid. It may have been replaced by a newer one; check for a later email.' };
  }
  if (invite.accepted_at) return { invite, problem: 'used', message: 'This invitation has already been accepted. Sign in to continue.' };
  if (invite.revoked_at) return { invite, problem: 'revoked', message: 'This invitation was withdrawn. Ask your team for a new one.' };
  if (Date.parse(invite.expires_at) < Date.now()) {
    return { invite, problem: 'expired', message: 'This invitation has expired. Ask your team to send it again.' };
  }
  return { invite };
}

async function sessionEmail(): Promise<{ id: string; email: string } | null> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return data.user?.email ? { id: data.user.id, email: data.user.email.toLowerCase() } : null;
  } catch {
    return null;
  }
}

/** Whether an auth account exists for this email (paged; the admin API has no lookup by email). */
async function authUserByEmail(email: string): Promise<string | null> {
  const admin = serviceClient();
  const user = await findAuthUserByEmail(admin, email);
  return user ? user.id : null;
}

export async function getInvitationAction(token: string): Promise<InvitationView> {
  try {
    const { invite, problem, message } = await loadInvite(token);
    if (!invite || problem) return { ok: false, problem, message };
    const { data: ws } = await serviceClient().from('workspaces').select('name').eq('id', invite.workspace_id).maybeSingle();
    const me = await sessionEmail();
    return {
      ok: true,
      email: invite.email,
      name: invite.name,
      workspaceName: (ws?.name as string) || 'the workspace',
      roleLabel: isRole(invite.role) ? ROLE_LABELS[invite.role as Role] : 'Agent',
      signedInAs: me?.email ?? null,
    };
  } catch (err: unknown) {
    console.error('[Team Invite] getInvitationAction error:', err);
    return { ok: false, problem: 'invalid', message: errorMessage(err, 'Could not open this invitation.') };
  }
}

export type AcceptResult =
  | { success: true; email: string; needsSignIn: boolean }
  | { success: false; error: string; code?: 'account_exists' | 'wrong_account' | InviteProblem };

export async function acceptInvitationAction(input: { token: string; name: string; password?: string }): Promise<AcceptResult> {
  try {
    if (!hasServiceRole()) {
      console.error('[Team Invite] SUPABASE_SERVICE_ROLE_KEY is not configured');
      return {
        success: false,
        error: 'Server authentication configuration is missing (SUPABASE_SERVICE_ROLE_KEY). Please contact your administrator.',
      };
    }

    const { invite, problem, message } = await loadInvite(input.token);
    if (!invite || problem) return { success: false, error: message || 'This invitation is not valid.', code: problem };
    if (!isRole(invite.role) || invite.role === 'owner') return { success: false, error: 'This invitation is not valid.', code: 'invalid' };

    const name = (input.name || '').trim().slice(0, 120) || invite.name || invite.email.split('@')[0];
    const admin = serviceClient();

    const limit = await checkWorkspaceLimit(invite.workspace_id, 'max_agents');
    if (!limit.allowed) return { success: false, error: 'This team is full on its current plan. Ask the owner to upgrade, then try again.' };

    // Signed in already: join with that account, if it is the invited address.
    const me = await sessionEmail();
    let userId: string;
    let created = false;
    if (me) {
    if (me.email !== invite.email) {
      return {
        success: false,
        code: 'wrong_account',
        error: `You are signed in as ${me.email}, but this invitation is for ${invite.email}. Sign out, then open the link again.`,
      };
    }
    userId = me.id;
  } else {
    const existingId = await authUserByEmail(invite.email);
    if (existingId) {
      return {
        success: false,
        code: 'account_exists',
        error: `${invite.email} already has an account. Sign in with it, then open this link again to join.`,
      };
    }
    const password = input.password || '';
    if (password.length < MIN_PASSWORD) return { success: false, error: `Choose a password of at least ${MIN_PASSWORD} characters.` };
    const { data, error } = await admin.auth.admin.createUser({
      email: invite.email,
      password,
      email_confirm: true,
      user_metadata: { name },
    });
    if (error || !data.user) {
      console.error('[Team Invite] Could not create the account:', error);
      return { success: false, error: error?.message || 'Could not create your account.' };
    }
    userId = data.user.id;
    created = true;
  }

  const { data: agent } = await admin.from('agents').select('workspace_id').eq('id', userId).maybeSingle();
  if (agent?.workspace_id && agent.workspace_id !== invite.workspace_id) {
    return { success: false, error: 'Your account already belongs to another workspace. Leave it before joining this one.' };
  }

  // Claim the invitation; only one acceptance wins.
  const { data: claimed, error: claimError } = await admin
    .from('workspace_invitations')
    .update({ accepted_at: new Date().toISOString(), accepted_by: userId })
    .eq('id', invite.id)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (claimError || !claimed) {
    if (created) await admin.auth.admin.deleteUser(userId).catch(() => {});
    return { success: false, error: 'This invitation was just used or withdrawn.', code: 'used' };
  }

  const { error: agentError } = await admin.from('agents').upsert(
    {
      id: userId,
      workspace_id: invite.workspace_id,
      name,
      email: invite.email,
      role: invite.role,
      status: 'offline',
      is_active: true,
      deactivated_at: null,
    },
    { onConflict: 'id' }
  );
  if (agentError) {
    console.error('[Team Invite] Could not add the member:', agentError);
    await admin.from('workspace_invitations').update({ accepted_at: null, accepted_by: null }).eq('id', invite.id);
    if (created) await admin.auth.admin.deleteUser(userId).catch(() => {});
    return { success: false, error: 'Could not add you to the team. Try again in a moment.' };
  }

  // Groups chosen when inviting, if they still exist in this workspace.
  const groupIds = invite.role === 'light_agent' ? [] : invite.group_ids || [];
  if (groupIds.length) {
    const { data: groups } = await admin.from('ticket_groups').select('id').eq('workspace_id', invite.workspace_id).in('id', groupIds);
    const rows = ((groups as { id: string }[] | null) || []).map((g) => ({ group_id: g.id, agent_id: userId, workspace_id: invite.workspace_id }));
    if (rows.length) {
      const { error } = await admin.from('ticket_group_members').insert(rows);
      if (error) console.error('[Team Invite] Could not add the member to groups:', error.message);
    }
  }

  return { success: true, email: invite.email, needsSignIn: created };
  } catch (err: unknown) {
    console.error('[Team Invite] acceptInvitationAction error:', err);
    return {
      success: false,
      error: errorMessage(err, 'Could not accept this invitation. Please try again or contact your administrator.'),
    };
  }
}
