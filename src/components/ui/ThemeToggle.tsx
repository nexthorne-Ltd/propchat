'use client';

import React, { useCallback, useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'zentry-theme';
const LEGACY_STORAGE_KEY = 'chatify-theme';

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

/* ---------------------------------------------------------------------------
   The theme lives outside React — on <html data-theme> and in localStorage —
   so it is read through useSyncExternalStore. That keeps the server render and
   hydration consistent without a "mounted" flag, and lets every toggle on the
   page stay in sync with the others.
   --------------------------------------------------------------------------- */

const listeners = new Set<() => void>();

const systemDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // `storage` only fires in *other* tabs, which is exactly what we want on top
  // of the local notifications above.
  window.addEventListener('storage', onChange);

  // While on "system", follow the OS live so the attribute stays correct.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => {
    if (getSnapshot() === 'system') applyTheme('system');
    onChange();
  };
  mq.addEventListener('change', onSystemChange);

  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
    mq.removeEventListener('change', onSystemChange);
  };
}

function getSnapshot(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** No storage on the server; the inline bootstrap script settles it before paint. */
function getServerSnapshot(): Theme {
  return 'system';
}

/**
 * `data-theme` is the single source of truth — the token blocks and the
 * `dark:` custom variant in globals.css both key off it, so no companion
 * `.dark` class is needed.
 */
function applyTheme(theme: Theme) {
  // The attribute always carries a resolved value, never "system": the `dark:`
  // Tailwind variant matches on it and cannot read a media query. "system" is
  // represented by the ABSENCE of a stored preference instead.
  document.documentElement.setAttribute(
    'data-theme',
    theme === 'system' ? (systemDark() ? 'dark' : 'light') : theme
  );

  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode with storage disabled — the attribute swap still applies.
  }

  listeners.forEach((l) => l());
}

/** Segmented light / system / dark control. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const select = useCallback((next: Theme) => applyTheme(next), []);

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 p-0.5 rounded-full border border-line bg-surface-2',
        className
      )}
      role="radiogroup"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => select(value)}
            className={cn(
              // 44px touch targets on phones, compact on larger screens.
              'w-11 h-11 sm:w-7 sm:h-7 rounded-full flex items-center justify-center transition-colors duration-150',
              active
                ? 'bg-surface text-ink shadow-xs'
                : 'text-ink-3 hover:text-ink-2'
            )}
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        );
      })}
    </div>
  );
}
