import { NextRequest, NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/service';

/**
 * Legacy Meta webhook (Settings → Integrations, before the channel framework).
 *
 * Its POST handler checked no signature and put every incoming Messenger
 * message into whichever workspace happened to be first in the database,
 * because nothing recorded which Page belongs to which workspace. That is one
 * customer's messages landing in another's inbox, so it no longer accepts
 * messages. WhatsApp and Instagram go through /api/channels/<channel>/webhook,
 * which verify X-Hub-Signature-256 and route by connection. The handshake
 * (GET) still answers, so an existing subscription does not start failing
 * verification while it is being moved.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token && challenge) {
    const { data: matched } = await serviceClient()
      .from('workspace_integrations')
      .select('workspace_id')
      .eq('meta_verify_token', token)
      .limit(1)
      .maybeSingle();
    if (matched || (process.env.META_VERIFY_TOKEN && token === process.env.META_VERIFY_TOKEN)) {
      return new NextResponse(challenge, { status: 200 });
    }
    return new NextResponse('Verification token mismatch', { status: 403 });
  }
  return new NextResponse('Invalid verification request', { status: 400 });
}

export async function POST() {
  console.warn('[Meta Webhook] Legacy endpoint received an event; it is retired. Use /api/channels/<channel>/webhook.');
  // 200 so Meta does not keep retrying and eventually disable the app.
  return NextResponse.json({ status: 'retired', use: '/api/channels/{whatsapp|instagram}/webhook' }, { status: 200 });
}
