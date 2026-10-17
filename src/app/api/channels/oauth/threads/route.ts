import { handleOAuthCallback } from '@/lib/channels/oauth-callback';
import { threadsAdapter } from '@/lib/channels/threads/adapter';
import { exchangeThreadsCode } from '@/lib/channels/threads/oauth';

export const dynamic = 'force-dynamic';

/** Where Threads sends the admin back after approving Zentry. */
export async function GET(request: Request) {
  return handleOAuthCallback(request, 'threads', 'Threads', async ({ code, appUrl }) => {
    // Threads appends "#_" to the code in some flows.
    const token = await exchangeThreadsCode(code.replace(/#_$/, ''), appUrl);
    const credentials = { accessToken: token.accessToken, expiresAt: token.expiresAt };
    return { credentials, account: await threadsAdapter.connect({}, credentials) };
  });
}
