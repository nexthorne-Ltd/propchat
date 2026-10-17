/**
 * The help center design screen renders its themes, the saved choices and a
 * preview of the real help center (on the platform path, so it can receive
 * the unsaved design).
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/app/actions/admin', () => ({ updateHelpCenterThemeAction: vi.fn() }));
vi.mock('@/lib/image-upload', () => ({ uploadChatImage: vi.fn() }));

import { HelpCenterDesigner } from './HelpCenterDesigner';
import { HELP_PRESETS } from '@/lib/help/theme';
import type { Workspace } from '@/types/database';

const workspace = {
  id: '47345f70-4895-4ff6-bcf8-153034225cae',
  name: 'Range4ex',
  brand_color: '#480576',
  help_center_title: null,
  help_center_subtitle: null,
  help_center_theme: { preset: 'ocean' },
} as unknown as Workspace;

describe('help center designer', () => {
  const html = renderToStaticMarkup(React.createElement(HelpCenterDesigner, { workspace }));

  it('offers every theme and marks the saved one', () => {
    for (const p of HELP_PRESETS) expect(html).toContain(`>${p.name}<`);
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>)[\s\S])*Ocean/);
  });

  it('previews the real help center on the platform path, in the named frame', () => {
    expect(html).toContain(`src="/help/${workspace.id}?hc_preview=1"`);
    expect(html).toContain('name="zentry-help-preview"');
  });

  it('has nothing to save until something changes', () => {
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Saved<\/button>/);
  });
});
