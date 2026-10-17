import { callApi } from '@/lib/channels/http';
import { classifyThreadsError, THREADS_GRAPH } from './api';
import { userError } from '@/lib/errors/user-error';

/**
 * Sign in with Threads: the admin approves Zentry on threads.net, comes back
 * to /api/channels/oauth/threads with a one-time code, and the code becomes a
 * short-lived token, then a 60-day one. The platform app is THREADS_APP_ID /
 * THREADS_APP_SECRET (a Meta app with the Threads use case).
 */

export const THREADS_SCOPES = ['threads_basic', 'threads_read_replies', 'threads_manage_replies', 'threads_content_publish', 'threads_manage_mentions'];

export function threadsRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/$/, '')}/api/channels/oauth/threads`;
}

export function threadsAuthorizeUrl(appUrl: string, state: string): string {
  const url = new URL('https://threads.net/oauth/authorize');
  url.searchParams.set('client_id', process.env.THREADS_APP_ID || '');
  url.searchParams.set('redirect_uri', threadsRedirectUri(appUrl));
  url.searchParams.set('scope', THREADS_SCOPES.join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeThreadsCode(code: string, appUrl: string): Promise<{ accessToken: string; expiresAt: string }> {
  const id = process.env.THREADS_APP_ID;
  const secret = process.env.THREADS_APP_SECRET;
  if (!id || !secret) throw userError('THREADS_APP_ID and THREADS_APP_SECRET must be set to connect Threads.');
  const short = await callApi<{ access_token?: string }>(
    `${THREADS_GRAPH}/oauth/access_token`,
    { method: 'POST', form: { client_id: id, client_secret: secret, grant_type: 'authorization_code', redirect_uri: threadsRedirectUri(appUrl), code } },
    classifyThreadsError
  );
  if (!short.json.access_token) throw userError('Threads did not return an access token.');
  const long = await callApi<{ access_token?: string; expires_in?: number }>(
    `${THREADS_GRAPH}/access_token`,
    { query: { grant_type: 'th_exchange_token', client_secret: secret, access_token: short.json.access_token } },
    classifyThreadsError
  );
  if (!long.json.access_token) throw userError('Threads did not return a long-lived token.');
  return { accessToken: long.json.access_token, expiresAt: new Date(Date.now() + (long.json.expires_in ?? 60 * 86_400) * 1000).toISOString() };
}

export async function refreshThreadsToken(token: string): Promise<{ accessToken: string; expiresAt: string }> {
  const res = await callApi<{ access_token?: string; expires_in?: number }>(
    `${THREADS_GRAPH}/refresh_access_token`,
    { query: { grant_type: 'th_refresh_token', access_token: token } },
    classifyThreadsError
  );
  if (!res.json.access_token) throw userError('Threads did not return a refreshed token.');
  return { accessToken: res.json.access_token, expiresAt: new Date(Date.now() + (res.json.expires_in ?? 60 * 86_400) * 1000).toISOString() };
}
