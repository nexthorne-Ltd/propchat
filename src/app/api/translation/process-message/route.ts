import { NextRequest, NextResponse } from 'next/server';
import { guardConversation } from '@/lib/team/route-guard';
import { translateVisitorMessage } from '@/lib/ai/inbound-translation';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** Translates a stored visitor message into English for the agents. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messageId: string | undefined = body.messageId || body.message_id;

    if (!messageId) {
      return NextResponse.json({ error: 'Missing messageId' }, { status: 400, headers: CORS_HEADERS });
    }

    // Only for messages in the caller's own workspace (the lookup goes through their session).
    const { createClient } = await import('@/lib/supabase/server');
    const { data: row } = await (await createClient()).from('messages').select('conversation_id').eq('id', messageId).maybeSingle();
    const guard = await guardConversation(row?.conversation_id, 'view');
    if (!guard.ok) return NextResponse.json(await guard.response.json(), { status: guard.response.status, headers: CORS_HEADERS });

    const result = await translateVisitorMessage(messageId);
    if (!result) {
      return NextResponse.json({ skipped: true, reason: 'Not a visitor message' }, { headers: CORS_HEADERS });
    }

    return NextResponse.json({ success: true, ...result }, { headers: CORS_HEADERS });
  } catch (error: any) {
    console.error('[Process Message Translation Error]:', error);
    return NextResponse.json(
      { error: error?.message || 'Processing failed' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
