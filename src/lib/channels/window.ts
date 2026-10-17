/**
 * The customer service window: on WhatsApp a business may send free-form
 * messages only within 24 hours of the customer's last message; after that
 * only a pre-approved template. The database enforces it
 * (fn_channel_template_required); this mirror lets the composer explain it
 * before the agent types a reply that would be refused.
 */
export interface ServiceWindow {
  /** Free-form replies are allowed right now. */
  open: boolean;
  /** When the window closes (or closed); null when the customer never wrote. */
  expiresAt: Date | null;
  /** Milliseconds left; 0 once closed. */
  remainingMs: number;
}

export function serviceWindow(
  lastInboundAt: string | Date | null | undefined,
  windowHours: number | null,
  now: Date = new Date()
): ServiceWindow {
  if (windowHours === null) return { open: true, expiresAt: null, remainingMs: Infinity };
  const last = lastInboundAt ? new Date(lastInboundAt) : null;
  if (!last || Number.isNaN(last.getTime())) return { open: false, expiresAt: null, remainingMs: 0 };
  const expiresAt = new Date(last.getTime() + windowHours * 3_600_000);
  const remainingMs = Math.max(0, expiresAt.getTime() - now.getTime());
  return { open: remainingMs > 0, expiresAt, remainingMs };
}

/** "3h 12m" / "45m" / "under a minute". */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
