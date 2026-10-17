import { describe, expect, it } from 'vitest';
import { isPlatformHost } from './domain';

describe('isPlatformHost', () => {
  it('recognizes local development hosts', () => {
    expect(isPlatformHost('localhost')).toBe(true);
    expect(isPlatformHost('localhost:3000')).toBe(true);
    expect(isPlatformHost('127.0.0.1')).toBe(true);
    expect(isPlatformHost('127.0.0.1:3000')).toBe(true);
  });

  it('recognizes production platform domains', () => {
    expect(isPlatformHost('zen-try.site')).toBe(true);
    expect(isPlatformHost('www.zen-try.site')).toBe(true);
    expect(isPlatformHost('zen-try.com')).toBe(true);
    expect(isPlatformHost('app.zen-try.com')).toBe(true);
    expect(isPlatformHost('my-app.vercel.app')).toBe(true);
  });

  it('rejects external customer custom domains', () => {
    expect(isPlatformHost('support.mycompany.com')).toBe(false);
    expect(isPlatformHost('helpdesk.brand.io')).toBe(false);
    expect(isPlatformHost('customer-site.net')).toBe(false);
  });
});
