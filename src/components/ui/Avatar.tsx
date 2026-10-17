import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Six-way palette picked deterministically from the seed, so the same visitor
 * always gets the same colour across the list, the thread and the radar.
 */
const PALETTE = [
  { bg: '#2e5bff', fg: '#ffffff' },
  { bg: '#0f9d76', fg: '#ffffff' },
  { bg: '#7c5cff', fg: '#ffffff' },
  { bg: '#d97706', fg: '#ffffff' },
  { bg: '#e11d48', fg: '#ffffff' },
  { bg: '#0891b2', fg: '#ffffff' },
];

function hash(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function avatarColors(seed: string) {
  return PALETTE[hash(seed) % PALETTE.length];
}

const SIZES = {
  xs: 'w-6 h-6 text-2xs',
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-14 h-14 text-xl',
} as const;

const DOT = {
  xs: 'w-2 h-2',
  sm: 'w-2.5 h-2.5',
  md: 'w-3 h-3',
  lg: 'w-3.5 h-3.5',
} as const;

export function Avatar({
  name,
  seed,
  size = 'sm',
  online,
  color,
  muted,
  className,
}: {
  name: string;
  /** Stable identifier for colour selection; falls back to the name. */
  seed?: string;
  size?: keyof typeof SIZES;
  online?: boolean;
  /** Overrides the derived colour — used for workspace brand avatars. */
  color?: string;
  /** Neutral styling for identities with no name or email to colour-code. */
  muted?: boolean;
  className?: string;
}) {
  const picked = avatarColors(seed || name || '?');
  const useMuted = muted && !color;
  const bg = useMuted ? 'var(--ds-surface-3)' : color || picked.bg;
  const fg = useMuted ? 'var(--ds-ink-2)' : picked.fg;

  return (
    // The size lives on the wrapper too. Without an explicit height it would
    // stretch to the row in an `align-items: stretch` flex parent, dragging
    // the absolutely-positioned presence dot down with it.
    <div className={cn('relative shrink-0 rounded-full', SIZES[size], className)}>
      {/* Size and text size live on the wrapper alone. Repeating SIZES[size]
          here pinned the circle to the prop's dimensions, so a caller passing
          `className="w-5 h-5"` got a 20px wrapper around a 32px circle — it
          spilled out and overlapped the text beside it. */}
      <div
        className="w-full h-full rounded-full flex items-center justify-center font-semibold uppercase select-none"
        style={{ backgroundColor: bg, color: fg }}
      >
        {(name || '?').charAt(0)}
      </div>
      {online && (
        <span
          title="Active now"
          className={cn(
            'absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-surface bg-success shadow-xs',
            DOT[size]
          )}
        />
      )}
    </div>
  );
}
