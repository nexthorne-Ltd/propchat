/**
 * The article editor opens in the right state: a published article offers
 * "Published" (nothing to update yet) and Unpublish; a new one is a draft
 * with templates and a Publish button.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/app/actions/helpdesk', () => ({
  createArticleAction: vi.fn(),
  updateArticleAction: vi.fn(),
  getArticleAction: vi.fn(),
  toggleArticleStatusAction: vi.fn(),
}));
vi.mock('@/lib/image-upload', () => ({ uploadChatImage: vi.fn() }));

import { ArticleEditor } from './ArticleEditor';
import type { Article, HelpSection, Workspace } from '@/types/database';

const workspace = { id: 'ws', name: 'Acme', slug: 'acme' } as unknown as Workspace;
const sections = [{ id: 's1', name: 'Payouts', icon: '💸' }] as unknown as HelpSection[];
const render = (article: Article | null) =>
  renderToStaticMarkup(
    React.createElement(ArticleEditor, {
      workspace,
      workspaceId: 'ws',
      sections,
      article,
      templates: [{ id: 'faq', label: 'FAQ', name: 'FAQ', content: '# FAQ' }],
      onClose: () => {},
      onSaved: () => {},
    })
  );

describe('ArticleEditor', () => {
  it('a published article: nothing to update until it changes, and it can be unpublished', () => {
    const html = render({
      id: 'a1',
      title: 'How long do payouts take?',
      slug: 'payouts',
      summary: null,
      content: 'Two business days.',
      section_id: 's1',
      status: 'published',
    } as unknown as Article);
    expect(html).toContain('How long do payouts take?');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Published<\/button>/);
    expect(html).toContain('Unpublish');
    expect(html).not.toContain('Start from a template');
  });

  it('a new article: a draft with templates and Publish', () => {
    const html = render(null);
    expect(html).toContain('Draft');
    expect(html).toContain('Start from a template');
    expect(html).toContain('>Publish</button>');
    expect(html).toContain('Payouts');
  });

  it('an article whose body is still loading cannot be published', () => {
    const html = render({ id: 'a2', title: 'Fees', slug: 'fees', section_id: 's1', status: 'draft' } as unknown as Article);
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Publish<\/button>/);
  });
});
