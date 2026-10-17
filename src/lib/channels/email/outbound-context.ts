import { serviceClient } from '@/lib/supabase/service';
import type { EmailSendContext } from './types';

/**
 * What the email adapter needs to know about a ticket thread to thread a
 * reply correctly: the ticket, who is writing, the Message-IDs so far and
 * who is copied. Read with the service role by the outbound worker, which has
 * already tied the queue row to its workspace.
 */
export async function loadEmailSendContext(row: { workspace_id: string; conversation_id: string; message_id: string }): Promise<EmailSendContext | undefined> {
  const sb = serviceClient();
  const [{ data: conv }, { data: msg }, { data: thread }] = await Promise.all([
    sb.from('conversations').select('current_ticket_id, channel_metadata, workspace_id').eq('id', row.conversation_id).maybeSingle(),
    sb.from('messages').select('sender_type, sender_id, ticket_id').eq('id', row.message_id).maybeSingle(),
    sb
      .from('messages')
      .select('channel_message_id, sender_type, created_at')
      .eq('conversation_id', row.conversation_id)
      .not('channel_message_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(200),
  ]);
  if (!conv || conv.workspace_id !== row.workspace_id) return undefined;

  const ticketId = msg?.ticket_id || conv.current_ticket_id;
  const { data: ticket } = ticketId
    ? await sb.from('tickets').select('number, subject').eq('id', ticketId).eq('workspace_id', row.workspace_id).maybeSingle()
    : { data: null };
  if (!ticket) return undefined;

  let agentName: string | undefined;
  if (msg?.sender_type === 'agent' && msg.sender_id) {
    const { data: agent } = await sb.from('agents').select('name').eq('id', msg.sender_id).maybeSingle();
    agentName = agent?.name || undefined;
  }

  const ids = (thread || []).map((m: { channel_message_id: string }) => m.channel_message_id);
  const lastInbound = [...(thread || [])].reverse().find((m: { sender_type: string }) => m.sender_type === 'visitor');
  const cc = ((conv.channel_metadata?.email_cc || []) as { email?: string }[]).map((c) => c.email).filter((e): e is string => Boolean(e));

  return {
    messageRowId: row.message_id,
    ticketNumber: ticket.number,
    ticketSubject: ticket.subject || '',
    agentName,
    inReplyTo: lastInbound?.channel_message_id,
    references: ids,
    cc,
  };
}
