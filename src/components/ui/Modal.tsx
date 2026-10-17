'use client';

import React, { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Keeps Tab inside `ref` while active, focuses the first field on open and
 * gives focus back to whatever had it before on close. Esc calls `onEscape`.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void) {
  const escRef = useRef(onEscape);
  useLayoutEffect(() => {
    escRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = node.querySelector<HTMLElement>('[autofocus], [data-autofocus]') || node.querySelector<HTMLElement>(FOCUSABLE);
    (first || node).focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        escRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [ref, active]);
}

const noopSubscribe = () => () => {};

/** False during server render and hydration, true after: portals need document.body. */
export function useIsClient() {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

const WIDTH = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

/**
 * Centered dialog on a dimmed backdrop, rendered in a portal. Traps focus,
 * closes on Esc and backdrop click, and becomes a bottom sheet on phones.
 */
export function Modal({
  open = true,
  title,
  description,
  onClose,
  children,
  footer,
  wide,
  size,
  className,
}: {
  open?: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Legacy shorthand for size="lg". */
  wide?: boolean;
  size?: keyof typeof WIDTH;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const mounted = useIsClient();
  useFocusTrap(ref, mounted && open, onClose);

  if (!mounted || !open) return null;
  return createPortal(
    <div
      className="fixed inset-0 flex items-end sm:items-center justify-center sm:p-4 bg-overlay animate-fade"
      style={{ zIndex: 'var(--ds-z-modal)' as unknown as number }}
      onMouseDown={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          'popover w-full max-h-[92vh] flex flex-col rounded-b-none sm:rounded-2xl animate-pop outline-none',
          WIDTH[size ?? (wide ? 'lg' : 'md')],
          className
        )}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-line shrink-0">
          <div className="min-w-0">
            <h2 id={titleId} className="text-md font-semibold text-ink">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-xs text-ink-3">
                {description}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-icon -mr-2 -mt-1" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-line flex justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/** Panel that slides in from the right edge; full width on phones. */
export function Drawer({
  title,
  onClose,
  children,
  footer,
  width = 'max-w-md',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const mounted = useIsClient();
  useFocusTrap(ref, mounted, onClose);

  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 flex justify-end bg-overlay animate-fade"
      style={{ zIndex: 'var(--ds-z-modal)' as unknown as number }}
      onMouseDown={onClose}
    >
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={cn('popover h-full w-full flex flex-col rounded-none border-y-0 border-r-0 animate-drawer outline-none', width)}
      >
        <div className="flex items-center justify-between gap-3 px-5 h-14 border-b border-line shrink-0">
          <h2 id={titleId} className="text-md font-semibold text-ink truncate">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-icon -mr-2" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-line flex justify-end gap-2 shrink-0">{footer}</div>}
      </aside>
    </div>,
    document.body
  );
}
