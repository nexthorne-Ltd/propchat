'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, Loader2, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { flatten, moveHighlight, rankItems, type PaletteItem } from '@/lib/command-palette';
import { useFocusTrap, useIsClient } from './Modal';
import { errorMessage } from '@/lib/errors/user-error';

/**
 * Ctrl/Cmd+K launcher. A combobox: focus stays in the input, arrows move the
 * highlight (aria-activedescendant), Enter runs it, Esc closes. Static
 * commands are ranked locally; `search` adds remote results (tickets) for
 * the current query, debounced.
 */
interface PaletteProps {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
  onSelect: (item: PaletteItem) => void;
  search?: (query: string) => Promise<PaletteItem[]>;
  icons?: Partial<Record<string, React.ComponentType<{ className?: string }>>>;
  placeholder?: string;
}

export function CommandPalette(props: PaletteProps) {
  const mounted = useIsClient();
  // Unmounting the body on close is what resets the query and highlight.
  if (!props.open || !mounted) return null;
  return <PaletteBody {...props} />;
}

function PaletteBody({ onClose, items, onSelect, search, icons, placeholder = 'Jump to a ticket, view or setting…' }: PaletteProps) {
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<{ query: string; items: PaletteItem[] }>({ query: '', items: [] });
  const [searchError, setSearchError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  useFocusTrap(panelRef, true, onClose);

  const trimmed = query.trim();
  const searching = !!search && trimmed.length >= 2 && remote.query !== trimmed;

  useEffect(() => {
    if (!search || trimmed.length < 2) return;
    let cancelled = false;
    const t = setTimeout(() => {
      search(trimmed)
        .then((found) => {
          if (cancelled) return;
          setRemote({ query: trimmed, items: found });
          setSearchError(null);
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setRemote({ query: trimmed, items: [] });
          setSearchError(errorMessage(err, 'Ticket search failed.'));
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, trimmed]);

  const groups = useMemo(() => {
    const extra = remote.query === trimmed ? remote.items : [];
    return rankItems(query, [...extra, ...items]);
  }, [query, trimmed, items, remote]);
  const flat = useMemo(() => flatten(groups), [groups]);
  // Index of each group's first item in `flat`, for option ids.
  const offsets = useMemo(
    () => groups.map((_, gi) => groups.slice(0, gi).reduce((sum, g) => sum + g.items.length, 0)),
    [groups]
  );
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    onSelect(item);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setHighlight((h) => moveHighlight(h, 1, flat.length));
    else if (e.key === 'ArrowUp') setHighlight((h) => moveHighlight(h, -1, flat.length));
    else if (e.key === 'Home' && e.ctrlKey) setHighlight(0);
    else if (e.key === 'End' && e.ctrlKey) setHighlight(flat.length - 1);
    else if (e.key === 'Enter') run(flat[highlight]);
    else return;
    e.preventDefault();
  };

  const activeId = flat[highlight] ? `${listId}-${highlight}` : undefined;

  return createPortal(
    <div
      className="fixed inset-0 flex items-start justify-center px-4 pt-[12vh] bg-overlay animate-fade"
      style={{ zIndex: 'var(--ds-z-modal)' as unknown as number }}
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        className="popover w-full max-w-xl overflow-hidden animate-pop"
      >
        <div className="flex items-center gap-2.5 px-4 h-13 border-b border-line">
          {searching ? (
            <Loader2 className="w-4 h-4 text-ink-3 animate-spin shrink-0" aria-hidden="true" />
          ) : (
            <Search className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
          )}
          <input
            data-autofocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search commands"
            className="flex-1 h-12 bg-transparent text-md text-ink placeholder:text-ink-3 focus:outline-none focus-visible:shadow-none"
          />
          <kbd className="kbd hidden sm:inline-flex">Esc</kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
          {flat.length === 0 && !searching && (
            <p className="px-3 py-8 text-center text-ui text-ink-3" role="status">
              {searchError ? searchError : `No results for “${trimmed}”.`}
            </p>
          )}
          {groups.map((g, gi) => (
            <div key={g.group} role="group" aria-label={g.group} className="mb-1 last:mb-0">
              <div className="px-2.5 pt-2 pb-1 eyebrow">{g.group}</div>
              {g.items.map((item, ii) => {
                const i = offsets[gi] + ii;
                const Icon = icons?.[item.id] || icons?.[item.group];
                const active = i === highlight;
                return (
                  <div
                    key={item.id}
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={active}
                    onMouseMove={() => setHighlight(i)}
                    onClick={() => run(item)}
                    className={cn(
                      'flex items-center gap-3 px-2.5 h-10 rounded-lg cursor-pointer select-none',
                      active ? 'bg-accent-soft text-ink' : 'text-ink-2'
                    )}
                  >
                    {Icon && <Icon className={cn('w-4 h-4 shrink-0', active ? 'text-accent' : 'text-ink-3')} />}
                    <span className="flex-1 min-w-0 truncate text-ui font-medium text-ink">{item.title}</span>
                    {item.subtitle && <span className="hidden sm:block max-w-[40%] truncate text-xs text-ink-3">{item.subtitle}</span>}
                    {item.shortcut && (
                      <span className="hidden sm:flex gap-0.5">
                        {item.shortcut.map((k) => (
                          <kbd key={k} className="kbd">
                            {k}
                          </kbd>
                        ))}
                      </span>
                    )}
                    {active && <CornerDownLeft className="w-3.5 h-3.5 text-ink-3 shrink-0" aria-hidden="true" />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="hidden sm:flex items-center gap-4 px-4 h-9 border-t border-line text-2xs text-ink-3">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> to move
          </span>
          <span>
            <kbd className="kbd">↵</kbd> to open
          </span>
          <span className="ml-auto">
            <kbd className="kbd">Ctrl</kbd>
            <kbd className="kbd">K</kbd> anywhere
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
