/**
 * The one check every server action and agent-facing API route makes before
 * touching workspace data: who is calling, are they an active member of this
 * workspace, and does their role allow `capability`.
 *
 * The database enforces the same rules (fn_workspace_role / fn_role_can); this
 * refuses early, with a readable message, and covers service-role code paths
 * that bypass row level security.
 */
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { type Capability, type Role, isRole, roleCan, ROLE_LABELS } from './permissions';
import { markUserFacing } from '@/lib/errors/user-error';
import { sessionUser } from '@/lib/supabase/session-user';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MemberRow {
  id: string;
  name?: string | null;
  role: string | null;
  workspace_id: string | null;
  is_super_admin?: boolean | null;
  is_active?: boolean | null;
}

/** Mirrors fn_workspace_role. */
export function resolveWorkspaceRole(
  userId: string,
  agent: MemberRow | null | undefined,
  workspace: { id: string; owner_id: string | null } | null | undefined,
  workspaceId: string
): Role | null {
  if (!workspace || workspace.id !== workspaceId) {
    // Unknown workspace: only a super admin's view of it would matter, and they need it to exist.
    return null;
  }
  if (workspace.owner_id === userId) return 'owner';
  if (!agent || agent.id !== userId || agent.is_active === false) return null;
  if (agent.workspace_id === workspaceId && isRole(agent.role)) return agent.role;
  if (agent.is_super_admin) return 'admin';
  return null;
}

export class AccessError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403
  ) {
    super(message);
    // Shown to the person in production too (server actions mask other errors).
    markUserFacing(this);
  }
}

const CAPABILITY_TEXT: Record<Capability, string> = {
  view: 'view this workspace',
  add_note: 'add internal notes',
  reply: 'reply to customers',
  edit_ticket: 'change tickets',
  edit_content: 'change workspace content',
  manage_groups: 'manage groups',
  manage_team: 'manage the team',
  manage_settings: 'change workspace settings',
};

export async function getWorkspaceAccess(workspaceId: string, capability: Capability = 'view') {
  if (!UUID.test(workspaceId || '')) throw new AccessError('Unknown workspace.', 403);
  const supabase = await createClient();
  const user = await sessionUser(supabase);
  if (!user) throw new AccessError('Unauthorized: sign in again.', 401);

  const [{ data: agent }, { data: workspace }] = await Promise.all([
    supabase.from('agents').select('id, name, role, workspace_id, is_super_admin, is_active').eq('id', user.id).maybeSingle(),
    supabase.from('workspaces').select('id, owner_id, is_suspended, deleted_at').eq('id', workspaceId).maybeSingle(),
  ]);
  const role = resolveWorkspaceRole(user.id, agent as MemberRow | null, workspace, workspaceId);
  if (!role) {
    if (agent && (agent as MemberRow).is_active === false && (agent as MemberRow).workspace_id === workspaceId) {
      throw new AccessError('Forbidden: your account has been deactivated.', 403);
    }
    throw new AccessError('Forbidden: this workspace is not yours.', 403);
  }
  if (workspace?.deleted_at || workspace?.is_suspended) {
    const adminClient = serviceClient();
    const { data: access } = await adminClient
      .from('platform_access')
      .select('role')
      .eq('user_id', user.id)
      .maybeSingle();
    const isSuperAdmin = Boolean(access && ['owner', 'admin'].includes(access.role));
    if (!isSuperAdmin) {
      if (workspace?.deleted_at) {
        throw new AccessError('This workspace was deleted.', 403);
      }
      if (workspace?.is_suspended) {
        throw new AccessError('This workspace is suspended.', 403);
      }
    }
  }
  if (!roleCan(role, capability)) {
    throw new AccessError(`Forbidden: as ${article(ROLE_LABELS[role])} you cannot ${CAPABILITY_TEXT[capability]}.`, 403);
  }
  return { supabase, user, agent: { ...(agent as MemberRow), id: user.id } as MemberRow, role };
}

export type WorkspaceAccess = Awaited<ReturnType<typeof getWorkspaceAccess>>;

function article(label: string) {
  return /^[aeiou]/i.test(label) ? `an ${label.toLowerCase()}` : `a ${label.toLowerCase()}`;
}
