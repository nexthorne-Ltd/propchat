import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseKey } from './crypto';

/**
 * The `state` parameter of the OAuth sign-ins for X, Threads and LinkedIn.
 *
 * It says who started the flow (workspace, user, channel, and for LinkedIn
 * the Page being connected) and expires after 15 minutes. It is signed with
 * CHANNEL_ENCRYPTION_KEY, scoped to the channel so a state minted for one
 * channel cannot complete another, so a forged callback cannot attach someone's
 * account to a workspace. Each callback also re-checks the signed-in user's
 * role. (Instagram has its own copy of this in instagram/oauth.ts.)
 *
 * X needs PKCE. The code verifier is derived from the state's random part
 * with the same key, so nothing has to be stored between the redirect out and
 * the callback, and it is unknowable without the key.
 */

export interface OAuthState {
  workspaceId: string;
  userId: string;
  /** Free text the flow needs back, such as a LinkedIn Page id. */
  extra?: string;
}

interface Payload {
  w: string;
  u: string;
  c: string;
  e: number;
  n: string;
  x?: string;
}

function mac(label: string, data: string): Buffer {
  return createHmac('sha256', parseKey(process.env.CHANNEL_ENCRYPTION_KEY)).update(`${label}:${data}`).digest();
}

export function createOAuthState(channel: string, state: OAuthState, ttlMs = 15 * 60_000): string {
  const payload: Payload = { w: state.workspaceId, u: state.userId, c: channel, e: Date.now() + ttlMs, n: randomBytes(12).toString('base64url'), x: state.extra };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac('oauth-state', `${channel}:${body}`).toString('base64url')}`;
}

export function readOAuthState(channel: string, state: string | null | undefined): (OAuthState & { nonce: string }) | null {
  const [body, sig] = (state || '').split('.');
  if (!body || !sig) return null;
  const expected = mac('oauth-state', `${channel}:${body}`);
  const given = Buffer.from(sig, 'base64url');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Payload>;
    if (!p.w || !p.u || p.c !== channel || !p.n || !p.e || p.e < Date.now()) return null;
    return { workspaceId: p.w, userId: p.u, extra: p.x, nonce: p.n };
  } catch {
    return null;
  }
}

/** PKCE: a verifier only this server can recompute from the state, and its S256 challenge. */
export function pkceFor(nonce: string): { verifier: string; challenge: string } {
  const verifier = mac('pkce', nonce).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
