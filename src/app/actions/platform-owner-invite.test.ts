/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const NORMAL_USER_ID = '33333333-3333-4333-8333-333333333333';
const EXISTING_MEMBER_ID = '44444444-4444-4444-8444-444444444444';

const fakeState = vi.hoisted(() => {
  return {
    OWNER_ID: '11111111-1111-4111-8111-111111111111',
    ADMIN_ID: '22222222-2222-4222-8222-222222222222',
    NORMAL_USER_ID: '33333333-3333-4333-8333-333333333333',
    EXISTING_MEMBER_ID: '44444444-4444-4444-8444-444444444444',
    user: { id: '11111111-1111-4111-8111-111111111111', email: 'zentry385@gmail.com' } as any,
    agent: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'ZenTry Owner',
      email: 'zentry385@gmail.com',
      role: 'owner',
      workspace_id: null,
      is_active: true,
      is_super_admin: true,
      is_platform_owner: true,
    } as any,
    authUsers: [
      { id: '11111111-1111-4111-8111-111111111111', email: 'zentry385@gmail.com', user_metadata: { name: 'ZenTry Owner' } },
      { id: '22222222-2222-4222-8222-222222222222', email: 'admin@platform.test', user_metadata: { name: 'Operational Admin' } },
      { id: '33333333-3333-4333-8333-333333333333', email: 'regular@user.test', user_metadata: { name: 'Regular User' } },
      { id: '44444444-4444-4444-8444-444444444444', email: 'existing@agent.test', user_metadata: { name: 'Existing Agent' } },
    ] as any[],
    agents: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'ZenTry Owner',
        email: 'zentry385@gmail.com',
        role: 'owner',
        workspace_id: null,
        is_active: true,
        is_super_admin: true,
        is_platform_owner: true,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Operational Admin',
        email: 'admin@platform.test',
        role: 'agent',
        workspace_id: null,
        is_active: true,
        is_super_admin: true,
        is_platform_owner: false,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Regular User',
        email: 'regular@user.test',
        role: 'agent',
        workspace_id: 'ws-1',
        is_active: true,
        is_super_admin: false,
        is_platform_owner: false,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Existing Agent',
        email: 'existing@agent.test',
        role: 'agent',
        workspace_id: 'ws-2',
        is_active: true,
        is_super_admin: false,
        is_platform_owner: false,
      },
    ] as any[],
    platformAccess: [
      {
        id: 'pa-owner',
        user_id: '11111111-1111-4111-8111-111111111111',
        role: 'owner',
        granted_by: '11111111-1111-4111-8111-111111111111',
        granted_at: new Date().toISOString(),
      },
      {
        id: 'pa-admin',
        user_id: '22222222-2222-4222-8222-222222222222',
        role: 'admin',
        granted_by: '11111111-1111-4111-8111-111111111111',
        granted_at: new Date().toISOString(),
      },
    ] as any[],
    adminInvites: [] as any[],
    auditLogs: [] as any[],
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/vercel-domains', () => ({
  addDomain: vi.fn(),
  removeDomain: vi.fn(),
}));

function createMockSupabaseClient() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: fakeState.user },
        error: fakeState.user ? null : { message: 'Not authenticated' },
      })),
      admin: {
        listUsers: vi.fn(async () => ({
          data: {
            users: fakeState.authUsers,
          },
          error: null,
        })),
        createUser: vi.fn(async ({ email, user_metadata }: any) => {
          const id = `created-${fakeState.authUsers.length + 1}`;
          const u = { id, email, user_metadata };
          fakeState.authUsers.push(u);
          return { data: { user: u }, error: null };
        }),
        updateUserById: vi.fn(async () => ({ error: null })),
        deleteUser: vi.fn(async () => ({ error: null })),
      },
    },
    from: vi.fn((table: string) => {
      let isSingle = false;
      let isMaybeSingle = false;
      const filters: Array<{ op: string; args: any[] }> = [];
      let updatePayload: any = null;
      let insertPayload: any = null;
      let isDelete = false;

      const builder: any = {
        select: vi.fn(() => builder),
        order: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        single: vi.fn(() => {
          isSingle = true;
          return builder;
        }),
        maybeSingle: vi.fn(() => {
          isMaybeSingle = true;
          return builder;
        }),
        eq: vi.fn((col: string, val: any) => {
          filters.push({ op: 'eq', args: [col, val] });
          return builder;
        }),
        in: vi.fn((col: string, vals: any[]) => {
          filters.push({ op: 'in', args: [col, vals] });
          return builder;
        }),
        delete: vi.fn(() => {
          isDelete = true;
          return builder;
        }),
        update: vi.fn((payload: any) => {
          updatePayload = payload;
          return builder;
        }),
        upsert: vi.fn((payload: any) => {
          if (table === 'agents') {
            const idx = fakeState.agents.findIndex((a: any) => a.id === payload.id);
            if (idx !== -1) Object.assign(fakeState.agents[idx], payload);
            else fakeState.agents.push(payload);
          } else if (table === 'platform_access') {
            const idx = fakeState.platformAccess.findIndex((p: any) => p.user_id === payload.user_id);
            if (idx !== -1) Object.assign(fakeState.platformAccess[idx], payload);
            else fakeState.platformAccess.push({ id: `pa-${Date.now()}`, ...payload });
          }
          return builder;
        }),
        insert: vi.fn((payload: any) => {
          insertPayload = payload;
          return builder;
        }),
        then: (resolve: (v: any) => any, reject?: (e: any) => any) => {
          try {
            if (isDelete) {
              const eqUserId = filters.find((f) => f.op === 'eq' && f.args[0] === 'user_id')?.args[1];
              if (table === 'platform_access' && eqUserId) {
                const idx = fakeState.platformAccess.findIndex((p: any) => p.user_id === eqUserId);
                if (idx !== -1) fakeState.platformAccess.splice(idx, 1);
              }
              return resolve({ data: null, error: null });
            }

            if (insertPayload) {
              if (table === 'platform_access') {
                const newRow = {
                  id: `pa-${Date.now()}`,
                  ...insertPayload,
                };
                fakeState.platformAccess.push(newRow);
                return resolve({ data: newRow, error: null });
              }
              if (table === 'admin_invites') {
                const newRow = {
                  id: `invite-${fakeState.adminInvites.length + 1}`,
                  ...insertPayload,
                };
                fakeState.adminInvites.push(newRow);
                return resolve({ data: newRow, error: null });
              }
              if (table === 'super_admin_audit_logs') {
                fakeState.auditLogs.push(insertPayload);
                return resolve({ data: insertPayload, error: null });
              }
              return resolve({ data: insertPayload, error: null });
            }

            if (updatePayload) {
              if (table === 'agents') {
                const eqId = filters.find((f) => f.op === 'eq' && f.args[0] === 'id')?.args[1];
                const target = fakeState.agents.find((a: any) => a.id === eqId);
                if (target) Object.assign(target, updatePayload);
              } else if (table === 'admin_invites') {
                const eqId = filters.find((f) => f.op === 'eq' && f.args[0] === 'id')?.args[1];
                const eqEmail = filters.find((f) => f.op === 'eq' && f.args[0] === 'email')?.args[1];
                for (const inv of fakeState.adminInvites) {
                  if ((eqId && inv.id === eqId) || (eqEmail && inv.email === eqEmail)) {
                    Object.assign(inv, updatePayload);
                  }
                }
              }
              return resolve({ data: updatePayload, error: null });
            }

            let sourceData: any[] = [];
            if (table === 'platform_access') {
              sourceData = fakeState.platformAccess;
            } else if (table === 'agents') {
              sourceData = fakeState.agents;
            } else if (table === 'super_admin_audit_logs') {
              sourceData = fakeState.auditLogs;
            } else if (table === 'admin_invites') {
              sourceData = fakeState.adminInvites;
            }

            let filtered = [...sourceData];
            for (const f of filters) {
              if (f.op === 'eq') {
                const [col, val] = f.args;
                filtered = filtered.filter((row: any) => row[col] === val);
              }
            }

            if (isSingle) {
              return resolve({ data: filtered[0] || null, error: filtered[0] ? null : { message: 'Not found' } });
            }
            if (isMaybeSingle) {
              return resolve({ data: filtered[0] || null, error: null });
            }
            return resolve({ data: filtered, error: null });
          } catch (err) {
            if (reject) return reject(err);
            return resolve({ data: null, error: err });
          }
        },
      };

      return builder;
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => createMockSupabaseClient()),
}));

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: vi.fn(() => createMockSupabaseClient()),
}));

import {
  assertSuperAdmin,
  assertPlatformOwner,
  getPlatformAccessListAction,
  grantAdminAccessAction,
  inviteOrGrantAdminAction,
  getAdminInvitesAction,
  resendAdminInviteAction,
  revokeAdminInviteAction,
  validateAdminInviteTokenAction,
  acceptAdminInviteAction,
  revokeAdminAccessAction,
} from './platform';

describe('Requirement 8: Platform Admin Access Security Suite', () => {
  beforeEach(() => {
    fakeState.user = { id: fakeState.OWNER_ID, email: 'zentry385@gmail.com' };
    fakeState.platformAccess = [
      {
        id: 'pa-owner',
        user_id: fakeState.OWNER_ID,
        role: 'owner',
        granted_by: fakeState.OWNER_ID,
        granted_at: new Date().toISOString(),
      },
      {
        id: 'pa-admin',
        user_id: fakeState.ADMIN_ID,
        role: 'admin',
        granted_by: fakeState.OWNER_ID,
        granted_at: new Date().toISOString(),
      },
    ];
    fakeState.adminInvites = [];
    fakeState.auditLogs = [];
  });

  describe('1. A user without access gets 403 on admin routes and guards', () => {
    it('denies unauthenticated callers with 401', async () => {
      fakeState.user = null;
      await expect(assertSuperAdmin()).rejects.toThrow(/401 Unauthorized/);
      await expect(assertPlatformOwner()).rejects.toThrow(/401 Unauthorized/);
    });

    it('strictly denies callers without platform access with 403', async () => {
      fakeState.user = { id: fakeState.NORMAL_USER_ID, email: 'regular@user.test' };
      await expect(assertSuperAdmin()).rejects.toThrow(
        /403 Forbidden: Platform super admin privileges required/
      );
      await expect(assertPlatformOwner()).rejects.toThrow(
        /403 Forbidden: Platform super admin privileges required/
      );
    });

    it('denies access list retrieval to unauthorized callers with error', async () => {
      fakeState.user = { id: fakeState.NORMAL_USER_ID, email: 'regular@user.test' };
      const res = await getPlatformAccessListAction();
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/403 Forbidden/);
    });
  });

  describe('2. An admin cannot grant or remove access, or send/revoke invites', () => {
    beforeEach(() => {
      fakeState.user = { id: fakeState.ADMIN_ID, email: 'admin@platform.test' };
    });

    it('allows admin to pass assertSuperAdmin but strictly rejects assertPlatformOwner with 403', async () => {
      const superRes = await assertSuperAdmin();
      expect(superRes.accessRole).toBe('admin');
      expect(superRes.agent.is_super_admin).toBe(true);
      expect(superRes.agent.is_platform_owner).toBe(false);

      await expect(assertPlatformOwner()).rejects.toThrow(
        /403 Forbidden: Only the platform owner can manage admin access/
      );
    });

    it('strictly forbids admin from granting or sending invites to others', async () => {
      await expect(grantAdminAccessAction('someone@test.com')).rejects.toThrow(
        /403 Forbidden: Only the platform owner can manage admin access/
      );
      await expect(inviteOrGrantAdminAction({ email: 'new@partner.test', role: 'admin' })).rejects.toThrow(
        /403 Forbidden: Only the platform owner can manage admin access/
      );
    });

    it('strictly forbids admin from removing access of any account', async () => {
      await expect(revokeAdminAccessAction(fakeState.EXISTING_MEMBER_ID)).rejects.toThrow(
        /403 Forbidden: Only the platform owner can manage admin access/
      );
    });

    it('strictly forbids admin from revoking or resending invites', async () => {
      await expect(revokeAdminInviteAction('inv-123')).rejects.toThrow(
        /403 Forbidden: Only the platform owner can manage admin access/
      );
      await expect(resendAdminInviteAction('inv-123')).rejects.toThrow(
        /403 Forbidden: Only the platform owner can manage admin access/
      );
    });
  });

  describe('3. The owner cannot be removed', () => {
    it('rejects attempt to remove or revoke the owner account', async () => {
      fakeState.user = { id: fakeState.OWNER_ID, email: 'zentry385@gmail.com' };

      const res = await revokeAdminAccessAction(fakeState.OWNER_ID);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/The platform owner account cannot be removed or revoked/);

      const ownerInDb = fakeState.platformAccess.find((p: any) => p.user_id === fakeState.OWNER_ID);
      expect(ownerInDb).toBeDefined();
      expect(ownerInDb.role).toBe('owner');
    });
  });

  describe('4. New Invite Flow: owner invites non-existent email -> pending invite created', () => {
    it('creates pending invite with 48h expiry without showing error for non-existent email', async () => {
      fakeState.user = { id: fakeState.OWNER_ID, email: 'zentry385@gmail.com' };
      const nonExistentEmail = 'partner@company.test';

      const res = await inviteOrGrantAdminAction({ email: nonExistentEmail, role: 'admin' });

      expect(res.success).toBe(true);
      expect(res.grantedDirectly).toBe(false);
      expect(res.invite).toBeDefined();
      expect(res.invite?.email).toBe(nonExistentEmail);
      expect(res.invite?.role).toBe('admin');
      expect(res.invite?.status).toBe('pending');
      expect(res.invite?.invite_url).toContain('/admin/invite?token=');

      // Verify row inserted in admin_invites with hashed token
      const inviteInDb = fakeState.adminInvites.find((i: any) => i.email === nonExistentEmail);
      expect(inviteInDb).toBeDefined();
      expect(inviteInDb.token_hash).toBeDefined();
      expect(inviteInDb.status).toBe('pending');

      // Verify audit log
      const auditLog = fakeState.auditLogs.find((a: any) => a.action === 'platform_admin_invite_sent');
      expect(auditLog).toBeDefined();
      expect(auditLog.details.invited_email).toBe(nonExistentEmail);
    });
  });

  describe('5. Acceptance Flow: valid token creates admin-only account server-side', () => {
    it('accepts valid invite, creates user in auth, agents, platform_access with no workspace', async () => {
      const rawToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const email = 'newadmin@enterprise.test';

      // Insert pending invite
      fakeState.adminInvites.push({
        id: 'inv-test-1',
        email,
        role: 'admin',
        token_hash: tokenHash,
        status: 'pending',
        invited_by: fakeState.OWNER_ID,
        expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      });

      // 1. Validate token
      const valRes = await validateAdminInviteTokenAction(rawToken);
      expect(valRes.valid).toBe(true);
      expect(valRes.email).toBe(email);
      expect(valRes.role).toBe('admin');

      // 2. Accept invite
      const acceptRes = await acceptAdminInviteAction({
        token: rawToken,
        name: 'Alex Rivera',
        password: 'SecurePassword123!',
      });

      expect(acceptRes.success).toBe(true);
      expect(acceptRes.email).toBe(email);

      // Verify user created in auth
      const createdAuth = fakeState.authUsers.find((u: any) => u.email === email);
      expect(createdAuth).toBeDefined();

      // Verify agent created with workspace_id = null
      const createdAgent = fakeState.agents.find((a: any) => a.id === createdAuth.id);
      expect(createdAgent).toBeDefined();
      expect(createdAgent.workspace_id).toBeNull();
      expect(createdAgent.is_super_admin).toBe(true);

      // Verify platform_access record
      const accessRecord = fakeState.platformAccess.find((p: any) => p.user_id === createdAuth.id);
      expect(accessRecord).toBeDefined();
      expect(accessRecord.role).toBe('admin');

      // Verify invite status marked accepted
      const inviteInDb = fakeState.adminInvites.find((i: any) => i.id === 'inv-test-1');
      expect(inviteInDb.status).toBe('accepted');
    });

    it('rejects expired, revoked, or already accepted invitation tokens', async () => {
      const rawToken = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      // A. Expired token
      fakeState.adminInvites.push({
        id: 'inv-expired',
        email: 'expired@test.com',
        role: 'admin',
        token_hash: tokenHash,
        status: 'pending',
        invited_by: fakeState.OWNER_ID,
        expires_at: new Date(Date.now() - 10000).toISOString(),
        created_at: new Date().toISOString(),
      });

      const expRes = await validateAdminInviteTokenAction(rawToken);
      expect(expRes.valid).toBe(false);
      expect(expRes.code).toBe('expired');

      // B. Revoked token
      fakeState.adminInvites[0].status = 'revoked';
      fakeState.adminInvites[0].expires_at = new Date(Date.now() + 100000).toISOString();
      const revRes = await validateAdminInviteTokenAction(rawToken);
      expect(revRes.valid).toBe(false);
      expect(revRes.code).toBe('revoked');

      // C. Accepted token
      fakeState.adminInvites[0].status = 'accepted';
      const accRes = await validateAdminInviteTokenAction(rawToken);
      expect(accRes.valid).toBe(false);
      expect(accRes.code).toBe('already_accepted');
    });
  });

  describe('6. Platform owner can grant admin access directly to existing Zentry account', () => {
    it('grants admin access immediately and logs audit', async () => {
      fakeState.user = { id: fakeState.OWNER_ID, email: 'zentry385@gmail.com' };

      const res = await inviteOrGrantAdminAction({ email: 'existing@agent.test', role: 'admin' });
      expect(res.success).toBe(true);
      expect(res.grantedDirectly).toBe(true);
      expect(res.member?.role).toBe('admin');
      expect(res.member?.user_id).toBe(fakeState.EXISTING_MEMBER_ID);

      const row = fakeState.platformAccess.find((p: any) => p.user_id === fakeState.EXISTING_MEMBER_ID);
      expect(row).toBeDefined();
      expect(row.role).toBe('admin');

      const auditLog = fakeState.auditLogs.find((a: any) => a.action === 'platform_admin_access_granted');
      expect(auditLog).toBeDefined();
      expect(auditLog.details.granted_to_email).toBe('existing@agent.test');
    });

    it('rejects granting access if user already has platform access', async () => {
      fakeState.user = { id: fakeState.OWNER_ID, email: 'zentry385@gmail.com' };

      const res = await inviteOrGrantAdminAction({ email: 'admin@platform.test', role: 'admin' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/already has admin access/);
    });

    it('successfully revokes admin access and writes to audit log', async () => {
      fakeState.user = { id: fakeState.OWNER_ID, email: 'zentry385@gmail.com' };

      const res = await revokeAdminAccessAction(fakeState.ADMIN_ID);
      expect(res.success).toBe(true);

      const row = fakeState.platformAccess.find((p: any) => p.user_id === fakeState.ADMIN_ID);
      expect(row).toBeUndefined();

      const auditLog = fakeState.auditLogs.find((a: any) => a.action === 'platform_admin_access_revoked');
      expect(auditLog).toBeDefined();
      expect(auditLog.details.revoked_user_id).toBe(fakeState.ADMIN_ID);
    });
  });
});
