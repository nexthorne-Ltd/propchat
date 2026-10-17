'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Text hint on hover and keyboard focus. The trigger is described by the
 * tooltip (aria-describedby), Esc hides it, and it is rendered in a portal so
 * scroll containers can't clip it. Don't put interactive content in it.
 */
export function Tooltip({
  content,
  side = 'top',
  children,
}: {
  content: string;
  side?: 'top' | 'bottom';
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
}) {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = wrapRef.current?.firstElementChild as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: side === 'top' ? r.top - 6 : r.bottom + 6 });
    }, 250);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setPos(null);
  };

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [pos]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <span ref={wrapRef} className="contents" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {React.cloneElement(children, { 'aria-describedby': pos ? id : children.props['aria-describedby'] })}
      {pos &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            className="tooltip fixed"
            style={{
              left: pos.x,
              top: pos.y,
              transform: `translate(-50%, ${side === 'top' ? '-100%' : '0'})`,
              zIndex: 'var(--ds-z-tooltip)' as unknown as number,
            }}
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  );
}
