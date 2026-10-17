import { serviceClient } from '@/lib/supabase/service';

/*
 * Server side of the widget's visitor session (docs/AUDIT.md H-3). Routes the
 * widget or tracker.js call from a customer's site (tracking, geo, CSAT) get a
 * visitor id and the session token the browser holds; this checks the pair
 * with fn_widget_auth, the same check every fn_widget_* function makes, so a
 * copied visitor id alone cannot act for someone else.
 *
 * Server only: it uses the service role.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface VisitorSession {
  visitorId: string;
  workspaceId: string | null;
}

export function looksLikeVisitorId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The visitor's session when `token` is theirs; null otherwise (or when the check itself failed). */
export async function verifyVisitorToken(visitorId: unknown, token: unknown): Promise<VisitorSession | null> {
  if (!looksLikeVisitorId(visitorId) || typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const { data, error } = await serviceClient().rpc('fn_widget_auth', { p_visitor_id: visitorId, p_token: token });
  if (error || !data) {
    if (error && !/visitor_session_invalid/.test(error.message || '')) {
      console.error('[Visitor Token Error]:', error.message);
    }
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { workspace_id?: string | null } | undefined;
  return { visitorId, workspaceId: row?.workspace_id ?? null };
}

/**
 * Starts or resumes a session (tracker.js has no Supabase client of its own).
 * Returns the token when one was newly issued, or `invalid` when this visitor
 * id already has a token the caller did not present.
 */
export async function openVisitorSession(
  workspaceId: string,
  visitorId: string,
  token: string | null
): Promise<{ ok: true; token: string | null; workspaceId: string } | { ok: false; reason: 'invalid' | 'error' }> {
  const { data, error } = await serviceClient().rpc('fn_widget_session', {
    p_workspace_id: workspaceId,
    p_visitor_id: visitorId,
    p_token: token && TOKEN_RE.test(token) ? token : null,
  });
  if (error) {
    if (/visitor_session_invalid|workspace_not_found/.test(error.message || '')) return { ok: false, reason: 'invalid' };
    console.error('[Visitor Session Error]:', error.message);
    return { ok: false, reason: 'error' };
  }
  return { ok: true, token: (data as { token?: string | null } | null)?.token ?? null, workspaceId };
}
