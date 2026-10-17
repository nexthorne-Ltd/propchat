import { NextRequest, NextResponse } from 'next/server';
import { guardWorkspace } from '@/lib/team/route-guard';
import { hasServiceRole, serviceClient } from '@/lib/supabase/service';
import { sendSmtpEmail, unreadReplyEmail } from '@/lib/email/smtp';
import { loadWorkspaceSmtp } from '@/lib/email/workspace-smtp';
import type { Workspace } from '@/types/database';
import { getRequestOrigin } from '@/lib/request-origin';

export const dynamic = 'force-dynamic';

/**
 * Emails customers the replies they have not read for 5 minutes, through
 * their workspace's own SMTP.
 *
 * Two callers:
 *   - the scheduler (Authorization: Bearer $CRON_SECRET): every workspace;
 *   - an admin pressing "Run check now" in Settings → SMTP, with
 *     ?workspace_id=…: that workspace only.
 * It used to run for every workspace whenever any signed-in member asked, and
 * every open dashboard asked once a minute, so the same platform-wide job ran
 * many times a minute and two runs could email the same reply twice. Messages
 * are now claimed (email_notified_at set) before sending, and released again
 * if the send fails.
 */
export async function GET(req: NextRequest) {
  return processUnreadNotifications(req);
}

export async function POST(req: NextRequest) {
  return processUnreadNotifications(req);
}

async function processUnreadNotifications(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const fromScheduler = Boolean(secret && req.headers.get('authorization') === `Bearer ${secret}`);
  let onlyWorkspace: string | null = null;
  if (!fromScheduler) {
    const workspaceId = req.nextUrl.searchParams.get('workspace_id');
    const guard = await guardWorkspace(workspaceId, 'manage_settings');
    if (!guard.ok) return guard.response;
    onlyWorkspace = String(workspaceId);
  }
  if (!hasServiceRole()) {
    return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not set' }, { status: 500 });
  }

  try {
    const supabase = serviceClient();
    const appBaseUrl = await getRequestOrigin(req);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Unread public agent/bot replies older than 5 minutes, not emailed yet.
    let msgQuery = supabase
      .from('messages')
      .select('id, conversation_id, content, attachment_url, sender_type, created_at, conversation:conversations!inner(workspace_id)')
      .in('sender_type', ['agent', 'ai'])
      .is('read_at', null)
      .is('email_notified_at', null)
      .or('is_internal.is.null,is_internal.eq.false')
      .lte('created_at', fiveMinutesAgo)
      .order('created_at', { ascending: true })
      .limit(500);
    if (onlyWorkspace) msgQuery = msgQuery.eq('conversation.workspace_id', onlyWorkspace);
    const { data: unreadMessages, error: msgError } = await msgQuery;

    if (msgError) {
      console.error('[Unread Cron Error] Fetching messages:', msgError);
      return NextResponse.json({ error: msgError.message }, { status: 500 });
    }
    if (!unreadMessages?.length) {
      return NextResponse.json({ success: true, processedConversations: 0, sentEmails: 0, skippedConversations: 0 });
    }

    const messagesByConv = new Map<string, typeof unreadMessages>();
    for (const msg of unreadMessages) {
      messagesByConv.set(msg.conversation_id, [...(messagesByConv.get(msg.conversation_id) || []), msg]);
    }

    const { data: convs, error: convError } = await supabase
      .from('conversations')
      .select('id, workspace_id, visitor:visitors(id, name, email, current_url)')
      .in('id', Array.from(messagesByConv.keys()));
    if (convError || !convs) {
      console.error('[Unread Cron Error] Fetching conversations:', convError);
      return NextResponse.json({ error: convError?.message || 'Failed to fetch conversations' }, { status: 500 });
    }

    const workspaceIds = Array.from(new Set(convs.map((c) => c.workspace_id).filter(Boolean))) as string[];
    const { data: workspaces } = await supabase
      .from('workspaces')
      .select('id, name, brand_color, logo_url, website_url')
      .in('id', workspaceIds);
    const workspaceMap = new Map<string, Pick<Workspace, 'id' | 'name' | 'brand_color' | 'logo_url' | 'website_url'>>();
    for (const ws of workspaces || []) workspaceMap.set(ws.id, ws as Workspace);

    let sentCount = 0;
    let skippedCount = 0;
    const errors: { conversation_id: string; error: string }[] = [];

    for (const conv of convs as unknown as {
      id: string;
      workspace_id: string;
      visitor: { name?: string | null; email?: string | null; current_url?: string | null } | null;
    }[]) {
      const msgs = messagesByConv.get(conv.id) || [];
      const visitor = conv.visitor;
      const workspace = workspaceMap.get(conv.workspace_id);
      if (!msgs.length || !visitor?.email?.includes('@') || !workspace) {
        skippedCount++;
        continue;
      }
      const smtp = await loadWorkspaceSmtp(conv.workspace_id);
      if (!smtp) {
        skippedCount++;
        continue;
      }

      // Claim first: a second run that overlaps this one finds nothing to send.
      const msgIds = msgs.map((m) => m.id);
      const claimedAt = new Date().toISOString();
      const { data: claimed } = await supabase
        .from('messages')
        .update({ email_notified_at: claimedAt })
        .in('id', msgIds)
        .is('email_notified_at', null)
        .select('id');
      const claimedIds = new Set((claimed || []).map((m) => m.id));
      const mine = msgs.filter((m) => claimedIds.has(m.id));
      if (!mine.length) continue;

      const combinedMessage = mine
        .map((m) => m.content || (m.attachment_url ? '[Sent an attachment]' : ''))
        .filter(Boolean)
        .join('\n\n');

      const fallbackUrl = visitor.current_url || workspace.website_url || `${appBaseUrl}/demo.html?workspaceId=${workspace.id}`;
      let chatUrl = fallbackUrl;
      try {
        const urlObj = new URL(fallbackUrl, appBaseUrl || undefined);
        urlObj.searchParams.set('zentry_conversation', conv.id);
        urlObj.searchParams.set('zentry_open', '1');
        chatUrl = urlObj.toString();
      } catch {
        /* keep the plain URL */
      }

      const email = unreadReplyEmail({
        visitorName: visitor.name || '',
        workspaceName: workspace.name || smtp.from_name || 'Support',
        brandColor: workspace.brand_color,
        logoUrl: workspace.logo_url,
        messageContent: combinedMessage,
        ticketId: conv.id,
        chatUrl,
      });
      const sendResult = await sendSmtpEmail(smtp, {
        to: visitor.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: { 'Auto-Submitted': 'auto-generated' },
      });

      if (sendResult.success) {
        sentCount++;
      } else {
        // Release the claim so the next run tries again.
        await supabase.from('messages').update({ email_notified_at: null }).in('id', Array.from(claimedIds)).eq('email_notified_at', claimedAt);
        errors.push({ conversation_id: conv.id, error: sendResult.error || 'Send failed' });
      }
    }

    return NextResponse.json({
      success: true,
      processedConversations: convs.length,
      sentEmails: sentCount,
      skippedConversations: skippedCount,
      errors: errors.length ? errors : undefined,
    });
  } catch (error) {
    console.error('[Unread Notifications Cron Critical Error]:', error);
    return NextResponse.json({ error: (error as Error).message || 'Internal error' }, { status: 500 });
  }
}
