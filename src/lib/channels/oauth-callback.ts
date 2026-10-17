import { NextResponse } from 'next/server';
import { getWorkspaceAccess } from '@/lib/team/access';
import { hasServiceRole } from '@/lib/supabase/service';
import { hasEncryptionKey } from './crypto';
import { readOAuthState, type OAuthState } from './oauth-state';
import { saveConnection } from './store';
import type { ConnectedAccount } from './types';

/**
 * The part of every "sign in with <platform>" callback that does not depend on
 * the platform: refuse a cancelled or forged sign-in, check the signed-in
 * admin is the one who started it, run the platform-specific step, store the
 * encrypted credentials, and always end on the Channels settings page with the
 * outcome in the URL (the page shows it once and cleans the address bar).
 */

export interface OAuthCompletion {
  credentials: unknown;
  account: ConnectedAccount;
}

function back(appUrl: string, channel: string, outcome: 'connected' | 'error', message?: string) {
  const url = new URL('/dashboard', appUrl);
  url.searchParams.set('settings', 'channels');
  url.searchParams.set('channel', channel);
  url.searchParams.set('channel_result', outcome);
  if (message) url.searchParams.set('channel_message', message.slice(0, 400));
  return NextResponse.redirect(url);
}

export async function handleOAuthCallback(
  request: Request,
  channel: string,
  label: string,
  complete: (args: { code: string; appUrl: string; state: OAuthState & { nonce: string } }) => Promise<OAuthCompletion>
): Promise<NextResponse> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const params = new URL(request.url).searchParams;

  if (params.get('error')) {
    return back(appUrl, channel, 'error', params.get('error_description') || params.get('error') || `${label} sign-in was cancelled.`);
  }
  if (!hasServiceRole() || !hasEncryptionKey()) {
    return back(appUrl, channel, 'error', 'The server is missing SUPABASE_SERVICE_ROLE_KEY or CHANNEL_ENCRYPTION_KEY.');
  }
  const state = readOAuthState(channel, params.get('state'));
  const code = params.get('code');
  if (!state || !code) return back(appUrl, channel, 'error', `This sign-in link has expired. Start connecting ${label} again.`);

  try {
    const { user } = await getWorkspaceAccess(state.workspaceId, 'manage_settings');
    if (user.id !== state.userId) return back(appUrl, channel, 'error', 'Finish connecting from the account that started it.');
    const { credentials, account } = await complete({ code, appUrl, state });
    await saveConnection({ workspaceId: state.workspaceId, channel, userId: user.id, setupMethod: 'embedded_signup', ...account, credentials });
    return back(appUrl, channel, 'connected');
  } catch (err) {
    console.error(`[${label} OAuth Error]:`, err);
    return back(appUrl, channel, 'error', (err as Error).message || `Could not connect ${label}.`);
  }
}
