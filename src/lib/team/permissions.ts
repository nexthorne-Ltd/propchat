/**
 * Roles and what they allow, for the app. The database decides for real
 * (fn_role_has in supabase/migrations/20261010090000_teams_and_roles.sql);
 * this mirror lets screens hide what a role cannot do. roles.db.test.ts keeps
 * the two equal.
 */

export const ROLES = ['owner', 'admin', 'agent', 'light_agent'] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  'view',
  'add_note',
  'reply',
  'edit_ticket',
  'edit_content',
  'manage_groups',
  'manage_team',
  'manage_settings',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const MATRIX: Record<Capability, readonly Role[]> = {
  view: ['owner', 'admin', 'agent', 'light_agent'],
  add_note: ['owner', 'admin', 'agent', 'light_agent'],
  reply: ['owner', 'admin', 'agent'],
  edit_ticket: ['owner', 'admin', 'agent'],
  edit_content: ['owner', 'admin', 'agent'],
  manage_groups: ['owner', 'admin'],
  manage_team: ['owner', 'admin'],
  manage_settings: ['owner', 'admin'],
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleCan(role: Role | null | undefined, capability: Capability): boolean {
  return role ? MATRIX[capability].includes(role) : false;
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Agent',
  light_agent: 'Light agent',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Everything, including billing and managing admins.',
  admin: 'Everything except managing other admins.',
  agent: 'Works tickets: replies, notes, assignment and status.',
  light_agent: 'Can view tickets and add internal notes only.',
};

/** Roles an admin or owner can give someone from the team page. */
export function assignableRoles(callerRole: Role | null | undefined): Role[] {
  if (callerRole === 'owner') return ['admin', 'agent', 'light_agent'];
  if (callerRole === 'admin') return ['agent', 'light_agent'];
  return [];
}

/**
 * Whether `caller` may change `target`'s role, capacity or active state.
 * Mirrors fn_assert_can_manage_member.
 */
export function canManageMember(
  caller: { id: string; role: Role | null | undefined },
  target: { id: string; role: Role }
): boolean {
  if (!roleCan(caller.role, 'manage_team')) return false;
  if (caller.id === target.id || target.role === 'owner') return false;
  if (target.role === 'admin' && caller.role !== 'owner') return false;
  return true;
}

export type AgentStatus = 'online' | 'away' | 'offline';
export const AGENT_STATUSES: AgentStatus[] = ['online', 'away', 'offline'];
export const STATUS_LABELS: Record<AgentStatus, string> = { online: 'Online', away: 'Away', offline: 'Offline' };
