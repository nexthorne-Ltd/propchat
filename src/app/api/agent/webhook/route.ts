import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/service';

/**
 * Callback for the old LangGraph bridge (src/lib/agent/langgraph.ts): lets an
 * agent add an internal note to a conversation or escalate it.
 *
 * It used to need no credentials at all, so anyone could post into any
 * conversation, and it inserted public "ai" replies directly, which skips the
 * bot-control checks in fn_deliver_ai_reply (a person may already have taken
 * over). Now it needs `Authorization: Bearer $AGENT_WEBHOOK_SECRET`, and it
 * accepts internal notes and escalations only. Public answers from your own
 * agent go through Settings → AI bot → LangGraph, which delivers them through
 * the normal path.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.AGENT_WEBHOOK_SECRET || '';
  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!secret || !given) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await req.json();
    const { conversation_id, workspace_id, content, is_internal = true, escalate = false, priority } = body as {
      conversation_id?: string;
      workspace_id?: string;
      content?: string;
      is_internal?: boolean;
      escalate?: boolean;
      priority?: string;
    };
    if (!conversation_id || !workspace_id) {
      return NextResponse.json({ error: 'conversation_id and workspace_id are required' }, { status: 400 });
    }
    if (is_internal === false) {
      return NextResponse.json(
        { error: 'Public replies are not accepted here. Answer through Settings → AI bot → LangGraph.' },
        { status: 400 }
      );
    }

    const supabase = serviceClient();
    const { data: conv } = await supabase
      .from('conversations')
      .select('id, workspace_id')
      .eq('id', conversation_id)
      .maybeSingle();
    // The conversation must belong to the workspace the caller named.
    if (!conv || conv.workspace_id !== workspace_id) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    if (escalate) {
      const { error } = await supabase
        .from('conversations')
        .update({
          status: 'open',
          priority: ['low', 'normal', 'high', 'urgent'].includes(String(priority)) ? priority : 'high',
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversation_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    let messageId: string | null = null;
    if (content && String(content).trim()) {
      const { data: note, error } = await supabase
        .from('messages')
        .insert({ conversation_id, sender_type: 'ai', content: String(content).slice(0, 10000), is_internal: true })
        .select('id')
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      messageId = note.id;
    }

    return NextResponse.json({ success: true, message_id: messageId }, { status: 200 });
  } catch (err) {
    console.error('[Agent Webhook Error]:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
