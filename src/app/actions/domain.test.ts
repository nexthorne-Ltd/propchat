import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeAdmin = {
  id: 'agent-super-1',
  email: 'super@platform.test',
  name: 'Super Admin',
  is_super_admin: true,
};

const superAdminMock = vi.hoisted(() => ({
  isSuperAdmin: true,
  auditLogs: [] as any[],
}));

vi.mock('@/app/actions/platform', () => ({
  assertSuperAdmin: async () => {
    if (!superAdminMock.isSuperAdmin) {
      throw new Error('403 Forbidden: Super admin access required');
    }
    return {
      user: { id: fakeAdmin.id, email: fakeAdmin.email },
      agent: fakeAdmin,
      accessRole: 'owner',
    };
  },
  recordSuperAdminAudit: async (params: any) => {
    superAdminMock.auditLogs.push(params);
  },
}));

vi.mock('@/lib/vercel-domains', () => ({
  addDomain: async (domain: string) => ({ domain, verified: true }),
  removeDomain: async (domain: string) => ({ domain }),
  getDomainStatus: async (domain: string) => ({ domain, configured: true }),
}));

vi.mock('@/lib/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/domain')>();
  return {
    ...actual,
    HELP_BASE_DOMAIN: 'help.zentry.test',
  };
});

import { registerHelpBaseDomainAction } from './domain';

describe('M-15a registerHelpBaseDomainAction super admin protection', () => {
  beforeEach(() => {
    superAdminMock.isSuperAdmin = true;
    superAdminMock.auditLogs = [];
  });

  it('rejects unauthorized users when assertSuperAdmin fails', async () => {
    superAdminMock.isSuperAdmin = false;

    const res = await registerHelpBaseDomainAction();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Forbidden|Super admin access required/);
    expect(superAdminMock.auditLogs).toHaveLength(0);
  });

  it('allows super admin, registers domain, and writes super admin audit log', async () => {
    superAdminMock.isSuperAdmin = true;

    const res = await registerHelpBaseDomainAction();
    expect(res.success).toBe(true);
    expect(res.data).toBeDefined();
    expect(superAdminMock.auditLogs).toHaveLength(1);
    expect(superAdminMock.auditLogs[0]).toMatchObject({
      admin: fakeAdmin,
      action: 'register_help_base_domain',
      details: expect.objectContaining({
        base: 'help.zentry.test',
        wildcardDomain: '*.help.zentry.test',
      }),
    });
  });
});
