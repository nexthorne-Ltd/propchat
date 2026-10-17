/**
 * Pure markdown-to-HTML conversion for help center articles in the widget.
 *
 * Requirements:
 * - No DOM APIs (runs cleanly in Node and browser).
 * - No regex lookbehind (?<= or ?<!), which crashes older Safari engines.
 * - Pre-escapes &, <, >, ", ' to stop XSS and attribute breakout (AUDIT H-7).
 * - URL patterns stop at quotes, entity-escaped quotes, and angle brackets.
 * - Only http/https/mailto schemes are recognized; javascript: URLs are ignored.
 */

export function formatMarkdownToHtml(markdown: string): string {
  if (!markdown) return '';

  // 1. Pre-escape HTML entities to prevent XSS and attribute breakout.
  let text = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  // 2. Fenced code blocks ```lang\ncode\n```
  text = text.replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_m, code) => {
    return `<pre class="chatify-code-block"><code>${code.trim()}</code></pre>`;
  });

  // 3. Inline code `code`
  text = text.replace(/`([^`\n]+)`/g, '<code class="chatify-inline-code">$1</code>');

  // 4. Images ![alt](url) - only allow http/https, stopping at quotes, entities, and angle brackets
  text = text.replace(
    /!\[([^\]]*)\]\((https?:\/\/(?:(?!&(?:quot|#0?39|apos|lt|gt);)[^\s)"'<>])+)\)/g,
    '<img src="$2" alt="$1" class="chatify-art-img" style="max-width:100%;border-radius:6px;margin:6px 0;" />'
  );

  // 5. Links [text](url) - only allow http/https/mailto, stopping at quotes, entities, and angle brackets
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/(?:(?!&(?:quot|#0?39|apos|lt|gt);)[^\s)"'<>])+|mailto:(?:(?!&(?:quot|#0?39|apos|lt|gt);)[^\s)"'<>])+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="chatify-art-link">$1</a>'
  );

  // 6. Headings (h1 - h4)
  text = text.replace(/^#### (.*$)/gim, '<h5 style="margin:10px 0 4px;font-size:12.5px;font-weight:700;color:var(--w-ink);">$1</h5>');
  text = text.replace(/^### (.*$)/gim, '<h4 style="margin:12px 0 4px;font-size:13px;font-weight:700;color:var(--w-ink);">$1</h4>');
  text = text.replace(/^## (.*$)/gim, '<h3 style="margin:14px 0 6px;font-size:14px;font-weight:700;color:var(--w-ink);">$1</h3>');
  text = text.replace(/^# (.*$)/gim, '<h2 style="margin:16px 0 6px;font-size:15px;font-weight:700;color:var(--w-ink);">$1</h2>');

  // 7. Bold & Italic (using boundary-safe matching so target="_blank" is never mangled)
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\s](?:[^*]*?[^*\s])?)\*/g, '<em>$1</em>');
  text = text.replace(/(^|\s)_([^_]+)_(\s|$|[.,!?;:])/g, '$1<em>$2</em>$3');

  // 8. Blockquotes (note: > was pre-escaped to &gt;)
  text = text.replace(/^(&gt;|>)\s?(.*$)/gim, '<blockquote style="border-left:3px solid var(--w-brand);margin:6px 0;padding-left:8px;color:var(--w-ink-2);font-style:italic;">$2</blockquote>');

  // 9. Unordered Lists (- item or * item)
  text = text.replace(/((?:^(?:[-*]\s+.+)(?:\n|$))+)/gm, (match) => {
    const items = match
      .trim()
      .split('\n')
      .map((line) => line.replace(/^[-*]\s+/, '').trim())
      .filter(Boolean)
      .map((item) => `<li style="margin-bottom:3px;">${item}</li>`)
      .join('');
    return `<ul style="margin:6px 0 8px 18px;padding:0;">${items}</ul>`;
  });

  // 10. Ordered Lists (1. item)
  text = text.replace(/((?:^\d+\.\s+.+(?:\n|$))+)/gm, (match) => {
    const items = match
      .trim()
      .split('\n')
      .map((line) => line.replace(/^\d+\.\s+/, '').trim())
      .filter(Boolean)
      .map((item) => `<li style="margin-bottom:3px;">${item}</li>`)
      .join('');
    return `<ol style="margin:6px 0 8px 18px;padding:0;">${items}</ol>`;
  });

  // 11. Paragraphs: split by double newlines, preserving structural blocks
  const blocks = text.split(/\n\s*\n/);
  text = blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (
        trimmed.startsWith('<h') ||
        trimmed.startsWith('<pre') ||
        trimmed.startsWith('<ul') ||
        trimmed.startsWith('<ol') ||
        trimmed.startsWith('<blockquote')
      ) {
        return trimmed;
      }
      return `<p style="margin:0 0 8px 0;line-height:1.55;">${trimmed.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('');

  return text;
}
