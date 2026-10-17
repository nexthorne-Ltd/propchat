'use client';

import React, { useState } from 'react';
import {
  Check,
  Copy,
  Lightbulb,
  AlertTriangle,
  Info,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Sparkles,
  ShieldAlert,
  ArrowRight,
} from 'lucide-react';

interface MarkdownArticleContentProps {
  content: string;
  className?: string;
}

/**
 * Stable anchor for a heading, so a table of contents can link to it and a
 * shared URL can land on the right part of a long article. Headings carried no
 * id at all before, which made both impossible.
 */
export function headingId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[`*~_[\]()]/g, '')
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'section'
  );
}

export interface ArticleHeading {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

/** Pulls the heading outline out of markdown, skipping fenced code blocks. */
export function extractHeadings(content: string): ArticleHeading[] {
  const out: ArticleHeading[] = [];
  const seen = new Map<string, number>();
  let inFence = false;

  for (const line of (content || '').split('\n')) {
    const t = line.trim();
    if (t.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,3})\s+(.*)$/.exec(t);
    if (!m || !m[2].trim()) continue;

    const text = m[2].trim();
    const base = headingId(text);
    // Two headings can read the same; the anchor still has to be unique.
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);

    out.push({
      id: n === 1 ? base : `${base}-${n}`,
      text,
      level: m[1].length as 1 | 2 | 3,
    });
  }
  return out;
}

/**
 * Parses inline formatting:
 * - Highlights: ==highlight==, <mark>highlight</mark>, [hl:yellow]...[/hl], [hl:green]...[/hl], [hl:blue]...[/hl]
 * - Badges: [badge:green:Active], [badge:90% Profit Split]
 * - Buttons: [button:Get Funded](https://...), [btn:Learn More](url)
 * - Standard Markdown: **bold**, *italic*, `code`, ~~strike~~, [links](url)
 */
export function formatInlineText(text: string): React.ReactNode[] {
  // Master inline tokenizer
  const regex =
    /(==.*?==|<mark>.*?<\/mark>|\[hl:[a-zA-Z]+\][\s\S]*?\[\/hl\]|\[badge:(?:[a-zA-Z]+:)?[^\]]+\]|\[(?:button|btn):[^\]]+\]\([^)]+\)|\*\*.*?\*\*|\*.*?\*|`.*?`|~~.*?~~|\[.*?\]\(.*?\))/g;
  const parts = text.split(regex);

  return parts.map((part, index) => {
    if (!part) return null;

    // 1. Highlight Syntax: ==text==
    if (part.startsWith('==') && part.endsWith('==') && part.length >= 4) {
      const inner = part.slice(2, -2);
      return (
        <mark
          key={index}
          className="bg-warn/35 text-warn font-semibold px-1.5 py-0.5 rounded-md border-b-2 border-warn/70"
        >
          {inner}
        </mark>
      );
    }

    // 2. <mark>text</mark>
    if (part.startsWith('<mark>') && part.endsWith('</mark>')) {
      const inner = part.replace(/^<mark>/, '').replace(/<\/mark>$/, '');
      return (
        <mark
          key={index}
          className="bg-warn/35 text-warn font-semibold px-1.5 py-0.5 rounded-md border-b-2 border-warn/70"
        >
          {inner}
        </mark>
      );
    }

    // 3. Color-coded Highlights: [hl:green]text[/hl]
    const hlMatch = part.match(/^\[hl:([a-zA-Z]+)\]([\s\S]*?)\[\/hl\]$/);
    if (hlMatch) {
      const [, color, inner] = hlMatch;
      const colorMap: Record<string, string> = {
        yellow:
          'bg-warn/35 text-warn border-warn/70',
        green:
          'bg-success/35 text-success border-success/70',
        blue:
          'bg-accent/35 text-accent border-accent/70',
        purple:
          'bg-accent/35 text-accent border-accent/70',
        rose:
          'bg-danger/35 text-danger border-danger/70',
        red:
          'bg-danger/35 text-danger border-danger/70',
      };
      const style = colorMap[color.toLowerCase()] || colorMap.yellow;
      return (
        <mark
          key={index}
          className={`font-semibold px-1.5 py-0.5 rounded-md border-b-2 ${style}`}
        >
          {inner}
        </mark>
      );
    }

    // 4. Badges / Status Pills: [badge:Active] or [badge:green:Active]
    const badgeMatch = part.match(/^\[badge:(?:([a-zA-Z]+):)?([^\]]+)\]$/);
    if (badgeMatch) {
      const [, color = 'blue', label] = badgeMatch;
      const badgeStyles: Record<string, string> = {
        blue: 'bg-accent/10 text-accent border-accent/20',
        green: 'bg-success/10 text-success border-success/20',
        emerald: 'bg-success/10 text-success border-success/20',
        amber: 'bg-warn/10 text-warn border-warn/20',
        yellow: 'bg-warn/10 text-warn border-warn/20',
        rose: 'bg-danger/10 text-danger border-danger/20',
        red: 'bg-danger/10 text-danger border-danger/20',
        purple: 'bg-accent/10 text-accent border-accent/20',
        gray: 'bg-ink-3/10 text-ink-2 border-line-3/20',
      };
      const badgeClass = badgeStyles[color.toLowerCase()] || badgeStyles.blue;
      return (
        <span
          key={index}
          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border mx-1 align-baseline select-none ${badgeClass}`}
        >
          {label.trim()}
        </span>
      );
    }

    // 5. Embedded CTA Buttons: [button:Get Funded](https://...) or [btn:Get Funded](url)
    const btnMatch = part.match(/^\[(?:button|btn):([^\]]+)\]\(([^)]+)\)$/);
    if (btnMatch) {
      const [, label, url] = btnMatch;
      return (
        <a
          key={index}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 my-1 rounded-xl text-white font-semibold text-ui shadow-sm transition-all hover:opacity-95 hover:shadow-md active:scale-[0.98] cursor-pointer no-underline"
          style={{ backgroundColor: 'var(--brand, #007aff)' }}
        >
          <span>{label}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </a>
      );
    }

    // 6. Bold
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={index} className="font-bold text-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }

    // 7. Italic
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      return (
        <em key={index} className="italic text-ink-2">
          {part.slice(1, -1)}
        </em>
      );
    }

    // 8. Inline code
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={index}
          className="px-1.5 py-0.5 rounded-md bg-surface-3 text-accent font-mono text-xs font-semibold border border-line/60"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    // 9. Strikethrough
    if (part.startsWith('~~') && part.endsWith('~~') && part.length >= 4) {
      return (
        <del key={index} className="line-through text-ink-3">
          {part.slice(2, -2)}
        </del>
      );
    }

    // 10. Standard Link [title](url)
    const linkMatch = part.match(/^\[(.*?)\]\((.*?)\)$/);
    if (linkMatch) {
      const [, label, url] = linkMatch;
      return (
        <a
          key={index}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline font-medium inline-flex items-center gap-0.5"
        >
          {label}
        </a>
      );
    }

    return <span key={index}>{part}</span>;
  });
}

function CodeBlockWithCopy({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-4 rounded-xl border border-line-3/80 bg-invert text-slate-100 overflow-hidden shadow-md">
      <div className="px-4 py-2 bg-invert border-b border-line-3 flex items-center justify-between text-2xs text-ink-3 font-mono">
        <span>{language || 'code'}</span>
        <button
          onClick={handleCopy}
          type="button"
          className="hover:text-white flex items-center gap-1 transition-colors px-2 py-0.5 rounded bg-invert/80 hover:bg-ink-2"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-success" />
              <span className="text-success">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-4 text-xs font-mono leading-relaxed overflow-x-auto selection:bg-accent selection:text-white">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function MarkdownArticleContent({
  content,
  className = '',
}: MarkdownArticleContentProps) {
  if (!content) return null;

  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let index = 0;

  // Must produce the same ids, in the same order, as extractHeadings — the
  // table of contents links to these anchors.
  const headingCounts = new Map<string, number>();
  const nextHeadingId = (raw: string) => {
    const base = headingId(raw);
    const n = (headingCounts.get(base) || 0) + 1;
    headingCounts.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    // 1. Empty lines
    if (!trimmed) {
      elements.push(<div key={`empty-${index}`} className="h-2" />);
      index++;
      continue;
    }

    // 2. Fenced Code Blocks (```lang ... ```)
    if (trimmed.startsWith('```')) {
      const language = trimmed.replace('```', '').trim();
      index++;
      const codeLines: string[] = [];
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index++;
      }
      if (index < lines.length && lines[index].trim().startsWith('```')) {
        index++; // Skip closing fence
      }
      elements.push(
        <CodeBlockWithCopy
          key={`code-${index}`}
          language={language}
          code={codeLines.join('\n')}
        />
      );
      continue;
    }

    // 3. Tables (| Col 1 | Col 2 |)
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const tableLines: string[] = [];
      while (
        index < lines.length &&
        lines[index].trim().startsWith('|') &&
        lines[index].trim().endsWith('|')
      ) {
        tableLines.push(lines[index].trim());
        index++;
      }

      if (tableLines.length >= 2) {
        const headerCells = tableLines[0]
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim());
        // Check if second line is a divider row (---|---)
        const hasDivider = tableLines[1].includes('---');
        const dataRows = hasDivider ? tableLines.slice(2) : tableLines.slice(1);

        elements.push(
          <div
            key={`table-${index}`}
            className="overflow-x-auto my-4 rounded-xl border border-line shadow-xs bg-surface"
          >
            <table className="w-full text-left text-ui divide-y divide-line">
              <thead className="bg-surface-2 text-ink font-semibold">
                <tr>
                  {headerCells.map((header, hIdx) => (
                    <th key={hIdx} className="px-3.5 py-2.5 font-bold">
                      {formatInlineText(header)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {dataRows.map((rowStr, rIdx) => {
                  const cells = rowStr
                    .split('|')
                    .slice(1, -1)
                    .map((c) => c.trim());
                  return (
                    <tr
                      key={rIdx}
                      className={rIdx % 2 === 1 ? 'bg-surface-2/40' : 'bg-surface'}
                    >
                      {cells.map((cell, cIdx) => (
                        <td key={cIdx} className="px-3.5 py-2 text-ink-2">
                          {formatInlineText(cell)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    // 4. Callout Alerts (> [!NOTE], > [!TIP], > [!SUCCESS], > [!WARNING], > [!CAUTION], > [!DANGER], > [!CTA], > [!FEATURED])
    if (
      trimmed.startsWith('> [!NOTE]') ||
      trimmed.startsWith('> [!INFO]') ||
      trimmed.startsWith('> [!TIP]') ||
      trimmed.startsWith('> [!SUCCESS]') ||
      trimmed.startsWith('> [!WARNING]') ||
      trimmed.startsWith('> [!CAUTION]') ||
      trimmed.startsWith('> [!DANGER]') ||
      trimmed.startsWith('> [!CTA]') ||
      trimmed.startsWith('> [!FEATURED]')
    ) {
      let calloutType: 'note' | 'tip' | 'success' | 'warning' | 'caution' | 'cta' = 'note';
      if (trimmed.includes('[!TIP]')) calloutType = 'tip';
      if (trimmed.includes('[!SUCCESS]')) calloutType = 'success';
      if (trimmed.includes('[!WARNING]')) calloutType = 'warning';
      if (trimmed.includes('[!CAUTION]') || trimmed.includes('[!DANGER]')) calloutType = 'caution';
      if (trimmed.includes('[!CTA]') || trimmed.includes('[!FEATURED]')) calloutType = 'cta';

      index++;
      const calloutLines: string[] = [];
      while (
        index < lines.length &&
        lines[index].trim().startsWith('>') &&
        !lines[index].trim().startsWith('> [!')
      ) {
        calloutLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index++;
      }

      const styles = {
        note: {
          bg: 'bg-accent-soft/70 border-accent-line/80 text-accent',
          icon: <Lightbulb className="w-4 h-4 text-accent shrink-0 mt-0.5" />,
          title: 'Note',
          isCentered: false,
        },
        tip: {
          bg: 'bg-[#d7efdc]/60 border-[#1bb157]/30 text-success',
          icon: <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />,
          title: 'Pro Tip',
          isCentered: false,
        },
        success: {
          bg: 'bg-[#d7efdc]/70 border-[#1bb157]/35 text-success shadow-2xs',
          icon: <Sparkles className="w-4 h-4 text-success shrink-0 mt-0.5" />,
          title: 'Bonus / Upgrade',
          isCentered: false,
        },
        warning: {
          bg: 'bg-[#fff3cd]/70 border-[#d97706]/30 text-warn',
          icon: <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-0.5" />,
          title: 'Important Rule',
          isCentered: false,
        },
        caution: {
          bg: 'bg-[#ffebe9]/80 border-[#df2020]/30 text-danger',
          icon: <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />,
          title: 'Violation / Caution',
          isCentered: false,
        },
        cta: {
          bg: 'bg-[#e3e7fa]/80 border-[#334bfa]/30 text-accent text-center shadow-xs',
          icon: null,
          title: '',
          isCentered: true,
        },
      }[calloutType];

      const isCentered = styles.isCentered || calloutLines.some((l) => l.includes('[button:') || l.includes('[btn:'));

      elements.push(
        <div
          key={`callout-${index}`}
          className={`p-4 sm:p-5 my-4 rounded-2xl border transition-all ${styles.bg} ${
            isCentered ? 'flex flex-col items-center justify-center text-center gap-2.5' : 'flex items-start gap-3.5'
          } text-ui leading-relaxed`}
        >
          {!isCentered && styles.icon}
          <div className={`space-y-1.5 ${isCentered ? 'w-full max-w-lg mx-auto text-center' : 'flex-1'}`}>
            {styles.title && (
              <span className="font-bold uppercase tracking-wider text-2xs block opacity-85">
                {styles.title}
              </span>
            )}
            <div className={`space-y-2 ${isCentered ? 'flex flex-col items-center justify-center' : ''}`}>
              {calloutLines.map((cLine, cIdx) => (
                <div key={cIdx} className={isCentered ? 'text-center w-full' : ''}>
                  {formatInlineText(cLine)}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
      continue;
    }

    // 5. Blockquote (> text)
    if (trimmed.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (
        index < lines.length &&
        lines[index].trim().startsWith('>') &&
        !lines[index].trim().startsWith('> [!')
      ) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index++;
      }

      elements.push(
        <blockquote
          key={`quote-${index}`}
          className="pl-4 py-1.5 border-l-3 border-accent text-ink-2 italic bg-surface-2/40 rounded-r-lg my-3 space-y-1 text-ui"
        >
          {quoteLines.map((qLine, qIdx) => (
            <p key={qIdx}>{formatInlineText(qLine)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    // 6. Horizontal Divider (--- or ***)
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      elements.push(
        <hr key={`hr-${index}`} className="my-6 border-t border-line" />
      );
      index++;
      continue;
    }

    // 7. Headings
    if (trimmed.startsWith('# ')) {
      const raw = trimmed.replace('# ', '');
      elements.push(
        <h1
          key={`h1-${index}`}
          id={nextHeadingId(raw)}
          className="scroll-mt-24 text-2xl sm:text-3xl font-extrabold text-ink mt-7 mb-3 tracking-tight pb-2 border-b border-line"
        >
          {formatInlineText(trimmed.replace('# ', ''))}
        </h1>
      );
      index++;
      continue;
    }

    if (trimmed.startsWith('## ')) {
      const raw = trimmed.replace('## ', '');
      elements.push(
        <h2
          key={`h2-${index}`}
          id={nextHeadingId(raw)}
          className="scroll-mt-24 text-xl sm:text-2xl font-bold text-ink mt-6 mb-2 tracking-tight pb-1.5 border-b border-line/60"
        >
          {formatInlineText(trimmed.replace('## ', ''))}
        </h2>
      );
      index++;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      const raw = trimmed.replace('### ', '');
      elements.push(
        <h3
          key={`h3-${index}`}
          id={nextHeadingId(raw)}
          className="scroll-mt-24 text-base sm:text-lg font-bold text-ink mt-5 mb-1 tracking-tight"
        >
          {formatInlineText(trimmed.replace('### ', ''))}
        </h3>
      );
      index++;
      continue;
    }

    // 8. Task Checklists (- [ ] or - [x])
    if (trimmed.startsWith('- [ ] ') || trimmed.startsWith('- [x] ')) {
      const taskItems: React.ReactNode[] = [];
      while (
        index < lines.length &&
        (lines[index].trim().startsWith('- [ ] ') || lines[index].trim().startsWith('- [x] '))
      ) {
        const curTrim = lines[index].trim();
        const isChecked = curTrim.startsWith('- [x] ');
        const label = curTrim.replace(/^- \[( |x)\]\s*/, '');
        taskItems.push(
          <div key={`task-item-${index}`} className="flex items-center gap-2.5 py-1 text-ui">
            <input
              type="checkbox"
              readOnly
              checked={isChecked}
              className="w-4 h-4 rounded border-line text-accent cursor-default pointer-events-none"
            />
            <span className={isChecked ? 'line-through text-ink-3' : 'text-ink leading-relaxed'}>
              {formatInlineText(label)}
            </span>
          </div>
        );
        index++;
      }
      elements.push(
        <div key={`task-group-${index}`} className="my-2 space-y-1">
          {taskItems}
        </div>
      );
      continue;
    }

    // 9. Bullet Lists (- or *)
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const listItems: React.ReactNode[] = [];
      while (
        index < lines.length &&
        (lines[index].trim().startsWith('- ') || lines[index].trim().startsWith('* ')) &&
        !lines[index].trim().startsWith('- [ ] ') &&
        !lines[index].trim().startsWith('- [x] ')
      ) {
        const curTrim = lines[index].trim();
        const itemText = curTrim.substring(2).trim();
        listItems.push(
          <li key={`bullet-item-${index}`} className="text-sm text-ink-2 leading-relaxed">
            {formatInlineText(itemText)}
          </li>
        );
        index++;
      }
      elements.push(
        <ul key={`ul-${index}`} className="list-disc pl-6 space-y-1 my-2 text-ink">
          {listItems}
        </ul>
      );
      continue;
    }

    // 10. Numbered Lists (1., 2., etc.)
    if (/^\d+\.\s/.test(trimmed)) {
      const listItems: React.ReactNode[] = [];
      while (index < lines.length && /^\d+\.\s/.test(lines[index].trim())) {
        const curTrim = lines[index].trim();
        const itemText = curTrim.replace(/^\d+\.\s+/, '').trim();
        listItems.push(
          <li key={`ordered-item-${index}`} className="text-sm text-ink-2 leading-relaxed">
            {formatInlineText(itemText)}
          </li>
        );
        index++;
      }
      elements.push(
        <ol key={`ol-${index}`} className="list-decimal pl-6 space-y-1 my-2 text-ink">
          {listItems}
        </ol>
      );
      continue;
    }

    // 11. Standalone Images (![alt](url))
    const imgMatch = trimmed.match(/^!\[(.*?)\]\((.*?)\)$/);
    if (imgMatch) {
      const [, alt, src] = imgMatch;
      elements.push(
        <figure key={`img-${index}`} className="my-4 rounded-xl overflow-hidden border border-line bg-surface-2/40 shadow-xs">
          <img src={src} alt={alt} className="w-full h-auto object-contain max-h-[500px] mx-auto rounded-t-xl" loading="lazy" />
          {alt && (
            <figcaption className="text-xs text-ink-3 text-center py-2 px-4 italic border-t border-line/50 bg-surface">
              {alt}
            </figcaption>
          )}
        </figure>
      );
      index++;
      continue;
    }

    // 12. Standalone CTA Button ([button:Title](url))
    const btnBlockMatch = trimmed.match(/^\[(?:button|btn):([^\]]+)\]\(([^)]+)\)$/);
    if (btnBlockMatch) {
      const [, label, url] = btnBlockMatch;
      elements.push(
        <div key={`btn-block-${index}`} className="my-5 flex justify-center">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-white font-semibold text-sm shadow-sm transition-all hover:opacity-95 hover:shadow-md active:scale-[0.98] cursor-pointer no-underline"
            style={{ backgroundColor: 'var(--brand, #007aff)' }}
          >
            <span>{label}</span>
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      );
      index++;
      continue;
    }

    // 13. Normal Paragraph
    elements.push(
      <p key={`p-${index}`} className="text-sm text-ink leading-relaxed">
        {formatInlineText(trimmed)}
      </p>
    );
    index++;
  }

  return <div className={`space-y-2 text-ink ${className}`}>{elements}</div>;
}
