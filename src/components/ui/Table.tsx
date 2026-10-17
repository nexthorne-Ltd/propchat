import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Data table shell: horizontal scroll on narrow screens, sticky header,
 * row hover. Rows that open something should be focusable buttons or links
 * inside a cell, not clickable <tr>s, so they work from the keyboard.
 */
export function Table({ className, children, label }: { className?: string; children: React.ReactNode; label?: string }) {
  return (
    <div className="w-full overflow-x-auto" role="region" aria-label={label} tabIndex={label ? 0 : undefined}>
      <table className={cn('table', className)}>{children}</table>
    </div>
  );
}

export function SortHeader({
  label,
  active,
  direction,
  onSort,
}: {
  label: string;
  active: boolean;
  direction: 'asc' | 'desc';
  onSort: () => void;
}) {
  return (
    <th aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={onSort} className="inline-flex items-center gap-1 uppercase hover:text-ink">
        {label}
        {active && <span aria-hidden="true">{direction === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  );
}
