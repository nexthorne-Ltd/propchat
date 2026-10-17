import { callApi, failureFromStatus, type ApiFailure, type ApiResponse, type RequestInitLite } from '@/lib/channels/http';

/**
 * A thin client for the Threads API (graph.threads.net) and what its errors
 * mean for us. Errors use Meta's Graph format.
 */

export const THREADS_GRAPH = 'https://graph.threads.net';
export const THREADS_VERSION = process.env.THREADS_GRAPH_API_VERSION || 'v1.0';

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string };
}

const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
const ATTENTION_CODES = new Set([10, 102, 190, 200]);

export function classifyThreadsError(status: number | null, raw: unknown): ApiFailure {
  const e = ((raw && typeof raw === 'object' ? raw : {}) as GraphErrorBody).error;
  const message = e?.error_user_msg || e?.message || (status ? `Threads returned HTTP ${status}.` : 'Could not reach Threads.');
  const code = e?.code;
  if (code !== undefined && ATTENTION_CODES.has(code)) {
    return { error: `${message} Reconnect Threads in Settings → Channels.`, retryable: false, needsAttention: true, status };
  }
  if (code !== undefined && RETRYABLE_CODES.has(code)) return { error: message, retryable: true, needsAttention: false, status };
  return failureFromStatus(status, message);
}

export function threadsRequest<T>(token: string, path: string, init: RequestInitLite & { versioned?: boolean } = {}): Promise<ApiResponse<T>> {
  const prefix = init.versioned === false ? THREADS_GRAPH : `${THREADS_GRAPH}/${THREADS_VERSION}`;
  return callApi<T>(`${prefix}/${path.replace(/^\//, '')}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } }, classifyThreadsError);
}
