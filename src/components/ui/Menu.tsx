'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  /** Small colour swatch shown before the label. */
  dot?: string;
  description?: string;
  danger?: boolean;
}

/**
 * Lightweight popover select rendered in a document.body portal with fixed positioning.
 * Immune to container overflow clipping, with automatic viewport flipping and boundary clamping.
 */
export function Menu<T extends string>({
  value,
  options,
  onChange,
  align = 'end',
  side = 'bottom',
  trigger,
  className,
  menuClassName,
  label,
  footer,
}: {
  value: T;
  options: MenuOption<T>[];
  onChange: (value: T) => void;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  /** Custom trigger; defaults to a bordered button showing the active label. */
  trigger?: (args: { active?: MenuOption<T>; open: boolean }) => React.ReactNode;
  className?: string;
  menuClassName?: string;
  label?: string;
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  }>({ top: 0, left: 0, maxHeight: 360 });

  useEffect(() => {
    setMounted(true);
  }, []);

  const updatePosition = useCallback(() => {
    if (!rootRef.current) return;
    const triggerEl =
      (rootRef.current.firstElementChild as HTMLElement) || rootRef.current;
    const rect = triggerEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const PADDING = 8;
    const GAP = 6;

    // Use measured dimensions if available, fallback to typical dropdown size
    const menuEl = menuRef.current;
    const menuWidth = menuEl?.offsetWidth || 220;
    const menuHeight = menuEl?.offsetHeight || 220;

    // ── Vertical Placement & Flipping ──
    const spaceBelow = viewportHeight - rect.bottom - GAP - PADDING;
    const spaceAbove = rect.top - GAP - PADDING;

    let computedTop: number;
    let computedMaxHeight: number;

    if (side === 'bottom') {
      if (menuHeight > spaceBelow && spaceAbove > spaceBelow) {
        computedTop = Math.max(PADDING, rect.top - GAP - menuHeight);
        computedMaxHeight = Math.min(360, spaceAbove);
      } else {
        computedTop = rect.bottom + GAP;
        computedMaxHeight = Math.min(360, spaceBelow);
      }
    } else {
      if (menuHeight > spaceAbove && spaceBelow > spaceAbove) {
        computedTop = rect.bottom + GAP;
        computedMaxHeight = Math.min(360, spaceBelow);
      } else {
        computedTop = Math.max(PADDING, rect.top - GAP - menuHeight);
        computedMaxHeight = Math.min(360, spaceAbove);
      }
    }

    // ── Horizontal Placement & Flipping / Viewport Clamping (e.g. at 880px width) ──
    let computedLeft: number;

    if (align === 'start') {
      computedLeft = rect.left;
      if (computedLeft + menuWidth > viewportWidth - PADDING) {
        const flipped = rect.right - menuWidth;
        if (flipped >= PADDING) {
          computedLeft = flipped;
        }
      }
    } else {
      // align === 'end'
      computedLeft = rect.right - menuWidth;
      if (computedLeft < PADDING) {
        const flipped = rect.left;
        if (flipped + menuWidth <= viewportWidth - PADDING) {
          computedLeft = flipped;
        }
      }
    }

    // Strict boundary clamping within [PADDING, viewportWidth - menuWidth - PADDING]
    computedLeft = Math.max(
      PADDING,
      Math.min(computedLeft, viewportWidth - menuWidth - PADDING)
    );

    setCoords({
      top: Math.round(computedTop),
      left: Math.round(computedLeft),
      maxHeight: Math.round(Math.max(120, computedMaxHeight)),
    });
  }, [align, side]);

  useEffect(() => {
    if (!open) return;

    updatePosition();
    const rafId = requestAnimationFrame(updatePosition);

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };

    // Capture phase listener for Escape key: closes ONLY the menu, stopping propagation so
    // parent containers (e.g. ChatThread / Dashboard) do NOT deselect or close the conversation!
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };

    const handleScrollOrResize = () => {
      updatePosition();
    };

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);

    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
    };
  }, [open, updatePosition]);

  const active = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!open) {
            updatePosition();
          }
          setOpen((o) => !o);
        }}
        className="block w-full text-left"
      >
        {trigger ? (
          trigger({ active, open })
        ) : (
          <span className="btn btn-sm btn-secondary w-full justify-between">
            <span className="flex items-center gap-1.5 truncate">
              {active?.dot && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: active.dot }}
                />
              )}
              <span className="truncate">{active?.label ?? 'Select'}</span>
            </span>
            <ChevronDown
              className={cn(
                'w-3.5 h-3.5 text-ink-3 transition-transform duration-150',
                open && 'rotate-180'
              )}
            />
          </span>
        )}
      </button>

      {open &&
        mounted &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="listbox"
            style={{
              position: 'fixed',
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              maxHeight: `${coords.maxHeight}px`,
              maxWidth: 'calc(100vw - 16px)',
              overflowY: 'auto',
              zIndex: 9999,
            }}
            className={cn(
              'popover w-64 max-w-[calc(100vw-16px)] p-1 rounded-xl animate-pop',
              menuClassName
            )}
          >
            {options.map((opt) => {
              const selected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer',
                    opt.danger
                      ? 'text-danger hover:bg-danger-soft'
                      : 'text-ink hover:bg-surface-3'
                  )}
                >
                  {opt.dot && (
                    <span
                      className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: opt.dot }}
                    />
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="block text-ui font-medium truncate">
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span className="block text-xs text-ink-3 truncate">
                        {opt.description}
                      </span>
                    )}
                  </span>
                  {selected && (
                    <Check className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
                  )}
                </button>
              );
            })}
            {footer}
          </div>,
          document.body
        )}
    </div>
  );
}
