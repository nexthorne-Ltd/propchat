import { callApi, failureFromStatus, type ApiFailure, type ApiResponse, type RequestInitLite } from '@/lib/channels/http';

/**
 * A thin client for LinkedIn's versioned REST API (api.linkedin.com/rest) and
 * what its errors mean for us. Every call carries the API version header
 * (LinkedIn retires versions after about a year; set LINKEDIN_API_VERSION to
 * a current YYYYMM) and the Rest.li protocol header.
 */

export const LINKEDIN_API = 'https://api.linkedin.com/rest';
export const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION || '202601';

interface LinkedInErrorBody {
  message?: string;
  code?: string;
  serviceErrorCode?: number;
  status?: number;
}

export function classifyLinkedInError(status: number | null, raw: unknown): ApiFailure {
  const b = (raw && typeof raw === 'object' ? raw : {}) as LinkedInErrorBody;
  const base = b.message || (status ? `LinkedIn returned HTTP ${status}.` : 'Could not reach LinkedIn.');
  if (status === 401) {
    return { error: 'LinkedIn rejected the access token: it expired or was revoked. Reconnect LinkedIn in Settings → Channels.', retryable: false, needsAttention: true, status };
  }
  if (status === 403) {
    return {
      error: `LinkedIn refused this request (${base}). The connecting person must be an administrator of the Page, and your LinkedIn app needs the Community Management API approved.`,
      retryable: false,
      needsAttention: true,
      status,
    };
  }
  if (status === 426) {
    return { error: 'LinkedIn no longer supports the API version Zentry is using. Set LINKEDIN_API_VERSION to a current version (YYYYMM).', retryable: false, needsAttention: true, status };
  }
  return failureFromStatus(status, base);
}

export function linkedinRequest<T>(token: string, path: string, init: RequestInitLite = {}): Promise<ApiResponse<T>> {
  return callApi<T>(
    `${LINKEDIN_API}/${path.replace(/^\//, '')}`,
    {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'LinkedIn-Version': LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0' },
    },
    classifyLinkedInError
  );
}

export function organizationUrn(pageId: string): string {
  return `urn:li:organization:${pageId}`;
}
