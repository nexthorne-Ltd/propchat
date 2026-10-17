import { ChannelApiError, callApi, failureFromStatus, type ApiFailure, type ApiResponse, type RequestInitLite } from '@/lib/channels/http';

/**
 * A thin client for the TikTok API for Business (business-api.tiktok.com).
 * Unlike most APIs it answers HTTP 200 for failures too, with a non-zero
 * `code`; `tiktokRequest` turns those into errors as well.
 */

export const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';

interface TikTokEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
  request_id?: string;
}

// Token invalid, expired or revoked (TikTok's 401xx family).
const TOKEN_CODES = new Set([40100, 40101, 40102, 40104, 40105]);

export function classifyTikTokError(status: number | null, raw: unknown): ApiFailure {
  const b = (raw && typeof raw === 'object' ? raw : {}) as TikTokEnvelope<unknown>;
  const base = b.message || (status ? `TikTok returned HTTP ${status}.` : 'Could not reach TikTok.');
  if (b.code !== undefined && TOKEN_CODES.has(b.code)) {
    return { error: `TikTok rejected the access token (${base}). Reconnect TikTok in Settings → Channels.`, retryable: false, needsAttention: true, status };
  }
  if (b.code !== undefined && /rate|frequen|too many/i.test(base)) return { error: base, retryable: true, needsAttention: false, status };
  if (status === null || (status !== 200 && status !== undefined)) return failureFromStatus(status, base);
  return { error: base, retryable: false, needsAttention: false, status };
}

export async function tiktokRequest<T>(token: string, path: string, init: RequestInitLite = {}): Promise<ApiResponse<TikTokEnvelope<T>>> {
  const res = await callApi<TikTokEnvelope<T>>(`${TIKTOK_API}/${path.replace(/^\//, '')}`, { ...init, headers: { ...(init.headers || {}), 'Access-Token': token } }, classifyTikTokError);
  if (res.json && typeof res.json.code === 'number' && res.json.code !== 0) {
    throw new ChannelApiError(classifyTikTokError(res.status, res.json));
  }
  return res;
}
