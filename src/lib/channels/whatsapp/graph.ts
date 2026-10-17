import { userError } from '@/lib/errors/user-error';
/**
 * A thin client for the WhatsApp Business Cloud API (Meta Graph API), and the
 * one place that decides what a Graph error means for us: retry later, stop
 * and ask an admin to reconnect, or give up on this message.
 */

export const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v23.0';
const GRAPH = 'https://graph.facebook.com';

export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
  fbtrace_id?: string;
}

export interface GraphFailure {
  error: string;
  retryable: boolean;
  needsAttention: boolean;
  windowClosed: boolean;
  code?: number;
}

export class GraphError extends Error {
  constructor(readonly failure: GraphFailure) {
    super(failure.error);
  }
}

// Throttling and transient platform errors: the same request can succeed later.
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);
// The connection itself is broken: expired or revoked token, missing
// permission, the number or account is gone or not registered.
const ATTENTION_CODES = new Set([10, 190, 200, 368, 131031, 133010]);
// Outside the 24-hour customer service window.
const WINDOW_CODES = new Set([131047]);

/** Turns a Graph error (or a network failure) into a decision. */
export function classifyGraphError(httpStatus: number | null, body: GraphErrorBody | null | undefined): GraphFailure {
  const code = body?.code;
  const detail = body?.error_data?.details;
  const base = body?.message || (httpStatus ? `WhatsApp returned HTTP ${httpStatus}.` : 'Could not reach WhatsApp.');
  const error = detail && !base.includes(detail) ? `${base} ${detail}` : base;

  if (code !== undefined && WINDOW_CODES.has(code)) {
    return {
      error: 'More than 24 hours have passed since the customer last wrote. Send an approved template instead.',
      retryable: false,
      needsAttention: false,
      windowClosed: true,
      code,
    };
  }
  if (code !== undefined && ATTENTION_CODES.has(code)) {
    return { error, retryable: false, needsAttention: true, windowClosed: false, code };
  }
  if (code === 100 && body?.error_subcode === 33) {
    // "Object does not exist": the phone number id or account is wrong or was deleted.
    return { error, retryable: false, needsAttention: true, windowClosed: false, code };
  }
  if ((code !== undefined && RETRYABLE_CODES.has(code)) || httpStatus === null || httpStatus === 429 || httpStatus >= 500) {
    return { error, retryable: true, needsAttention: false, windowClosed: false, code };
  }
  return { error, retryable: false, needsAttention: false, windowClosed: false, code };
}

export async function graphRequest<T>(
  token: string,
  path: string,
  init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; query?: Record<string, string> } = {}
): Promise<T> {
  const url = new URL(`${GRAPH}/${GRAPH_VERSION}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(init.query || {})) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new GraphError(classifyGraphError(null, { message: `Could not reach WhatsApp: ${(err as Error).message}` }));
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: GraphErrorBody }) | null;
  if (!res.ok || json?.error) {
    throw new GraphError(classifyGraphError(res.status, json?.error));
  }
  return json as T;
}

/**
 * Embedded Signup returns a short-lived code; exchanging it with the app's
 * id and secret yields the business integration token for the customer's
 * WhatsApp Business Account.
 */
export async function exchangeSignupCode(code: string): Promise<string> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) throw userError('META_APP_ID and META_APP_SECRET must be set for embedded signup.');
  const url = new URL(`${GRAPH}/${GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('code', code);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const json = (await res.json().catch(() => null)) as { access_token?: string; error?: GraphErrorBody } | null;
  if (!res.ok || !json?.access_token) {
    throw new GraphError(classifyGraphError(res.status, json?.error || { message: 'Meta did not return an access token.' }));
  }
  return json.access_token;
}
