import { callApi } from '@/lib/channels/http';
import { classifyLinkedInError } from './api';
import { userError } from '@/lib/errors/user-error';

/**
 * Sign in with LinkedIn (3-legged OAuth). The admin approves Zentry on
 * linkedin.com, comes back to /api/channels/oauth/linkedin with a one-time
 * code, and the code becomes a 60-day token. The platform app is
 * LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET, which must have the Community
 * Management API product approved.
 *
 * Scopes differ between LinkedIn's own pages, so they are configurable
 * (LINKEDIN_SCOPES, space separated). Asking for one the app has not been
 * granted fails the whole sign-in, which is why the default is the minimum:
 * read the Page's posts and comments, and comment as the Page.
 */

export const DEFAULT_LINKEDIN_SCOPES = ['r_organization_social', 'w_organization_social'];

export function linkedinScopes(): string[] {
  const configured = (process.env.LINKEDIN_SCOPES || '').split(/[ ,]+/).filter(Boolean);
  return configured.length ? configured : DEFAULT_LINKEDIN_SCOPES;
}

export function linkedinRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/$/, '')}/api/channels/oauth/linkedin`;
}

export function linkedinAuthorizeUrl(appUrl: string, state: string): string {
  const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.LINKEDIN_CLIENT_ID || '');
  url.searchParams.set('redirect_uri', linkedinRedirectUri(appUrl));
  url.searchParams.set('state', state);
  url.searchParams.set('scope', linkedinScopes().join(' '));
  return url.toString();
}

export interface LinkedInTokens {
  accessToken: string;
  expiresAt: string;
  refreshToken?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
}

function toTokens(res: TokenResponse): LinkedInTokens {
  if (!res.access_token) throw userError('LinkedIn did not return an access token.');
  return {
    accessToken: res.access_token,
    expiresAt: new Date(Date.now() + (res.expires_in ?? 60 * 86_400) * 1000).toISOString(),
    refreshToken: res.refresh_token,
  };
}

function client(): { id: string; secret: string } {
  const id = process.env.LINKEDIN_CLIENT_ID;
  const secret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!id || !secret) throw userError('LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must be set to connect LinkedIn.');
  return { id, secret };
}

export async function exchangeLinkedInCode(code: string, appUrl: string): Promise<LinkedInTokens> {
  const { id, secret } = client();
  const res = await callApi<TokenResponse>(
    'https://www.linkedin.com/oauth/v2/accessToken',
    { method: 'POST', form: { grant_type: 'authorization_code', code, client_id: id, client_secret: secret, redirect_uri: linkedinRedirectUri(appUrl) } },
    classifyLinkedInError
  );
  return toTokens(res.json);
}

/** Only programmatic-refresh partners receive a refresh token; everyone else reconnects every 60 days. */
export async function refreshLinkedInToken(refreshToken: string): Promise<LinkedInTokens> {
  const { id, secret } = client();
  const res = await callApi<TokenResponse>(
    'https://www.linkedin.com/oauth/v2/accessToken',
    { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: id, client_secret: secret } },
    classifyLinkedInError
  );
  const tokens = toTokens(res.json);
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}
