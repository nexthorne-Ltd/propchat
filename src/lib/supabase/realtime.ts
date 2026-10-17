import { RealtimeChannel } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { Conversation, Message, InternalNote } from '@/types/database';

export interface SubscriptionCallbacks<T> {
  onInsert?: (record: T) => void;
  onUpdate?: (newRecord: T, oldRecord: Partial<T>) => void;
  onDelete?: (oldRecord: Partial<T>) => void;
}

/**
 * Subscribes to realtime changes on the conversations table.
 * Pushes live updates whenever new conversations are created or status/priority changes.
 *
 * @param callbacks Handlers for insert, update, and delete events
 * @param filter Optional Postgres filter string (e.g. `status=eq.open`)
 * @returns RealtimeChannel instance with unsubscribe method
 */
export function subscribeToConversations(
  callbacks: SubscriptionCallbacks<Conversation>,
  filter?: string
): RealtimeChannel {
  const supabase = createClient();
  const channelName = `realtime-conversations-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const channel = supabase.channel(channelName);

  channel.on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'conversations',
      ...(filter ? { filter } : {}),
    },
    (payload: any) => {
      switch (payload.eventType) {
        case 'INSERT':
          callbacks.onInsert?.(payload.new as Conversation);
          break;
        case 'UPDATE':
          callbacks.onUpdate?.(payload.new as Conversation, payload.old as Partial<Conversation>);
          break;
        case 'DELETE':
          callbacks.onDelete?.(payload.old as Partial<Conversation>);
          break;
      }
    }
  );

  channel.subscribe((status: any, err: any) => {
    if (err) {
      console.error('[Supabase Realtime] Conversations subscription error:', err);
    }
  });

  return channel;
}

/**
 * Subscribes to realtime messages in a conversation.
 * Pushes live updates when a visitor, agent, or system sends a message.
 *
 * @param conversationId UUID of the conversation thread
 * @param callbacks Handlers for incoming new messages or read receipts
 * @returns RealtimeChannel instance with unsubscribe method
 */
export function subscribeToMessages(
  conversationId: string,
  callbacks: SubscriptionCallbacks<Message>
): RealtimeChannel {
  const supabase = createClient();
  const channelName = `realtime-messages-${conversationId}`;

  const channel = supabase.channel(channelName);

  channel.on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
      filter: `conversation_id=eq.${conversationId}`,
    },
    (payload: any) => {
      callbacks.onInsert?.(payload.new as Message);
    }
  );

  channel.on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'messages',
      filter: `conversation_id=eq.${conversationId}`,
    },
    (payload: any) => {
      callbacks.onUpdate?.(payload.new as Message, payload.old as Partial<Message>);
    }
  );

  channel.subscribe((status: any, err: any) => {
    if (err) {
      console.error(`[Supabase Realtime] Messages subscription error for ${conversationId}:`, err);
    }
  });

  return channel;
}

/**
 * Subscribes to realtime private internal notes in a conversation for agents.
 *
 * @param conversationId UUID of the conversation thread
 * @param callbacks Handlers for new notes
 * @returns RealtimeChannel instance
 */
export function subscribeToInternalNotes(
  conversationId: string,
  callbacks: SubscriptionCallbacks<InternalNote>
): RealtimeChannel {
  const supabase = createClient();
  const channelName = `realtime-notes-${conversationId}`;

  const channel = supabase.channel(channelName);

  channel.on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'internal_notes',
      filter: `conversation_id=eq.${conversationId}`,
    },
    (payload: any) => {
      callbacks.onInsert?.(payload.new as InternalNote);
    }
  );

  channel.subscribe();
  return channel;
}

/**
 * Helper to safely unsubscribe and remove a realtime channel.
 */
export async function unsubscribeChannel(channel: RealtimeChannel | null) {
  if (!channel) return;
  const supabase = createClient();
  await supabase.removeChannel(channel);
}
