import { NextRequest, NextResponse } from 'next/server';

/**
 * Legacy LinkedIn webhook. Its POST handler checked no signature and put every
 * event into the first workspace in the database, so it no longer accepts
 * events. LinkedIn is served by the channel framework
 * (/api/channels/linkedin/webhook and the poller). The challenge still
 * answers so an existing subscription can be moved without errors.
 */
export async function GET(req: NextRequest) {
  const challenge = new URL(req.url).searchParams.get('challenge');
  if (challenge) {
    return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return NextResponse.json({ status: 'retired', use: '/api/channels/linkedin/webhook' });
}

export async function POST() {
  console.warn('[LinkedIn Webhook] Legacy endpoint received an event; it is retired. Use /api/channels/linkedin/webhook.');
  return NextResponse.json({ status: 'retired', use: '/api/channels/linkedin/webhook' }, { status: 200 });
}
