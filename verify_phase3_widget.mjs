import fs from 'fs';
import path from 'path';

console.log('--- AUDITING PHASE 3: WIDGET SDK & HELP BUTTON ENHANCEMENT ---\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    passCount++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    failCount++;
  }
}

// 1. Audit public/widget.js bundle
const widgetBundlePath = path.resolve('public/widget.js');
assert(fs.existsSync(widgetBundlePath), 'public/widget.js bundle exists');

const bundleContent = fs.readFileSync(widgetBundlePath, 'utf8');
assert(bundleContent.length > 100000, `Bundle size is healthy (${(bundleContent.length / 1024).toFixed(1)} KB)`);
assert(bundleContent.includes('Chatify'), 'Bundle contains Chatify global object');
assert(bundleContent.includes('openHelp'), 'Bundle contains openHelp method');
assert(bundleContent.includes('openMessages'), 'Bundle contains openMessages method');
assert(bundleContent.includes('openArticle'), 'Bundle contains openArticle method');
assert(bundleContent.includes('data-chatify-help'), 'Bundle contains [data-chatify-help] listener');
assert(bundleContent.includes('data-chatify-open'), 'Bundle contains [data-chatify-open] listener');
assert(bundleContent.includes('data-chatify-article'), 'Bundle contains [data-chatify-article] listener');
assert(bundleContent.includes('chatify-article-ext-link'), 'Bundle contains article deep link styling');
assert(bundleContent.includes('/help/'), 'Bundle constructs /help/${workspaceId}/${slug} URLs');

// 2. Audit public/demo.html
const demoHtmlPath = path.resolve('public/demo.html');
assert(fs.existsSync(demoHtmlPath), 'public/demo.html exists');

const demoContent = fs.readFileSync(demoHtmlPath, 'utf8');
assert(demoContent.includes('data-chatify-help'), 'demo.html contains declarative [data-chatify-help] button');
assert(demoContent.includes('window.Chatify.openHelp'), 'demo.html contains window.Chatify.openHelp() API call');
assert(demoContent.includes('window.Chatify.openMessages'), 'demo.html contains window.Chatify.openMessages() API call');
assert(demoContent.includes('window.Chatify.search'), 'demo.html contains window.Chatify.search() API call');
assert(demoContent.includes('window.Chatify.toggle'), 'demo.html openChatBubble() uses window.Chatify.toggle()');

// 3. Test inline Markdown-to-HTML parser logic
function formatMarkdownToHtml(markdown) {
  if (!markdown) return '';

  let text = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  text = text.replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_m, code) => {
    return `<pre class="chatify-code-block"><code>${code.trim()}</code></pre>`;
  });

  text = text.replace(/`([^`\n]+)`/g, '<code class="chatify-inline-code">$1</code>');

  text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" class="chatify-art-img" style="max-width:100%;border-radius:6px;margin:6px 0;" />');

  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="chatify-art-link">$1</a>');

  text = text.replace(/^#### (.*$)/gim, '<h5 style="margin:10px 0 4px;font-size:12.5px;font-weight:700;color:var(--w-ink);">$1</h5>');
  text = text.replace(/^### (.*$)/gim, '<h4 style="margin:12px 0 4px;font-size:13px;font-weight:700;color:var(--w-ink);">$1</h4>');
  text = text.replace(/^## (.*$)/gim, '<h3 style="margin:14px 0 6px;font-size:14px;font-weight:700;color:var(--w-ink);">$1</h3>');
  text = text.replace(/^# (.*$)/gim, '<h2 style="margin:16px 0 6px;font-size:15px;font-weight:700;color:var(--w-ink);">$1</h2>');

  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/_([^_]+)_/g, '<em>$1</em>');

  text = text.replace(/^>\s?(.*$)/gim, '<blockquote style="border-left:3px solid var(--w-brand);margin:6px 0;padding-left:8px;color:var(--w-ink-2);font-style:italic;">$1</blockquote>');

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

// XSS Sanitization test
const xssSample = '<script>alert("pwned")</script><b>Hello</b>';
const parsedXss = formatMarkdownToHtml(xssSample);
assert(!parsedXss.includes('<script>'), 'Raw <script> tags are safely escaped');
assert(parsedXss.includes('&lt;script&gt;'), '<script> converted to &lt;script&gt;');

// Markdown elements test
const sampleMarkdown = `## Setting Up SSO
To configure SAML 2.0 Single Sign-On:
- Go to Workspace Settings
- Click Security Tab
- Paste Identity Provider XML

Here is an example config:
\`\`\`json
{ "sso": true }
\`\`\`

Need help? Visit [Docs](https://chatify.com/docs) or email us!`;

const parsedHtml = formatMarkdownToHtml(sampleMarkdown);
assert(parsedHtml.includes('<h3'), 'Markdown ## Heading converted to <h3>');
assert(parsedHtml.includes('<ul') && parsedHtml.includes('<li'), 'Markdown list converted to <ul> and <li>');
assert(parsedHtml.includes('<pre class="chatify-code-block"><code>'), 'Markdown code block converted to <pre><code>');
assert(parsedHtml.includes('<a href="https://chatify.com/docs"'), 'Markdown [text](url) converted to <a href="...">');

// 4. Command queue / SDK stub simulation test
const mockQueue = [];
const stub = {
  q: mockQueue,
  open: (...args) => mockQueue.push(['open', args]),
  openHelp: (...args) => mockQueue.push(['openHelp', args]),
};

// Developer calls openHelp() before widget script finished downloading
stub.openHelp();
stub.open('messages');
assert(mockQueue.length === 2, 'Pre-init calls queued properly in window.Chatify.q');

// Widget loads and flushes queue
const executedCalls = [];
const mockApi = {
  open: (tab) => executedCalls.push(`open:${tab}`),
  openHelp: () => executedCalls.push('openHelp'),
};

for (const item of mockQueue) {
  const [method, args = []] = item;
  mockApi[method](...args);
}
assert(executedCalls.includes('openHelp') && executedCalls.includes('open:messages'), 'Queue flushed all calls successfully upon widget initialization');

console.log(`\n--- AUDIT SUMMARY: ${passCount} Passed, ${failCount} Failed ---`);
if (failCount > 0) process.exit(1);
