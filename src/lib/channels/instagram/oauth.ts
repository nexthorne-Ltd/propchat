import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseKey } from '@/lib/channels/crypto';
import { IgError, classifyIgError, type IgErrorBody } from './graph';
import { userError } from '@/lib/errors/user-error';

/**
 * Business Login for Instagram: the admin is sent to instagram.com to approve
 * Zentry, comes back to /api/channels/oauth/instagram with a one-time code,
 * and the code becomes a 60-day token.
 *
 * The `state` parameter carries who started the flow (workspace, user) and
 * expires after 15 minutes. It is signed with CHANNEL_ENCRYPTION_KEY so a
 * forged callback cannot attach someone's Instagram account to another
 * workspace; the callback also re-checks the signed-in user's role.
 */

export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];

export interface ConnectState {
  workspaceId: string;
  userId: string;
  expiresAt: number;
}

function sign(payload: string): string {
  return createHmac('sha256', parseKey(process.env.CHANNEL_ENCRYPTION_KEY)).update(`ig-oauth:${payload}`).digest('base64url');
}

export function createState(workspaceId: string, userId: string, ttlMs = 15 * 60_000): string {
  const payload = Buffer.from(
    JSON.stringify({ w: workspaceId, u: userId, e: Date.now() + ttlMs, n: randomBytes(8).toString('base64url') })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readState(state: string | null | undefined): ConnectState | null {
  const [payload, sig] = (state || '').split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { w?: string; u?: string; e?: number };
    if (!data.w || !data.u || !data.e || data.e < Date.now()) return null;
    return { workspaceId: data.w, userId: data.u, expiresAt: data.e };
  } catch {
    return null;
  }
}

export function redirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/$/, '')}/api/channels/oauth/instagram`;
}

export function authorizeUrl(appUrl: string, state: string): string {
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', process.env.INSTAGRAM_APP_ID || '');
  url.searchParams.set('redirect_uri', redirectUri(appUrl));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', INSTAGRAM_SCOPES.join(','));
  url.searchParams.set('state', state);
  return url.toString();
}

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => null)) as (T & { error?: IgErrorBody | string; error_message?: string }) | null;
  if (!res.ok || !json || json.error) {
    const err = typeof json?.error === 'object' ? json.error : { message: json?.error_message || (typeof json?.error === 'string' ? json.error : undefined) };
    throw new IgError(classifyIgError(res.status, err));
  }
  return json;
}

/** One-time code → short-lived token → 60-day token. */
export async function exchangeInstagramCode(code: string, appUrl: string): Promise<{ accessToken: string; expiresAt: string; grantedScopes: string[] }> {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appId || !appSecret) throw userError('INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET must be set for Instagram login.');

  const form = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(appUrl),
    code,
  });
  const short = await readJson<{ access_token?: string; permissions?: string | string[]; data?: { access_token?: string; permissions?: string }[] }>(
    await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) })
  );
  const row = short.data?.[0] ?? short;
  if (!row.access_token) throw userError('Instagram did not return an access token.');
  const perms = row.permissions;
  const grantedScopes = Array.isArray(perms) ? perms : typeof perms === 'string' ? perms.split(',') : [];

  const url = new URL(`https://graph.instagram.com/access_token`);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('access_token', row.access_token);
  const long = await readJson<{ access_token?: string; expires_in?: number }>(await fetch(url, { signal: AbortSignal.timeout(15_000) }));
  if (!long.access_token) throw userError('Instagram did not return a long-lived token.');
  return {
    accessToken: long.access_token,
    expiresAt: new Date(Date.now() + (long.expires_in ?? 60 * 86_400) * 1000).toISOString(),
    grantedScopes,
  };
}
