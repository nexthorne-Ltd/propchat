import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZENTRY_WORKSPACE_ID } from './ZenTryChatSupport';

describe('Zen-try Live Chat Support Integration', () => {
  it('has the correct official workspace ID for Zen-try support', () => {
    expect(ZENTRY_WORKSPACE_ID).toBe('b2d91676-2e98-46b7-8543-6e0711c78c44');
  });

  it('is properly mounted in root layout', () => {
    const layoutPath = join(process.cwd(), 'src/app/layout.tsx');
    const layoutContent = readFileSync(layoutPath, 'utf8');
    expect(layoutContent).toContain('ZenTryChatSupport');
    expect(layoutContent).toContain('<ZenTryChatSupport />');
  });

  it('removed the dummy placeholder workspace ID from landing page', () => {
    const pagePath = join(process.cwd(), 'src/app/page.tsx');
    const pageContent = readFileSync(pagePath, 'utf8');
    expect(pageContent).not.toContain('c0000000-0000-0000-0000-000000000001');
  });

  it('correctly determines route inclusion and exclusion rules', () => {
    const isExcludedRoute = (pathname: string) =>
      pathname.startsWith('/widget') ||
      pathname.startsWith('/dashboard') ||
      pathname.startsWith('/admin') ||
      pathname.startsWith('/help') ||
      pathname.startsWith('/csat');

    // Excluded routes
    expect(isExcludedRoute('/widget')).toBe(true);
    expect(isExcludedRoute('/dashboard')).toBe(true);
    expect(isExcludedRoute('/dashboard/inbox')).toBe(true);
    expect(isExcludedRoute('/admin')).toBe(true);
    expect(isExcludedRoute('/admin/workspaces')).toBe(true);
    expect(isExcludedRoute('/help/zen-try')).toBe(true);
    expect(isExcludedRoute('/csat/ticket-123')).toBe(true);

    // Included public marketing & visitor routes
    expect(isExcludedRoute('/')).toBe(false);
    expect(isExcludedRoute('/pricing')).toBe(false);
    expect(isExcludedRoute('/login')).toBe(false);
    expect(isExcludedRoute('/signup')).toBe(false);
    expect(isExcludedRoute('/terms')).toBe(false);
    expect(isExcludedRoute('/privacy')).toBe(false);
    expect(isExcludedRoute('/about')).toBe(false);
  });
});
