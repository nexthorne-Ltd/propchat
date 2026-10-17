'use client';

import React from 'react';
import { AtSign, Briefcase, Camera, Globe, Mail, MessageCircle, MessagesSquare, Music2, Phone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CHANNEL_LABEL, PRIORITY_LABEL, STATUS_LABEL } from '@/lib/tickets/views';
import type { TicketChannel, TicketPriority, TicketStatus } from '@/types/database';

const STATUS_STYLE: Record<TicketStatus, string> = {
  new: 'bg-warn-soft text-warn border-warn-line',
  open: 'bg-danger-soft text-danger border-danger-line',
  pending: 'bg-info-soft text-info border-info/30',
  on_hold: 'bg-surface-3 text-ink border-line-2',
  solved: 'bg-success-soft text-success border-success-line',
  closed: 'bg-surface-2 text-ink-3 border-line',
};

export function StatusBadge({ status, className }: { status: TicketStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 h-5 rounded-md border text-2xs font-bold uppercase tracking-wide whitespace-nowrap',
        STATUS_STYLE[status],
        className
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

const PRIORITY_DOT: Record<TicketPriority, string> = {
  low: 'bg-line-3',
  normal: 'bg-info',
  high: 'bg-warn',
  urgent: 'bg-danger',
};

export function PriorityLabel({ priority, className }: { priority: TicketPriority; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-ink-2 whitespace-nowrap', className)}>
      <span className={cn('w-2 h-2 rounded-full', PRIORITY_DOT[priority])} aria-hidden />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

const CHANNEL_ICON: Record<TicketChannel, typeof Mail> = { chat: MessageCircle, email: Mail, web_form: Globe, whatsapp: Phone, instagram: Camera, x: AtSign, threads: MessagesSquare, linkedin: Briefcase, tiktok: Music2 };

export function ChannelIcon({ channel, className }: { channel: TicketChannel; className?: string }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <span title={CHANNEL_LABEL[channel]} aria-label={CHANNEL_LABEL[channel]} className={cn('inline-flex text-ink-3', className)}>
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fullTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

/** Toggle chips for picking several values, used by the view editor. */
export function ChipGroup<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T[];
  onChange: (next: T[]) => void;
  label: string;
}) {
  return (
    <fieldset>
      <legend className="text-xs font-semibold text-ink-2 mb-1.5">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = value.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(active ? value.filter((v) => v !== o.value) : [...value, o.value])}
              className={cn(
                'px-2.5 h-7 rounded-lg border text-xs font-medium transition-colors',
                active ? 'bg-accent-soft border-accent-line text-accent' : 'bg-surface border-line text-ink-2 hover:bg-surface-2'
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Ticket and team dialogs use the shared modal (focus trap, Esc, glass surface). */
export { Modal } from '@/components/ui/Modal';

export { inputClass, selectClass } from '@/components/ui/Input';

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="block text-2xs text-ink-3 mt-1">{hint}</span>}
    </label>
  );
}
