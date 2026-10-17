import React from 'react';
import { Check, CheckCheck, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * WhatsApp-style delivery state for a message you sent.
 *
 *   pending    clock    still in flight, not yet persisted
 *   sent       ✓        stored on the server
 *   delivered  ✓✓       the other side's client acknowledged receipt
 *   read       ✓✓ blue  the other side actually looked at it
 *
 * Each step is a fact we hold a timestamp for. "Delivered" used to be inferred
 * from whether the visitor's heartbeat was recent, which showed a double tick
 * for someone sitting on the page with the messenger closed.
 */
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read';

export function messageStatusOf(msg: {
  id?: string;
  delivered_at?: string | null;
  read_at?: string | null;
  pending?: boolean;
}): MessageStatus {
  if (msg.pending) return 'pending';
  if (msg.read_at) return 'read';
  if (msg.delivered_at) return 'delivered';
  return 'sent';
}

const LABEL: Record<MessageStatus, string> = {
  pending: 'Sending…',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

export function MessageTicks({
  status,
  readAt,
  className,
  /** Ticks sit on a coloured bubble in the widget, on a light row here. */
  tone = 'muted',
}: {
  status: MessageStatus;
  readAt?: string | null;
  className?: string;
  tone?: 'muted' | 'onBrand';
}) {
  const title =
    status === 'read' && readAt
      ? `Read at ${new Date(readAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : LABEL[status];

  const base = cn('w-3.5 h-3.5 shrink-0', className);
  const dim = tone === 'onBrand' ? 'text-current opacity-70' : 'text-ink-3';

  return (
    <span className="inline-flex items-center" title={title} aria-label={title}>
      {status === 'pending' && <Clock className={cn(base, dim)} />}
      {status === 'sent' && <Check className={cn(base, dim)} />}
      {status === 'delivered' && <CheckCheck className={cn(base, dim)} />}
      {status === 'read' && (
        // The one place colour carries meaning rather than decoration.
        <CheckCheck className={cn(base, 'text-[#34b7f1]')} />
      )}
    </span>
  );
}
