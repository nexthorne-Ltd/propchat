import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeState = vi.hoisted(() => {
  const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  return {
    WS,
    USER_ID,
    user: { id: USER_ID } as { id: string } | null,
    agent: {
      id: USER_ID,
      name: 'Test Agent',
      role: 'owner',
      workspace_id: WS,
      is_active: true,
      is_super_admin: false,
    } as Record<string, unknown> | null,
    workspace: {
      id: WS,
      owner_id: USER_ID,
      is_suspended: false,
      deleted_at: null as string | null,
    } as Record<string, unknown> | null,
    platformAccess: null as { user_id: string; role: 'owner' | 'admin' } | null,
  };
});

const { WS, USER_ID } = fakeState;
type Query = { table: string; ops: [string, ...unknown[]][] };

function mockQuery(table: string) {
  const q: Query = { table, ops: [] };
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => {
            if (table === 'agents') {
              return resolve({ data: fakeState.agent, error: null });
            }
            if (table === 'workspaces') {
              return resolve({ data: fakeState.workspace, error: null });
            }
            if (table === 'platform_access') {
              return resolve({ data: fakeState.platformAccess, error: null });
            }
            return resolve({ data: null, error: null });
          };
        }
        return (...args: unknown[]) => {
          q.ops.push([prop, ...args]);
          return proxy;
        };
      },
    }
  );
  return proxy;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: fakeState.user }, error: null }),
    },
    from: (table: string) => mockQuery(table),
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => ({
    from: (table: string) => mockQuery(table),
  }),
}));

import { getWorkspaceAccess, AccessError } from './access';

describe('getWorkspaceAccess helper', () => {
  beforeEach(() => {
    fakeState.user = { id: USER_ID };
    fakeState.agent = {
      id: USER_ID,
      name: 'Test Agent',
      role: 'owner',
      workspace_id: WS,
      is_active: true,
      is_super_admin: false,
    };
    fakeState.workspace = {
      id: WS,
      owner_id: USER_ID,
      is_suspended: false,
      deleted_at: null,
    };
    fakeState.platformAccess = null;
  });

  it('rejects invalid workspace UUID format', async () => {
    await expect(getWorkspaceAccess('not-a-uuid')).rejects.toThrow(AccessError);
    await expect(getWorkspaceAccess('not-a-uuid')).rejects.toMatchObject({
      message: 'Unknown workspace.',
      status: 403,
    });
  });

  it('rejects unauthenticated caller', async () => {
    fakeState.user = null;
    await expect(getWorkspaceAccess(WS)).rejects.toMatchObject({
      message: 'Unauthorized: sign in again.',
      status: 401,
    });
  });

  it('rejects when workspace is not found or not belonging to caller', async () => {
    fakeState.workspace = null;
    await expect(getWorkspaceAccess(WS)).rejects.toMatchObject({
      message: 'Forbidden: this workspace is not yours.',
      status: 403,
    });
  });

  it('rejects when agent account is deactivated', async () => {
    fakeState.agent = {
      id: USER_ID,
      name: 'Deactivated Agent',
      role: 'agent',
      workspace_id: WS,
      is_active: false,
      is_super_admin: false,
    };
    fakeState.workspace!.owner_id = 'other-user';
    await expect(getWorkspaceAccess(WS)).rejects.toMatchObject({
      message: 'Forbidden: your account has been deactivated.',
      status: 403,
    });
  });

  it('throws AccessError("This workspace is suspended.") when is_suspended is true', async () => {
    fakeState.workspace!.is_suspended = true;
    await expect(getWorkspaceAccess(WS)).rejects.toThrow(AccessError);
    await expect(getWorkspaceAccess(WS)).rejects.toMatchObject({
      message: 'This workspace is suspended.',
      status: 403,
    });
  });

  it('throws AccessError("This workspace was deleted.") when deleted_at is set', async () => {
    fakeState.workspace!.deleted_at = new Date().toISOString();
    await expect(getWorkspaceAccess(WS)).rejects.toThrow(AccessError);
    await expect(getWorkspaceAccess(WS)).rejects.toMatchObject({
      message: 'This workspace was deleted.',
      status: 403,
    });
  });

  it('allows platform super admin (admin role in platform_access) to access suspended workspace', async () => {
    fakeState.workspace!.is_suspended = true;
    fakeState.platformAccess = { user_id: USER_ID, role: 'admin' };
    const access = await getWorkspaceAccess(WS, 'view');
    expect(access).toBeDefined();
    expect(access.role).toBe('owner');
    expect(access.user.id).toBe(USER_ID);
  });

  it('allows platform super admin (owner role in platform_access) to access deleted workspace', async () => {
    fakeState.workspace!.deleted_at = new Date().toISOString();
    fakeState.platformAccess = { user_id: USER_ID, role: 'owner' };
    const access = await getWorkspaceAccess(WS, 'view');
    expect(access).toBeDefined();
    expect(access.role).toBe('owner');
  });

  it('enforces capabilities when role lacks permission', async () => {
    fakeState.agent = {
      id: USER_ID,
      name: 'Support Agent',
      role: 'agent',
      workspace_id: WS,
      is_active: true,
      is_super_admin: false,
    };
    fakeState.workspace!.owner_id = 'other-owner';
    await expect(getWorkspaceAccess(WS, 'manage_settings')).rejects.toMatchObject({
      message: 'Forbidden: as an agent you cannot change workspace settings.',
      status: 403,
    });
  });

  it('succeeds for active workspace and authorized capability', async () => {
    const access = await getWorkspaceAccess(WS, 'view');
    expect(access).toBeDefined();
    expect(access.role).toBe('owner');
    expect(access.agent.id).toBe(USER_ID);
  });
});
