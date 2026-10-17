import { NextResponse } from 'next/server';
import { getWorkspaceAccess } from '@/lib/team/access';
import { hasServiceRole } from '@/lib/supabase/service';
import { hasEncryptionKey } from '@/lib/channels/crypto';
import { instagramAdapter, type InstagramCredentials } from '@/lib/channels/instagram/adapter';
import { exchangeInstagramCode, INSTAGRAM_SCOPES, readState } from '@/lib/channels/instagram/oauth';
import { saveConnection } from '@/lib/channels/store';

export const dynamic = 'force-dynamic';

/**
 * Where Instagram sends the admin back after Business Login. Checks the
 * signed state, that the same signed-in admin started the flow, exchanges the
 * code for a 60-day token, confirms the account is professional, subscribes
 * to its messages and stores the encrypted token. Always ends on the
 * Channels settings page with the outcome in the URL.
 */
function back(appUrl: string, outcome: 'connected' | 'error', message?: string) {
  const url = new URL('/dashboard', appUrl);
  url.searchParams.set('settings', 'channels');
  url.searchParams.set('channel', 'instagram');
  url.searchParams.set('channel_result', outcome);
  if (message) url.searchParams.set('channel_message', message.slice(0, 400));
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const params = new URL(request.url).searchParams;

  // The admin pressed "Cancel" on Instagram, or Instagram refused.
  if (params.get('error')) {
    return back(appUrl, 'error', params.get('error_description') || params.get('error_reason') || 'Instagram login was cancelled.');
  }
  if (!hasServiceRole() || !hasEncryptionKey()) {
    return back(appUrl, 'error', 'The server is missing SUPABASE_SERVICE_ROLE_KEY or CHANNEL_ENCRYPTION_KEY.');
  }
  const state = readState(params.get('state'));
  const code = params.get('code');
  if (!state || !code) return back(appUrl, 'error', 'This sign-in link has expired. Start connecting Instagram again.');

  try {
    const { user } = await getWorkspaceAccess(state.workspaceId, 'manage_settings');
    if (user.id !== state.userId) return back(appUrl, 'error', 'Finish connecting from the account that started it.');

    // Instagram appends "#_" to the code in some flows.
    const token = await exchangeInstagramCode(code.replace(/#_$/, ''), appUrl);
    const missing = INSTAGRAM_SCOPES.filter((s) => token.grantedScopes.length && !token.grantedScopes.includes(s));
    if (missing.length) {
      return back(appUrl, 'error', `Instagram did not grant ${missing.join(', ')}. Connect again and allow every permission.`);
    }
    const credentials: InstagramCredentials = { accessToken: token.accessToken, expiresAt: token.expiresAt };
    const account = await instagramAdapter.connect({}, credentials);
    await saveConnection({
      workspaceId: state.workspaceId,
      channel: 'instagram',
      userId: user.id,
      setupMethod: 'embedded_signup',
      ...account,
      settings: { ...account.settings, human_agent: process.env.INSTAGRAM_HUMAN_AGENT_ENABLED === 'true' },
      credentials,
    });
    return back(appUrl, 'connected');
  } catch (err) {
    console.error('[Instagram OAuth Error]:', err);
    return back(appUrl, 'error', (err as Error).message || 'Could not connect Instagram.');
  }
}
