import { NextRequest, NextResponse } from 'next/server';
import { renderEmail } from '@/lib/email/layout';
import { guardConversation, guardMember } from '@/lib/team/route-guard';
import { serviceClient } from '@/lib/supabase/service';
import { getRequestOrigin } from '@/lib/request-origin';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

/*
 * Server-side reads of conversations and integration settings. The public
 * anon key cannot read these (docs/AUDIT.md H-3), so this uses the service
 * role; callers have already checked the caller may act on the conversation
 * or workspace.
 */
function getSupabase() {
  return serviceClient();
}

/**
 * POST /api/notifications/dispatch
 * Central dispatcher for Slack webhooks and offline agent email notifications.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { event, conversation_id, message, workspace_id } = body;

    // Webhook tests are settings; everything else concerns one conversation.
    const guard =
      event === 'test_slack' || !conversation_id
        ? await guardMember(event === 'test_slack' ? 'manage_settings' : 'view')
        : await guardConversation(conversation_id, 'view');
    if (!guard.ok) return guard.response;

    const supabase = getSupabase();
    const appBaseUrl = await getRequestOrigin(req);

    // ──────────────────────────────────────────────────────────────────────────
    // 1. TEST SLACK WEBHOOK
    // ──────────────────────────────────────────────────────────────────────────
    if (event === 'test_slack') {
      const { webhook_url } = body;
      if (!webhook_url) {
        return NextResponse.json({ error: 'Missing webhook_url' }, { status: 400 });
      }

      const res = await fetch(webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: '🚀 *Zen-try Test Notification*\nYour Slack webhook is connected successfully! New customer conversations will appear here.',
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return NextResponse.json(
          { error: `Slack returned error: ${errText}` },
          { status: 400 }
        );
      }

      return NextResponse.json({ success: true, message: 'Test message sent to Slack' });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 2. NEW CONVERSATION CREATED -> SLACK WEBHOOK
    // ──────────────────────────────────────────────────────────────────────────
    if (event === 'conversation_created') {
      if (!conversation_id) {
        return NextResponse.json({ error: 'Missing conversation_id' }, { status: 400 });
      }

      // Fetch conversation with visitor details
      const { data: conv } = await supabase
        .from('conversations')
        .select('*, visitor:visitors(*)')
        .eq('id', conversation_id)
        .single();

      if (!conv) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      // Look up workspace integrations for Slack
      const wsId = conv.workspace_id || workspace_id;
      let slackWebhook = process.env.SLACK_WEBHOOK_URL || '';
      let slackEnabled = true;

      if (wsId) {
        const { data: integ } = await supabase
          .from('workspace_integrations')
          .select('slack_enabled, slack_webhook_url')
          .eq('workspace_id', wsId)
          .maybeSingle();

        if (integ) {
          if (integ.slack_webhook_url) slackWebhook = integ.slack_webhook_url;
          if (integ.slack_enabled !== undefined) slackEnabled = integ.slack_enabled;
        }
      }

      if (slackWebhook && slackEnabled) {
        const visitorName = conv.visitor?.name || 'Anonymous Visitor';
        const visitorEmail = conv.visitor?.email || 'None';
        const channel = conv.channel || 'web';
        const initialText = message?.content || 'A customer started a new chat session.';
        const inboxUrl = `${appBaseUrl}/dashboard?conversation=${conv.id}`;

        const slackPayload = {
          text: `💬 *New Conversation Started by ${visitorName}*`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '💬 New Customer Conversation Started',
                emoji: true,
              },
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Visitor:*\n${visitorName}` },
                { type: 'mrkdwn', text: `*Email:*\n${visitorEmail}` },
                { type: 'mrkdwn', text: `*Channel:*\n\`${channel}\`` },
                { type: 'mrkdwn', text: `*Ticket ID:*\n\`#${conv.id.slice(0, 8)}\`` },
              ],
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Initial Message:*\n>${initialText.replace(/\n/g, '\n>')}`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Open in Zen-try Inbox ↗', emoji: true },
                  url: inboxUrl,
                  style: 'primary',
                },
              ],
            },
          ],
        };

        try {
          await fetch(slackWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(slackPayload),
          });
        } catch (sErr) {
          console.error('[Slack Webhook Error]:', sErr);
        }
      }

      return NextResponse.json({ success: true, dispatched: 'conversation_created' });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 3. NEW VISITOR MESSAGE -> EMAIL TO OFFLINE ASSIGNED AGENT
    // ──────────────────────────────────────────────────────────────────────────
    if (event === 'new_message') {
      const senderType = message?.sender_type;
      if (senderType !== 'visitor') {
        return NextResponse.json({ ignored: 'Not a visitor message' });
      }

      // Fetch conversation to find assigned agent
      const { data: conv } = await supabase
        .from('conversations')
        .select('*, visitor:visitors(*), agent:agents!assigned_agent_id(*)')
        .eq('id', conversation_id)
        .single();

      if (!conv || !conv.assigned_agent_id) {
        return NextResponse.json({ ignored: 'No assigned agent for this conversation' });
      }

      // Check agent status
      let agent = conv.agent;
      if (!agent) {
        const { data: aData } = await supabase
          .from('agents')
          .select('*')
          .eq('id', conv.assigned_agent_id)
          .single();
        agent = aData;
      }

      if (!agent || !agent.email) {
        return NextResponse.json({ ignored: 'Agent has no email' });
      }

      // Only notify if agent is offline or away
      if (agent.status === 'online') {
        return NextResponse.json({ ignored: 'Agent is currently online' });
      }

      // Check workspace integration settings
      let emailsEnabled = true;
      if (conv.workspace_id) {
        const { data: integ } = await supabase
          .from('workspace_integrations')
          .select('email_offline_notifications')
          .eq('workspace_id', conv.workspace_id)
          .maybeSingle();

        if (integ && integ.email_offline_notifications === false) {
          emailsEnabled = false;
        }
      }

      if (!emailsEnabled) {
        return NextResponse.json({ ignored: 'Offline email notifications disabled in settings' });
      }

      const visitorName = conv.visitor?.name || 'A customer';
      const ticketUrl = `${appBaseUrl}/dashboard?conversation=${conv.id}`;
      const emailSubject = `[Zen-try] New message from ${visitorName} (Ticket #${conv.id.slice(0, 8)})`;
      const messageSnippet = message.content || 'Sent an attachment';

      console.log(
        `[Email Notification] Disagreeing agent offline (${agent.name} <${agent.email}>, status: ${agent.status}). Dispatching email...`
      );

      // If Resend API key is configured, send actual email
      let emailResult = { simulated: true };
      if (RESEND_API_KEY) {
        // Escaped by the shared layout: visitor names and messages are customer input.
        const offlineEmail = renderEmail({
          brandName: 'Zen-try',
          preheader: `${visitorName}: ${String(messageSnippet).slice(0, 100)}`,
          title: `${visitorName} replied while you were away`,
          paragraphs: [`A new message arrived in conversation #${conv.id.slice(0, 8)}, which is assigned to you.`],
          quote: { label: String(visitorName), text: String(messageSnippet) },
          button: { label: 'Open the conversation', url: ticketUrl },
          footer: `You received this because the conversation is assigned to you and your status is ${agent.status}.`,
        });
        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: 'Zen-try Support <notifications@zen-try.dev>',
            to: agent.email,
            subject: emailSubject,
            html: offlineEmail.html,
            text: offlineEmail.text,
          }),
        });

        if (resendRes.ok) {
          emailResult = await resendRes.json();
        }
      }

      return NextResponse.json({
        success: true,
        dispatched: 'email_offline_agent',
        agent: agent.email,
        subject: emailSubject,
        result: emailResult,
      });
    }

    return NextResponse.json({ error: 'Unknown event type' }, { status: 400 });
  } catch (error: any) {
    console.error('[Notification Dispatch Error]:', error);
    return NextResponse.json(
      { error: error.message || 'Notification dispatch failed' },
      { status: 500 }
    );
  }
}
