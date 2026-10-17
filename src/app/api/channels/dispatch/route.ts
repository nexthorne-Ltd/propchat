import { NextRequest, NextResponse } from 'next/server';
import { guardConversation } from '@/lib/team/route-guard';
import { dispatchOutboundMessage } from '@/lib/channels/dispatcher';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { conversationId, content, channel } = body;

    if (!conversationId || !content || !channel) {
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    // Sending to a customer is replying: not for light agents.
    const guard = await guardConversation(conversationId, 'reply');
    if (!guard.ok) return guard.response;

    const res = await dispatchOutboundMessage({
      conversationId,
      workspaceId: guard.workspaceId,
      content,
      channel,
    });

    return NextResponse.json(res);
  } catch (err: any) {
    console.error('[API Channels Dispatch Error]:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
