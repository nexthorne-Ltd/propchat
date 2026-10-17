'use client';

import React, { useRef } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string> {
  id: T;
  label: React.ReactNode;
  count?: number;
}

/**
 * WAI-ARIA tabs with roving focus: Left/Right (and Home/End) move between
 * tabs and select them. `variant="pill"` is the segmented-control look for
 * small filters; "line" is the underlined look for page sections.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  variant = 'line',
  className,
  idPrefix,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  variant?: 'line' | 'pill';
  className?: string;
  /** When set, tabs get ids `${idPrefix}-tab-${id}` and control `${idPrefix}-panel-${id}`. */
  idPrefix?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (index: number) => {
    const n = items.length;
    const next = ((index % n) + n) % n;
    refs.current[next]?.focus();
    onChange(items[next].id);
  };

  return (
    <div role="tablist" aria-label={label} className={cn(variant === 'pill' ? 'tabs-pill' : 'tabs', className)}>
      {items.map((item, i) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.id}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${item.id}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') move(i + 1);
              else if (e.key === 'ArrowLeft') move(i - 1);
              else if (e.key === 'Home') move(0);
              else if (e.key === 'End') move(items.length - 1);
              else return;
              e.preventDefault();
            }}
            className="tab"
          >
            {item.label}
            {item.count !== undefined && (
              <span className="tabular-nums text-2xs text-ink-3 font-medium">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
