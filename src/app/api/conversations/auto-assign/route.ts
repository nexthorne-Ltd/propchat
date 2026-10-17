import { NextRequest, NextResponse } from 'next/server';
import { guardConversation } from '@/lib/team/route-guard';
import { autoAssignConversation } from '@/lib/team/auto-assign';

/**
 * Auto-assigns a conversation to the least-loaded available agent. Needs the
 * right to change tickets (not light agents); runs as the caller.
 */
export async function POST(req: NextRequest) {
  try {
    const { conversation_id } = await req.json();
    const guard = await guardConversation(conversation_id, 'edit_ticket');
    if (!guard.ok) return guard.response;

    const result = await autoAssignConversation(guard.access.supabase, conversation_id);
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[Auto-Assign Error]:', error);
    return NextResponse.json({ error: error.message || 'Auto-assignment failed' }, { status: 500 });
  }
}
