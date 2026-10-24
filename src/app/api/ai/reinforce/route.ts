import { NextRequest, NextResponse } from 'next/server';
import { learnFromHumanAgentReply } from '@/lib/ai/learning/human-reinforce';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { workspaceId, conversationId, agentMessageId, agentContent } = body;

    if (!workspaceId || !conversationId || !agentMessageId || !agentContent) {
      return NextResponse.json(
        { error: 'Missing required fields: workspaceId, conversationId, agentMessageId, agentContent' },
        { status: 400 }
      );
    }

    const result = await learnFromHumanAgentReply({
      workspaceId,
      conversationId,
      agentMessageId,
      agentContent,
    });

    return NextResponse.json({ success: true, result });
  } catch (err: any) {
    console.error('[API /api/ai/reinforce Error]:', err?.message);
    return NextResponse.json({ error: err?.message || 'Reinforcement failed' }, { status: 500 });
  }
}
