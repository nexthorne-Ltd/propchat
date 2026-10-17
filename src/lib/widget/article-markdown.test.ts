import { describe, it, expect } from 'vitest';
import { formatMarkdownToHtml } from './article-markdown';

describe('formatMarkdownToHtml (AUDIT H-7 Stored XSS Hardening)', () => {
  it('prevents ![x](https://a/"onerror="alert(1)) from executing script or breaking out of attributes', () => {
    const payload = '![x](https://a/"onerror="alert(1))';
    const html = formatMarkdownToHtml(payload);

    // Must not generate an onerror attribute on any tag
    expect(html).not.toMatch(/<[a-z]+[^>]*\bonerror\s*=/i);
    expect(html).not.toContain(' onerror=');
    expect(html).not.toContain('"onerror=');

    // No <img> tag should be created with the broken quote payload
    expect(html).not.toContain('<img');

    // The payload quote was safely encoded so no breakout occurs
    expect(html).toContain('&quot;onerror=&quot;alert(1)');
    expect(html).not.toContain('"alert(1)');
  });

  it('prevents attribute breakout in alt text', () => {
    const payload = '![" fake-attr="x](https://example.com/pic.png)';
    const html = formatMarkdownToHtml(payload);

    // Attribute must not break out: quotes are escaped to &quot; inside alt
    expect(html).not.toContain('" fake-attr=');
    expect(html).toContain('alt="&quot; fake-attr=&quot;x"');
  });

  it('prevents attribute breakout in link href', () => {
    const payload = '[click](https://example.com/"onerror="alert(1))';
    const html = formatMarkdownToHtml(payload);

    expect(html).not.toMatch(/<[a-z]+[^>]*\bonerror\s*=/i);
    expect(html).not.toContain(' onerror=');
    expect(html).not.toContain('"onerror=');
    expect(html).not.toContain('<a');
  });

  it('does not link javascript: URLs', () => {
    const payloads = [
      '[Click here](javascript:alert(1))',
      '[Click here](JAVASCRIPT:alert(1))',
      '[Click here](javascript:void(0))',
      '![Image](javascript:alert(1))',
    ];

    for (const payload of payloads) {
      const html = formatMarkdownToHtml(payload);
      expect(html).not.toContain('<a href="javascript');
      expect(html).not.toContain('<img src="javascript');
      expect(html).not.toContain('<a');
    }
  });

  it('renders normal articles correctly (headings, lists, links, images, code, quotes)', () => {
    const markdown = [
      '# Main Title',
      '## Subtitle',
      '### Section 3',
      '#### Section 4',
      '',
      'Paragraph with **bold**, *italic*, __bold2__, _italic2_, and `inline code`.',
      '',
      '> A quoted advice block',
      '',
      '```typescript',
      'const answer = 42;',
      '```',
      '',
      '- First bullet item',
      '- Second bullet item',
      '',
      '1. Step one',
      '2. Step two',
      '',
      'Visit [our docs](https://example.com/docs) or email [support](mailto:help@example.com).',
      '',
      '![Architecture Diagram](https://example.com/assets/arch.png)',
    ].join('\n');

    const html = formatMarkdownToHtml(markdown);

    // Headings
    expect(html).toContain('<h2 style="margin:16px 0 6px;font-size:15px;font-weight:700;color:var(--w-ink);">Main Title</h2>');
    expect(html).toContain('<h3 style="margin:14px 0 6px;font-size:14px;font-weight:700;color:var(--w-ink);">Subtitle</h3>');
    expect(html).toContain('<h4 style="margin:12px 0 4px;font-size:13px;font-weight:700;color:var(--w-ink);">Section 3</h4>');
    expect(html).toContain('<h5 style="margin:10px 0 4px;font-size:12.5px;font-weight:700;color:var(--w-ink);">Section 4</h5>');

    // Inline formatting
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<strong>bold2</strong>');
    expect(html).toContain('<em>italic2</em>');
    expect(html).toContain('<code class="chatify-inline-code">inline code</code>');

    // Blockquote
    expect(html).toContain('<blockquote style="border-left:3px solid var(--w-brand);margin:6px 0;padding-left:8px;color:var(--w-ink-2);font-style:italic;">A quoted advice block</blockquote>');

    // Code block
    expect(html).toContain('<pre class="chatify-code-block"><code>const answer = 42;</code></pre>');

    // Unordered list
    expect(html).toContain('<ul style="margin:6px 0 8px 18px;padding:0;"><li style="margin-bottom:3px;">First bullet item</li><li style="margin-bottom:3px;">Second bullet item</li></ul>');

    // Ordered list
    expect(html).toContain('<ol style="margin:6px 0 8px 18px;padding:0;"><li style="margin-bottom:3px;">Step one</li><li style="margin-bottom:3px;">Step two</li></ol>');

    // Links (checking that target="_blank" was preserved and not mangled by italic regex)
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer" class="chatify-art-link">our docs</a>');
    expect(html).toContain('<a href="mailto:help@example.com" target="_blank" rel="noopener noreferrer" class="chatify-art-link">support</a>');

    // Image
    expect(html).toContain('<img src="https://example.com/assets/arch.png" alt="Architecture Diagram" class="chatify-art-img" style="max-width:100%;border-radius:6px;margin:6px 0;" />');
  });

  it('renders complex image URLs with underscores, hyphens, and query params', () => {
    const md = '![Diagram](https://example.com/path_with_underscore/img-123.png?v=2&theme=dark)';
    const html = formatMarkdownToHtml(md);
    expect(html).toContain('<img src="https://example.com/path_with_underscore/img-123.png?v=2&amp;theme=dark" alt="Diagram"');
  });

  it('preserves query parameters in legitimate URLs', () => {
    const md = '[Search](https://example.com/search?q=test&category=help)';
    const html = formatMarkdownToHtml(md);
    expect(html).toContain('href="https://example.com/search?q=test&amp;category=help"');
  });

  it('handles empty or whitespace inputs gracefully', () => {
    expect(formatMarkdownToHtml('')).toBe('');
    expect(formatMarkdownToHtml('   \n\n  ')).toBe('');
  });
});
