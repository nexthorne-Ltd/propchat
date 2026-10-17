import { Visitor, VisitorPageHistory } from '@/types/database';

/**
 * Default presence window in seconds. Visitors without a heartbeat for 90s
 * or marked is_online = false are considered offline.
 */
export const ONLINE_PRESENCE_WINDOW_SECONDS = 90;

/**
 * Minimum interval between client-side route change updates to avoid flooding.
 */
export const ROUTE_CHANGE_THROTTLE_MS = 500;

/**
 * Heartbeat interval in milliseconds (20 seconds).
 */
export const HEARTBEAT_INTERVAL_MS = 20000;

/**
 * Checks whether a visitor is currently online based on is_online flag
 * and recent last_seen / last_seen_at timestamp.
 */
export function isVisitorOnline(
  visitor: {
    is_online?: boolean | null;
    last_seen?: string | null;
    last_seen_at?: string | null;
  } | null | undefined,
  nowMs: number = Date.now(),
  windowSeconds: number = ONLINE_PRESENCE_WINDOW_SECONDS
): boolean {
  if (!visitor) return false;
  if (visitor.is_online === false) return false;

  const rawStamp = visitor.last_seen || visitor.last_seen_at;
  if (!rawStamp) return false;

  const stampMs = new Date(rawStamp).getTime();
  if (isNaN(stampMs)) return false;

  const diffSec = (nowMs - stampMs) / 1000;
  return diffSec >= 0 && diffSec < windowSeconds;
}

/**
 * Filter a list of visitors to only those currently active/online.
 */
export function filterOnlineVisitors<T extends {
  is_online?: boolean | null;
  last_seen?: string | null;
  last_seen_at?: string | null;
}>(
  visitors: T[],
  nowMs: number = Date.now(),
  windowSeconds: number = ONLINE_PRESENCE_WINDOW_SECONDS
): T[] {
  return visitors.filter((v) => isVisitorOnline(v, nowMs, windowSeconds));
}

/**
 * Formats time spent on a page into readable human format.
 * Examples: '14s', '2m 35s', '1h 12m'
 */
export function formatTimeOnPage(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) {
    return '0s';
  }

  const s = Math.round(seconds);
  if (s < 60) {
    return `${s}s`;
  }

  const mins = Math.floor(s / 60);
  const remainingSecs = s % 60;
  if (mins < 60) {
    return remainingSecs > 0 ? `${mins}m ${remainingSecs}s` : `${mins}m`;
  }

  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
}

/**
 * Calculates current time on page in seconds.
 * Prioritizes elapsed time from current_page_entered_at if available;
 * otherwise uses reported time_on_page_seconds.
 */
export function calculateTimeOnPage(
  enteredAt: string | null | undefined,
  fallbackSeconds: number | null | undefined = 0,
  nowMs: number = Date.now()
): number {
  if (enteredAt) {
    const enteredMs = new Date(enteredAt).getTime();
    if (!isNaN(enteredMs) && enteredMs <= nowMs) {
      const diffSec = Math.round((nowMs - enteredMs) / 1000);
      return Math.max(0, diffSec);
    }
  }

  return Math.max(0, Math.round(fallbackSeconds || 0));
}

/**
 * Determines whether a client-side route navigation should be throttled.
 * Returns true if same URL or if triggered too rapidly within minThrottleMs.
 */
export function shouldThrottleNavigation(
  previousUrl: string,
  newUrl: string,
  lastNavigatedAtMs: number,
  nowMs: number = Date.now(),
  minThrottleMs: number = ROUTE_CHANGE_THROTTLE_MS
): boolean {
  if (!newUrl) return true;
  if (previousUrl === newUrl) return true;
  if (nowMs - lastNavigatedAtMs < minThrottleMs) return true;
  return false;
}

/**
 * Extracts normalized path, title, and domain for clean UI display.
 */
export function formatPageDisplay(
  rawUrl: string | null | undefined,
  rawTitle?: string | null | undefined
): {
  url: string;
  path: string;
  domain: string;
  title: string;
} {
  const url = rawUrl?.trim() || '/';
  let path = url;
  let domain = '';

  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const parsed = new URL(url);
      domain = parsed.hostname;
      path = parsed.pathname + (parsed.search || '') + (parsed.hash || '');
    } else if (url.startsWith('/')) {
      path = url;
    }
  } catch {
    path = url;
  }

  const title = rawTitle?.trim() || (path === '/' ? 'Home' : path);

  return {
    url,
    path: path || '/',
    domain,
    title,
  };
}
