import type { SendResult } from './types';

/**
 * The small amount of HTTP plumbing the social channel adapters (X, LinkedIn,
 * TikTok, Threads) share: one request function with a timeout, and one error
 * type that already says what to do about the failure, which is all the
 * outbound worker and the poller need to know.
 */

export interface ApiFailure {
  error: string;
  /** Worth trying again later (rate limit, outage, network). */
  retryable: boolean;
  /** The connection is broken (token revoked or expired, permission lost, credits gone): an admin must act. */
  needsAttention: boolean;
  status: number | null;
}

export class ChannelApiError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.error);
  }
}

export type Classify = (status: number | null, body: unknown, headers: Headers | null) => ApiFailure;

export interface ApiResponse<T> {
  status: number;
  json: T;
  headers: Headers;
}

export interface RequestInitLite {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  query?: Record<string, string | undefined>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
  timeoutMs?: number;
}

/** Fetches `url`; any non-2xx answer, or a network failure, becomes a ChannelApiError via `classify`. */
export async function callApi<T = unknown>(url: string, init: RequestInitLite, classify: Classify): Promise<ApiResponse<T>> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(init.query || {})) if (v !== undefined) target.searchParams.set(k, v);
  const headers: Record<string, string> = { ...(init.headers || {}) };
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  }
  let res: Response;
  try {
    res = await fetch(target, { method: init.method || 'GET', headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
  } catch (err) {
    throw new ChannelApiError(classify(null, { message: `Could not reach the platform: ${(err as Error).message}` }, null));
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.slice(0, 300) };
    }
  }
  if (!res.ok) throw new ChannelApiError(classify(res.status, json, res.headers));
  return { status: res.status, json: json as T, headers: res.headers };
}

/** A send that threw becomes the SendResult the outbound worker records. */
export function sendFailure(err: unknown): Extract<SendResult, { ok: false }> {
  if (err instanceof ChannelApiError) {
    const f = err.failure;
    return { ok: false, error: f.error, retryable: f.retryable, needsAttention: f.needsAttention };
  }
  return { ok: false, error: (err as Error)?.message || 'Could not send.', retryable: true };
}

/** The usual mapping from HTTP status to what to do, for adapters with nothing more specific. */
export function failureFromStatus(status: number | null, message: string): ApiFailure {
  if (status === null || status === 429 || status >= 500 || status === 408) return { error: message, retryable: true, needsAttention: false, status };
  if (status === 401) return { error: message, retryable: false, needsAttention: true, status };
  return { error: message, retryable: false, needsAttention: false, status };
}
