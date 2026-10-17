import React from 'react';
import { cn } from '@/lib/utils';
import { Linkified } from './Linkified';

/**
 * Markdown sized for a chat bubble — what the AI assistant writes: `###`
 * headings, bullet and numbered lists, **bold**, links. Built as React nodes,
 * never HTML strings, so message text cannot inject markup.
 *
 * MarkdownArticleContent is the article renderer; its headings and spacing
 * are page-sized and swamp a bubble.
 */

const INLINE =
  /(\*\*[^*]+?\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^\s)]+\)|(?<![*\w])\*(?!\s)[^*]+?\*(?!\w))/g;

function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (!part) return null;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key} className="font-semibold"><Linkified text={part.slice(2, -2)} /></strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="px-1 py-px rounded bg-black/5 text-[0.92em] font-mono">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 break-all">
          {link[1]}
        </a>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    // Plain text: URLs, www. and bare domains, and emails become links.
    return <Linkified key={key} text={part} />;
  });
}

export function ChatMarkdown({ content, className }: { content: string; className?: string }) {
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: React.ReactNode[][] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const k = `p-${blocks.length}`;
    blocks.push(
      <p key={k} className="my-0 [&:not(:last-child)]:mb-2">
        {para.map((line, i) => (
          <React.Fragment key={i}>
            {i > 0 && <br />}
            {inline(line, `${k}-${i}`)}
          </React.Fragment>
        ))}
      </p>
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const k = `l-${blocks.length}`;
    const items = list.items.map((item, i) => (
      <li key={i} className="mb-1 last:mb-0 pl-0.5">
        {item}
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={k} className="list-decimal pl-5 my-1 [&:not(:last-child)]:mb-2">{items}</ol>
      ) : (
        <ul key={k} className="list-disc pl-5 my-1 [&:not(:last-child)]:mb-2 marker:text-current/60">{items}</ul>
      )
    );
    list = null;
  };

  content.replace(/\r\n/g, '\n').split('\n').forEach((line, n) => {
    const trimmed = line.trim();
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);

    if (!trimmed) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push(
        <p
          key={`h-${n}`}
          role="heading"
          aria-level={3}
          className="font-bold text-[1.04em] leading-snug tracking-tight mt-2.5 first:mt-0 mb-1"
        >
          {inline(heading[1].replace(/\*\*/g, ''), `h-${n}`)}
        </p>
      );
    } else if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushPara();
      flushList();
      blocks.push(<hr key={`hr-${n}`} className="my-2 border-current/15" />);
    } else if (bullet || numbered) {
      flushPara();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(inline((bullet || numbered)![1], `li-${n}`));
    } else if (list && /^\s{2,}/.test(line)) {
      const last = list.items[list.items.length - 1];
      last.push(<br key={`br-${n}`} />, ...inline(trimmed, `lc-${n}`));
    } else {
      flushList();
      para.push(trimmed);
    }
  });
  flushPara();
  flushList();

  return <div className={cn('whitespace-normal break-words', className)}>{blocks}</div>;
}
