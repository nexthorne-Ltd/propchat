import { NextRequest, NextResponse } from 'next/server';
import { guardConversation } from '@/lib/team/route-guard';
import { generateLangGraphDraft } from '@/lib/agent/langgraph';
import { serviceClient } from '@/lib/supabase/service';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      conversation_id,
      workspace_id,
      incoming_message,
      visitor,
      channel = 'web',
      recent_messages,
    } = body;

    if (!conversation_id || !workspace_id) {
      return NextResponse.json({ error: 'Missing conversation_id or workspace_id' }, { status: 400 });
    }

    const guard = await guardConversation(conversation_id, 'reply');
    if (!guard.ok) return guard.response;
    if (guard.workspaceId !== workspace_id) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

    const supabase = serviceClient();

    // Fetch recent thread: up to last 15 messages (including agent replies and internal notes)
    const { data: dbMessages } = await supabase
      .from('messages')
      .select('id, sender_type, content, is_internal, created_at')
      .eq('conversation_id', conversation_id)
      .order('created_at', { ascending: false })
      .limit(15);

    const threadMessages =
      dbMessages && dbMessages.length > 0
        ? [...dbMessages].reverse()
        : (recent_messages || []);

    const draft = await generateLangGraphDraft({
      conversationId: conversation_id,
      workspaceId: workspace_id,
      incomingMessage: incoming_message || '',
      recentMessages: threadMessages,
      sender: {
        name: visitor?.name || 'Customer',
        email: visitor?.email || null,
        channel,
      },
    });

    return NextResponse.json({ draft: draft || 'Hello! How can I help you today?' });
  } catch (err: any) {
    console.error('Error generating AI suggestion:', err);
    return NextResponse.json({ draft: 'Thank you for reaching out! How can we assist you today?' });
  }
}
