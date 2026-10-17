/*
 * Messages from server actions that survive a production build.
 *
 * In production Next.js replaces every error thrown by a server action with
 * "Minified React error #441" on the client, so "Enter a valid email" or
 * "Your plan allows 3 agents" never reached the person who needed it. Only
 * the error's `digest` is passed through. userError() puts the message there,
 * and errorMessage() reads it back on the client (or falls back to a plain
 * sentence for errors that were never meant to be shown, like a database
 * failure).
 *
 * Shared by server and client code: no imports.
 */

const PREFIX = 'ZENTRY_USER:';

/** An error whose message is meant for the person using the app. */
export function userError(message: string): Error {
  return markUserFacing(new Error(message));
}

/** Marks an existing error (or one being constructed) as safe to show. */
export function markUserFacing<E extends Error>(error: E): E {
  (error as E & { digest?: string }).digest = PREFIX + error.message;
  return error;
}

const GENERIC = 'Something went wrong. Please try again.';
const MASKED = /Minified React error #441|An error occurred in the Server Components render|omitted in production builds/i;
// A tab opened before a deploy asks for server actions the new build renamed.
const STALE_BUILD = /Server Action ".*" was not found on the server|failed-to-find-server-action/i;
const RELOADED_AT = 'zentry_reloaded_for_new_version';

/**
 * Reloads once to pick up the new version. Guarded so a page that keeps
 * failing does not reload in a loop.
 */
function reloadForNewVersion() {
  if (typeof window === 'undefined') return;
  try {
    const last = Number(window.sessionStorage.getItem(RELOADED_AT) || 0);
    if (Date.now() - last < 60_000) return;
    window.sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    return;
  }
  window.setTimeout(() => window.location.reload(), 800);
}

/** The message to show for something a catch block caught. */
export function errorMessage(error: unknown, fallback: string = GENERIC): string {
  const e = error as { digest?: unknown; message?: unknown } | null | undefined;
  if (e && typeof e.digest === 'string' && e.digest.startsWith(PREFIX)) return e.digest.slice(PREFIX.length);
  const message = typeof error === 'string' ? error : typeof e?.message === 'string' ? e.message : '';
  if (STALE_BUILD.test(message)) {
    reloadForNewVersion();
    return 'Zen-try was just updated. Reloading the page…';
  }
  if (!message || MASKED.test(message)) return fallback;
  return message;
}
