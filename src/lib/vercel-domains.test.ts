/**
 * Domains on Vercel after the project moved to another team/account:
 * a domain still attached to the OLD project answers "already in use", and
 * that must be an error naming the fix, not a silent "already attached".
 * checkVercelSetup must say which setting is wrong. Vercel is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  addProjectDomain: vi.fn(),
  getProjectDomain: vi.fn(),
  verifyProjectDomain: vi.fn(),
}));

// Next resolves server-only itself; plain Vitest needs a stand-in.
vi.mock('server-only', () => ({}));

vi.mock('@vercel/sdk', () => ({
  Vercel: class {
    projects = sdk;
  },
}));

import { addDomain, checkVercelSetup } from './vercel-domains';
import { errorMessage } from '@/lib/errors/user-error';

const inUse = Object.assign(new Error('Domain is already in use'), { statusCode: 409, code: 'domain_already_in_use' });
const notFound = Object.assign(new Error('Not found'), { statusCode: 404 });

beforeEach(() => {
  process.env.VERCEL_TOKEN = 'tok';
  process.env.VERCEL_PROJECT_ID = 'prj_new';
  delete process.env.VERCEL_TEAM_ID;
  Object.values(sdk).forEach((f) => f.mockReset());
});
afterEach(() => vi.unstubAllGlobals());

describe('addDomain', () => {
  it('a domain still on another project is an error that says how to fix it', async () => {
    sdk.addProjectDomain.mockRejectedValue(inUse);
    sdk.getProjectDomain.mockRejectedValue(notFound);
    const err = await addDomain('help.shop.com').catch((e) => e);
    expect(errorMessage(err)).toMatch(/attached to another Vercel project/);
  });

  it('a domain already on this project is fine', async () => {
    sdk.addProjectDomain.mockRejectedValue(inUse);
    sdk.getProjectDomain.mockResolvedValue({ name: 'help.shop.com', verified: true, verification: [] });
    sdk.verifyProjectDomain.mockResolvedValue({ verified: true });
    await expect(addDomain('help.shop.com')).resolves.toMatchObject({ success: true, alreadyExists: true, verified: true });
  });

  it('a new domain is added', async () => {
    sdk.addProjectDomain.mockResolvedValue({ verified: false, verification: [{ type: 'TXT', domain: '_vercel.shop.com', value: 'x', reason: 'r' }] });
    await expect(addDomain('help.shop.com')).resolves.toMatchObject({ success: true, verified: false, verificationRecords: [{ type: 'TXT' }] });
  });
});

describe('checkVercelSetup', () => {
  const respond = (routes: Record<string, { status: number; body?: unknown }>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        const r = routes[path] ?? { status: 404 };
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
      })
    );

  it('says which setting is missing', async () => {
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_API_TOKEN;
    expect((await checkVercelSetup()).error).toMatch(/VERCEL_TOKEN is not set/);
  });

  it('explains a project that is not found (usually the old id or a missing team id)', async () => {
    respond({});
    const s = await checkVercelSetup();
    expect(s.project).toBeNull();
    expect(s.error).toMatch(/VERCEL_TEAM_ID/);
  });

  it('explains a refused token', async () => {
    respond({ '/v9/projects/prj_new': { status: 403 } });
    expect((await checkVercelSetup()).error).toMatch(/token was refused/);
  });

  it('lists the project and its domains', async () => {
    respond({
      '/v9/projects/prj_new': { status: 200, body: { id: 'prj_new', name: 'zen-try-new' } },
      '/v9/projects/prj_new/domains': { status: 200, body: { domains: [{ name: 'zen-try.site', verified: true }] } },
    });
    const s = await checkVercelSetup();
    expect(s).toMatchObject({ project: { name: 'zen-try-new' }, domains: [{ name: 'zen-try.site', verified: true }], error: null });
  });
});
