import React from 'react';
import { splitLinks } from '@/lib/text/links';

/**
 * Plain message text with its links clickable (URLs, www. and bare domains,
 * emails; see src/lib/text/links.ts). Everything stays React text nodes.
 */
export function Linkified({ text, className }: { text: string; className?: string }) {
  return (
    <>
      {splitLinks(text).map((part, i) =>
        part.href ? (
          <a
            key={i}
            href={part.href}
            target={part.href.startsWith('mailto:') ? undefined : '_blank'}
            rel="noopener noreferrer"
            className={className ?? 'underline underline-offset-2 [overflow-wrap:anywhere]'}
            // Bubbles have their own click handlers (reply, select).
            onClick={(e) => e.stopPropagation()}
          >
            {part.text}
          </a>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        )
      )}
    </>
  );
}
