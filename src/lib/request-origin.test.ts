import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRequestOrigin, getStaticAppOrigin } from './request-origin';

describe('getRequestOrigin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses request origin header when available', async () => {
    const headers = new Headers({ origin: 'https://support.acme.com' });
    const origin = await getRequestOrigin(headers);
    expect(origin).toBe('https://support.acme.com');
  });

  it('uses x-forwarded-host and proto when origin is not provided', async () => {
    const headers = new Headers({
      'x-forwarded-host': 'app.zen-try.site',
      'x-forwarded-proto': 'https',
    });
    const origin = await getRequestOrigin(headers);
    expect(origin).toBe('https://app.zen-try.site');
  });

  it('strips trailing slashes from origin', async () => {
    const headers = new Headers({ origin: 'https://zen-try.site///' });
    const origin = await getRequestOrigin(headers);
    expect(origin).toBe('https://zen-try.site');
  });

  it('prioritizes live request origin over NEXT_PUBLIC_APP_URL localhost config', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    const headers = new Headers({ origin: 'https://zen-try.site' });
    const origin = await getRequestOrigin(headers);
    expect(origin).toBe('https://zen-try.site');
  });

  it('falls back to non-localhost NEXT_PUBLIC_APP_URL when no request is passed', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://zen-try.com';
    const origin = await getRequestOrigin(null);
    expect(origin).toBe('https://zen-try.com');
  });

  it('falls back to VERCEL_PROJECT_PRODUCTION_URL if NEXT_PUBLIC_APP_URL is localhost', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'my-deploy.vercel.app';
    const origin = await getRequestOrigin(null);
    expect(origin).toBe('https://my-deploy.vercel.app');
  });

  it('falls back to default production url when no env is configured', async () => {
    const origin = await getRequestOrigin(null);
    expect(origin).toBe('https://zen-try.site');
  });

  it('preserves localhost in local dev when explicit localhost header is provided without live fallback', async () => {
    const headers = new Headers({ origin: 'http://localhost:3000' });
    const origin = await getRequestOrigin(headers);
    expect(origin).toBe('http://localhost:3000');
  });
});

describe('getStaticAppOrigin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses NEXT_PUBLIC_APP_URL when non-localhost', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://custom-app.com';
    expect(getStaticAppOrigin()).toBe('https://custom-app.com');
  });

  it('falls back to VERCEL_PROJECT_PRODUCTION_URL when env is localhost', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'vercel-app.vercel.app';
    expect(getStaticAppOrigin()).toBe('https://vercel-app.vercel.app');
  });
});
