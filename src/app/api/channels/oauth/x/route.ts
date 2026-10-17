import { handleOAuthCallback } from '@/lib/channels/oauth-callback';
import { pkceFor } from '@/lib/channels/oauth-state';
import { xAdapter } from '@/lib/channels/x/adapter';
import { exchangeXCode, X_SCOPES } from '@/lib/channels/x/oauth';

export const dynamic = 'force-dynamic';

/** Where X sends the admin back after "Sign in with X". */
export async function GET(request: Request) {
  return handleOAuthCallback(request, 'x', 'X', async ({ code, appUrl, state }) => {
    const tokens = await exchangeXCode(code, appUrl, pkceFor(state.nonce).verifier);
    // Without these the sign-in works but replying or reading messages fails later; say so now.
    const missing = X_SCOPES.filter((s) => tokens.scopes.length && !tokens.scopes.includes(s));
    if (missing.length) throw new Error(`X did not grant ${missing.join(', ')}. Connect again and allow every permission.`);
    const credentials = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt };
    return { credentials, account: await xAdapter.connect({}, credentials) };
  });
}
