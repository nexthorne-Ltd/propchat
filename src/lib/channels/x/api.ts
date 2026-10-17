import { callApi, failureFromStatus, type ApiFailure, type ApiResponse, type RequestInitLite } from '@/lib/channels/http';

/**
 * A thin client for the X API v2 (api.x.com/2) with an OAuth 2.0 user access
 * token, and what X's errors mean for us.
 *
 * X bills by usage (credits bought in the developer console), so "402" is not
 * a bug: the credits ran out and an admin has to add more.
 */

export const X_API = 'https://api.x.com/2';

interface XErrorBody {
  title?: string;
  detail?: string;
  type?: string;
  status?: number;
  message?: string;
  errors?: { message?: string; code?: number }[];
}

export function classifyXError(status: number | null, raw: unknown, headers: Headers | null): ApiFailure {
  const body = (raw && typeof raw === 'object' ? raw : {}) as XErrorBody;
  const detail = body.detail || body.errors?.[0]?.message || body.message || body.title;
  const base = detail || (status ? `X returned HTTP ${status}.` : 'Could not reach X.');

  if (status === 402 || body.title === 'CreditsDepleted') {
    return { error: 'Your X API credits have run out. Add credits in the X developer console (Billing), then try again.', retryable: false, needsAttention: true, status };
  }
  if (status === 401) {
    return { error: `X rejected the access token (${base}). Reconnect X in Settings → Channels.`, retryable: false, needsAttention: true, status };
  }
  if (status === 403) {
    if (/client-not-enrolled|not.*enrolled|project/i.test(`${body.type} ${detail}`)) {
      return { error: 'Your X app is not attached to a Project with API access. Check the app in the X developer console.', retryable: false, needsAttention: true, status };
    }
    return { error: `X refused this request: ${base}`, retryable: false, needsAttention: false, status };
  }
  if (status === 429) {
    const reset = Number(headers?.get('x-rate-limit-reset'));
    const wait = Number.isFinite(reset) && reset > 0 ? Math.max(0, Math.ceil(reset - Date.now() / 1000)) : null;
    return { error: `X is rate limiting this account${wait ? `; try again in about ${Math.ceil(wait / 60)} minutes` : ''}.`, retryable: true, needsAttention: false, status };
  }
  return failureFromStatus(status, base);
}

export function xRequest<T>(token: string, path: string, init: RequestInitLite = {}): Promise<ApiResponse<T>> {
  return callApi<T>(`${X_API}/${path.replace(/^\//, '')}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } }, classifyXError);
}
