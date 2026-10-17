/**
 * A thin client for the Instagram API with Instagram Login (graph.instagram.com),
 * and what its errors mean for us: retry later, ask an admin to reconnect,
 * the messaging window has closed, or give up on this message.
 */

export const IG_GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_API_VERSION || 'v23.0';
const GRAPH = 'https://graph.instagram.com';

export interface IgErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
}

export interface IgFailure {
  error: string;
  retryable: boolean;
  needsAttention: boolean;
  windowClosed: boolean;
  code?: number;
}

export class IgError extends Error {
  constructor(readonly failure: IgFailure) {
    super(failure.error);
  }
}

// Throttling and transient errors.
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
// The token was revoked or expired, or the account lost a permission.
const ATTENTION_CODES = new Set([102, 190, 200]);
// "This message is sent outside of allowed window."
const WINDOW_SUBCODES = new Set([2534022]);

export function classifyIgError(httpStatus: number | null, body: IgErrorBody | null | undefined): IgFailure {
  const code = body?.code;
  const base = body?.error_user_msg || body?.message || (httpStatus ? `Instagram returned HTTP ${httpStatus}.` : 'Could not reach Instagram.');

  if (body?.error_subcode !== undefined && WINDOW_SUBCODES.has(body.error_subcode)) {
    return {
      error: 'Instagram no longer allows a reply: the customer last wrote too long ago. Their next message reopens the conversation.',
      retryable: false,
      needsAttention: false,
      windowClosed: true,
      code,
    };
  }
  if (code === 10 || (code !== undefined && ATTENTION_CODES.has(code))) {
    return { error: base, retryable: false, needsAttention: true, windowClosed: false, code };
  }
  if (code === 551) {
    return { error: 'This person is not available on Instagram right now (blocked, deactivated or restricted messages).', retryable: false, needsAttention: false, windowClosed: false, code };
  }
  if ((code !== undefined && RETRYABLE_CODES.has(code)) || httpStatus === null || httpStatus === 429 || httpStatus >= 500) {
    return { error: base, retryable: true, needsAttention: false, windowClosed: false, code };
  }
  return { error: base, retryable: false, needsAttention: false, windowClosed: false, code };
}

export async function igRequest<T>(
  token: string,
  path: string,
  init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; query?: Record<string, string>; versioned?: boolean } = {}
): Promise<T> {
  const prefix = init.versioned === false ? GRAPH : `${GRAPH}/${IG_GRAPH_VERSION}`;
  const url = new URL(`${prefix}/${path.replace(/^\//, '')}`);
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
    throw new IgError(classifyIgError(null, { message: `Could not reach Instagram: ${(err as Error).message}` }));
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: IgErrorBody }) | null;
  if (!res.ok || json?.error) throw new IgError(classifyIgError(res.status, json?.error));
  return json as T;
}
