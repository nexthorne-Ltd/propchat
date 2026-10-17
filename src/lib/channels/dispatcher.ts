import { serviceClient } from '@/lib/supabase/service';
import { getAdapter } from './registry';
import { processOutboundQueue } from './outbound';


/*
 * Server-side reads of conversations and integration settings. The public
 * anon key cannot read these (docs/AUDIT.md H-3), so this uses the service
 * role; callers have already checked the caller may act on the conversation
 * or workspace.
 */
function getSupabase() {
  return serviceClient();
}

export interface DispatchOutboundParams {
  conversationId: string;
  workspaceId: string;
  content: string;
  channel: string;
}

/**
 * Forwards an agent or AI message out to external messaging channels. WhatsApp goes through the
 * channel framework (src/lib/channels/registry.ts); Messenger, Instagram and LinkedIn are the older
 * direct integrations.
 */
export async function dispatchOutboundMessage(params: DispatchOutboundParams) {
  const { conversationId, workspaceId, content, channel } = params;

  // Web messages are automatically picked up by Supabase Realtime in widget.js
  if (channel === 'web' || !channel) {
    return { success: true, channel: 'web' };
  }

  // Channels with an adapter never send from here: a database trigger queued
  // the message when it was stored (channel_outbound_queue), whoever wrote it.
  // Sending here as well would deliver it twice, so this only nudges the
  // worker to send what is due now instead of waiting for the cron.
  if (getAdapter(channel)) {
    await processOutboundQueue();
    return { success: true, channel, queued: true };
  }

  const supabase = getSupabase();

  try {
    // 1. Fetch conversation details to get channel_user_id (phone number, PSID, IGSID, etc.)
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('channel_user_id, channel_metadata')
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .single();

    if (convErr || !conv || !conv.channel_user_id) {
      console.warn(`[Dispatcher] No external channel_user_id for conversation ${conversationId}`);
      return { success: false, error: 'Missing channel_user_id' };
    }

    const recipientId = conv.channel_user_id;

    // 2. Fetch workspace integration credentials
    const { data: integration } = await supabase
      .from('workspace_integrations')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (!integration) {
      console.warn(`[Dispatcher] No workspace_integrations found for workspace ${workspaceId}`);
      return { success: false, error: 'Integration settings missing' };
    }

    // 3. Dispatch to respective provider
    switch (channel.toLowerCase()) {
      case 'facebook':
      case 'messenger':
      case 'instagram': {
        if (!integration.meta_page_access_token) {
          console.warn('[Dispatcher] Meta Page Access Token not configured.');
          return { success: false, error: 'Meta Page Access Token missing' };
        }

        const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${integration.meta_page_access_token}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: content },
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          console.error(`[${channel} Outbound Error]:`, data);
          return { success: false, error: data };
        }
        console.log(`✓ [${channel}] Sent message to ${recipientId}:`, data.message_id);
        return { success: true, providerMsgId: data.message_id };
      }

      case 'linkedin': {
        if (!integration.linkedin_access_token) {
          console.warn('[Dispatcher] LinkedIn Access Token not configured.');
          return { success: false, error: 'LinkedIn Access Token missing' };
        }

        const url = 'https://api.linkedin.com/v2/messages';
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${integration.linkedin_access_token}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
          },
          body: JSON.stringify({
            recipients: [recipientId],
            message: {
              body: content,
            },
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          console.error('[LinkedIn Outbound Error]:', errText);
          return { success: false, error: errText };
        }
        console.log(`✓ [LinkedIn] Sent message to ${recipientId}`);
        return { success: true };
      }

      default:
        return { success: true, channel };
    }
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[Dispatcher Error for ${channel}]:`, message);
    return { success: false, error: message };
  }
}
