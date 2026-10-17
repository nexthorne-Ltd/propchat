import { ChannelApiError, callApi } from '@/lib/channels/http';
import { classifyXError, X_API } from './api';
import { userError } from '@/lib/errors/user-error';

/**
 * Sign in with X (OAuth 2.0 authorization code with PKCE). The admin approves
 * Zentry on x.com, comes back to /api/channels/oauth/x with a one-time code,
 * and the code becomes a 2-hour access token plus a refresh token
 * (offline.access). The platform X app is X_CLIENT_ID / X_CLIENT_SECRET.
 */

export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'dm.read', 'dm.write', 'offline.access'];

export function xRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/$/, '')}/api/channels/oauth/x`;
}

export function xAuthorizeUrl(appUrl: string, state: string, codeChallenge: string): string {
  const url = new URL('https://x.com/i/oauth2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.X_CLIENT_ID || '');
  url.searchParams.set('redirect_uri', xRedirectUri(appUrl));
  url.searchParams.set('scope', X_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface XTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scopes: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function clientAuth(): { header: Record<string, string>; id: string } {
  const id = process.env.X_CLIENT_ID;
  const secret = process.env.X_CLIENT_SECRET;
  if (!id || !secret) throw userError('X_CLIENT_ID and X_CLIENT_SECRET must be set to connect X.');
  return { id, header: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` } };
}

function toTokens(res: TokenResponse): XTokens {
  if (!res.access_token) throw userError('X did not return an access token.');
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: new Date(Date.now() + (res.expires_in ?? 7200) * 1000).toISOString(),
    scopes: (res.scope || '').split(/[ ,]+/).filter(Boolean),
  };
}

export async function exchangeXCode(code: string, appUrl: string, verifier: string): Promise<XTokens> {
  const { id, header } = clientAuth();
  const res = await callApi<TokenResponse>(
    `${X_API}/oauth2/token`,
    { method: 'POST', headers: header, form: { code, grant_type: 'authorization_code', client_id: id, redirect_uri: xRedirectUri(appUrl), code_verifier: verifier } },
    classifyXError
  );
  return toTokens(res.json);
}

/** Refresh tokens rotate: the answer carries the next one, which must be stored. */
export async function refreshXToken(refreshToken: string): Promise<XTokens> {
  const { id, header } = clientAuth();
  const res = await callApi<TokenResponse>(
    `${X_API}/oauth2/token`,
    { method: 'POST', headers: header, form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: id } },
    classifyXError
  );
  return toTokens(res.json);
}

export async function revokeXToken(token: string): Promise<void> {
  const { id, header } = clientAuth();
  try {
    await callApi(`${X_API}/oauth2/revoke`, { method: 'POST', headers: header, form: { token, client_id: id, token_type_hint: 'access_token' } }, classifyXError);
  } catch (err) {
    if (!(err instanceof ChannelApiError)) throw err;
  }
}
