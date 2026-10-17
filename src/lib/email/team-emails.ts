/**
 * Emails a workspace sends to its own team: the invitation to join, and the
 * alert that a customer is waiting for a person. Both go out through the
 * workspace's SMTP (Settings → Channels → SMTP), so they come from the
 * business's own address, and both use the shared layout (layout.ts), which
 * escapes everything.
 */
import { renderEmail } from './layout';

export interface InviteEmailProps {
  workspaceName: string;
  brandColor?: string | null;
  logoUrl?: string | null;
  inviteeName: string;
  inviterName: string;
  roleLabel: string;
  acceptUrl: string;
  expiresInDays: number;
}

export function inviteEmail(p: InviteEmailProps): { subject: string; html: string; text: string } {
  const first = (p.inviteeName || '').trim().split(/\s+/)[0];
  const { html, text } = renderEmail({
    brandName: p.workspaceName,
    brandColor: p.brandColor,
    logoUrl: p.logoUrl,
    preheader: `${p.inviterName} invited you to answer customers with the ${p.workspaceName} team.`,
    title: `Join ${p.workspaceName}`,
    paragraphs: [
      `Hi ${first || 'there'},`,
      `${p.inviterName} invited you to the ${p.workspaceName} support team. Accept the invitation, choose your own password, and you will go straight to the shared inbox.`,
    ],
    details: [
      ['Role', p.roleLabel],
      ['Link valid for', `${p.expiresInDays} days, one use`],
    ],
    button: { label: 'Accept invitation', url: p.acceptUrl },
    footer: `You received this because ${p.inviterName} invited this address to ${p.workspaceName}. If you were not expecting it, you can ignore this email.`,
  });
  return { subject: `${p.inviterName} invited you to join ${p.workspaceName}`, html, text };
}

export type TeamAlertEvent = 'handover' | 'customer_reply';

export interface TeamAlertEmailProps {
  event: TeamAlertEvent;
  workspaceName: string;
  brandColor?: string | null;
  visitorName: string;
  preview: string;
  reason?: string | null;
  conversationUrl: string;
  onShift: boolean;
}

export function teamAlertEmail(p: TeamAlertEmailProps): { subject: string; html: string; text: string } {
  const preview = p.preview.replace(/\s+/g, ' ').trim().slice(0, 600);
  const handover = p.event === 'handover';
  const subject = handover ? `${p.visitorName} needs a person` : `${p.visitorName} replied and is waiting`;
  const { html, text } = renderEmail({
    brandName: p.workspaceName,
    brandColor: p.brandColor,
    preheader: preview ? `"${preview.slice(0, 100)}"` : subject,
    title: subject,
    paragraphs: [
      handover
        ? `The bot handed a conversation with ${p.visitorName} to the team. Nobody has replied yet.`
        : `${p.visitorName} wrote again in a conversation the team is handling.`,
    ],
    quote: preview ? { label: p.visitorName, text: preview } : undefined,
    details: p.reason ? [['Why', p.reason.slice(0, 200)]] : undefined,
    button: { label: 'Open the conversation', url: p.conversationUrl },
    footer: p.onShift
      ? `You received this because you are on shift for ${p.workspaceName}. Choose what you are emailed about in Settings → Notifications.`
      : `You received this as a member of ${p.workspaceName}. Choose what you are emailed about in Settings → Notifications.`,
  });
  return { subject, html, text };
}
