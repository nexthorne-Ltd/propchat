import { serviceClient } from '@/lib/supabase/service';
import { Workspace } from '@/types/database';
import { sendSmtpEmail } from './smtp';
import { loadWorkspaceSmtp } from './workspace-smtp';
import { renderEmail } from './layout';
import { cleanDomain, getPlatformOrigin, splitDomain, CNAME_TARGET } from '@/lib/domain';
import { DEFAULT_BRAND_COLOR } from '@/lib/brand';

interface DomainLiveEmailParams {
  workspace: Workspace;
  domain: string;
}

interface DomainFailedEmailParams {
  workspace: Workspace;
  domain: string;
  reason: string;
  detectedCname?: string | null;
  isCloudflare?: boolean;
}

/**
 * Finds the email address of the workspace owner.
 */
export async function getWorkspaceOwnerEmail(workspaceId: string, ownerId?: string): Promise<{
  email: string | null;
  name: string | null;
}> {
  const supabase = serviceClient();

  if (ownerId) {
    const { data: owner } = await supabase
      .from('agents')
      .select('email, name')
      .eq('id', ownerId)
      .maybeSingle();

    if (owner?.email) {
      return { email: owner.email, name: owner.name };
    }
  }

  // Fallback to any agent with role 'owner' in this workspace
  const { data: owners } = await supabase
    .from('agents')
    .select('email, name')
    .eq('workspace_id', workspaceId)
    .eq('role', 'owner')
    .limit(1);

  if (owners && owners.length > 0 && owners[0]?.email) {
    return { email: owners[0].email, name: owners[0].name };
  }

  return { email: null, name: null };
}

/**
 * Sends an email notification when a custom domain goes Live.
 */
export async function sendDomainLiveEmail(params: DomainLiveEmailParams): Promise<{
  success: boolean;
  sentTo?: string;
  error?: string;
}> {
  const { workspace, domain } = params;
  const clean = cleanDomain(domain);
  const helpCenterUrl = `https://${clean}`;
  const brand = workspace.brand_color || DEFAULT_BRAND_COLOR;

  const { email, name } = await getWorkspaceOwnerEmail(workspace.id, workspace.owner_id);
  if (!email) {
    console.warn(`[Domain Email] No owner email found for workspace ${workspace.id}`);
    return { success: false, error: 'No owner email found' };
  }

  const { subject, html, text } = (() => {
    const e = renderEmail({
      brandName: workspace.name || 'Your help center',
      brandColor: brand,
      logoUrl: workspace.logo_url,
      preheader: `${clean} is verified, secured with SSL and serving your help center.`,
      title: 'Your help center is live',
      paragraphs: [
        `Hi ${name || 'there'},`,
        `${clean} is verified and has an SSL certificate, and your help center is now served from it. Visitors to your old address are redirected automatically, and links in chat and bot answers use the new domain.`,
      ],
      details: [['Address', helpCenterUrl]],
      button: { label: 'Open your help center', url: helpCenterUrl },
      footer: `You received this because you connected ${clean} to ${workspace.name || 'your workspace'}.`,
    });
    return { subject: `Your help center is live on ${clean}`, ...e };
  })();

  const smtp = await loadWorkspaceSmtp(workspace.id);
  if (smtp) {
    const res = await sendSmtpEmail(smtp, {
      to: email,
      subject,
      html,
      text,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    return { success: res.success, sentTo: email, error: res.error };
  } else {
    console.log(`[Domain Email] SMTP not configured. Live email for ${clean} would be sent to: ${email}`);
    return { success: true, sentTo: email };
  }
}

/**
 * Sends an email notification if a custom domain setup is still failing after 24 hours,
 * providing the exact diagnosis and steps to resolve.
 */
export async function sendDomainFailed24hEmail(params: DomainFailedEmailParams): Promise<{
  success: boolean;
  sentTo?: string;
  error?: string;
}> {
  const { workspace, domain, reason, detectedCname, isCloudflare } = params;
  const clean = cleanDomain(domain);
  const { hostRecord } = splitDomain(clean);
  const brand = workspace.brand_color || DEFAULT_BRAND_COLOR;
  // Workspace owners manage domains in their dashboard, not the platform admin panel.
  const settingsUrl = `${getPlatformOrigin()}/dashboard`;

  const { email, name } = await getWorkspaceOwnerEmail(workspace.id, workspace.owner_id);
  if (!email) {
    console.warn(`[Domain Email] No owner email found for workspace ${workspace.id}`);
    return { success: false, error: 'No owner email found' };
  }

  const { subject, html, text } = (() => {
    const notes = [
      detectedCname ? `It currently points to ${detectedCname}; it should point to ${CNAME_TARGET}.` : null,
      isCloudflare ? 'Your DNS is on Cloudflare: set the record to "DNS only" (grey cloud). The orange cloud hides the CNAME from our check.' : null,
    ].filter(Boolean) as string[];
    const e = renderEmail({
      brandName: workspace.name || 'Your help center',
      brandColor: brand,
      logoUrl: workspace.logo_url,
      preheader: `We still cannot verify ${clean}. One DNS record is needed.`,
      title: `${clean} is not connected yet`,
      paragraphs: [
        `Hi ${name || 'there'},`,
        `You connected ${clean} to your help center more than a day ago, but we still cannot verify its DNS. Add the record below at your domain provider; we check again automatically and switch on SSL as soon as it is found.`,
        ...notes,
      ],
      quote: reason ? { label: 'What our check found', text: reason } : undefined,
      details: [
        ['Type', 'CNAME'],
        ['Name / host', hostRecord],
        ['Value / target', CNAME_TARGET],
      ],
      button: { label: 'Open domain settings', url: settingsUrl },
      footer: `You received this because you connected ${clean} to ${workspace.name || 'your workspace'} and it has not verified for 24 hours.`,
    });
    return { subject: `Action needed: finish connecting ${clean}`, ...e };
  })();

  const smtp = await loadWorkspaceSmtp(workspace.id);
  if (smtp) {
    const res = await sendSmtpEmail(smtp, {
      to: email,
      subject,
      html,
      text,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    return { success: res.success, sentTo: email, error: res.error };
  } else {
    console.log(`[Domain Email] SMTP not configured. Failed 24h email for ${clean} would be sent to: ${email}`);
    return { success: true, sentTo: email };
  }
}
