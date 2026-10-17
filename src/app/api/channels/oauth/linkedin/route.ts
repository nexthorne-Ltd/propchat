import { handleOAuthCallback } from '@/lib/channels/oauth-callback';
import { linkedinAdapter } from '@/lib/channels/linkedin/adapter';
import { exchangeLinkedInCode } from '@/lib/channels/linkedin/oauth';

export const dynamic = 'force-dynamic';

/** Where LinkedIn sends the admin back after approving Zentry for their Page. */
export async function GET(request: Request) {
  return handleOAuthCallback(request, 'linkedin', 'LinkedIn', async ({ code, appUrl, state }) => {
    const tokens = await exchangeLinkedInCode(code, appUrl);
    const credentials = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt };
    // The Page id was chosen before sign-in and travels in the signed state.
    return { credentials, account: await linkedinAdapter.connect({ pageId: state.extra || '' }, credentials) };
  });
}
