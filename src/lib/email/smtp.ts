import nodemailer from 'nodemailer';
import { SMTPSettingsConfig } from '@/types/database';
import { renderEmail } from './layout';

export function isValidEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function getEffectiveFromEmail(config: SMTPSettingsConfig): string {
  const customFrom = (config.from_email || '').trim();
  if (isValidEmail(customFrom)) {
    return customFrom;
  }
  return (config.user || '').trim();
}

export function createSmtpTransporter(config: SMTPSettingsConfig) {
  const isSecure = config.secure !== undefined 
    ? config.secure 
    : (Number(config.port) === 465);

  const cleanPass = (config.pass || '').trim().replace(/\s+/g, '');
  const cleanUser = (config.user || '').trim();
  const host = (config.host || '').trim();

  // If using Gmail / Google Workspace, use optimized Gmail service configuration
  if (host.includes('gmail') || cleanUser.endsWith('@gmail.com')) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: cleanUser,
        pass: cleanPass,
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }

  return nodemailer.createTransport({
    host: host,
    port: Number(config.port),
    secure: isSecure,
    auth: {
      user: cleanUser,
      pass: cleanPass,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    tls: {
      rejectUnauthorized: false,
    },
  });
}

/**
 * Which SMTP server a mailbox's domain actually uses, read from its MX
 * records. A login sent to the wrong provider fails exactly like a wrong
 * password, so this lets the error say which one it is.
 */
const MX_PROVIDERS: { mx: RegExp; name: string; host: string }[] = [
  { mx: /hostinger\.com$/i, name: 'Hostinger', host: 'smtp.hostinger.com' },
  { mx: /titan\.email$/i, name: 'Titan', host: 'smtp.titan.email' },
  { mx: /(google|googlemail)\.com$/i, name: 'Google Workspace', host: 'smtp.gmail.com' },
  { mx: /(outlook|office365)\.com$/i, name: 'Microsoft 365', host: 'smtp.office365.com' },
  { mx: /zoho\.(com|eu|in)$/i, name: 'Zoho Mail', host: 'smtp.zoho.com' },
  { mx: /secureserver\.net$/i, name: 'GoDaddy', host: 'smtpout.secureserver.net' },
];

export async function detectMailProvider(email: string): Promise<{ name: string; host: string } | null> {
  const domain = (email.split('@')[1] || '').trim().toLowerCase();
  if (!domain) return null;
  try {
    const { resolveMx, Resolver } = await import('node:dns/promises');
    // The system resolver first; public resolvers when it is unreachable
    // (some networks hand out a resolver Node cannot use).
    const records = await resolveMx(domain).catch(() => {
      const r = new Resolver({ timeout: 3000, tries: 1 });
      r.setServers(['1.1.1.1', '8.8.8.8']);
      return r.resolveMx(domain);
    });
    for (const r of records.sort((a, b) => a.priority - b.priority)) {
      const hit = MX_PROVIDERS.find((p) => p.mx.test(r.exchange.replace(/\.$/, '')));
      if (hit) return { name: hit.name, host: hit.host };
    }
  } catch {
    /* no MX or no network: say nothing rather than guess */
  }
  return null;
}

export async function testSmtpConnection(config: SMTPSettingsConfig): Promise<{ success: boolean; message?: string }> {
  try {
    const transporter = createSmtpTransporter(config);
    await transporter.verify();
    return { success: true };
  } catch (error: any) {
    console.error('[SMTP Verify Error]:', error);
    let msg = error.message || 'Failed to connect to SMTP server. Please check your credentials.';
    const host = (config.host || '').toLowerCase();
    if (error.code === 'EAUTH' || msg.includes('EAUTH') || msg.includes('535') || msg.includes('BadCredentials')) {
      // A login sent to the wrong provider is refused the same way as a
      // wrong password, so check where the domain's mail actually lives.
      const provider = await detectMailProvider(config.user || '');
      if (provider && provider.host !== host) {
        msg = `${config.user} is hosted by ${provider.name}, so the SMTP server should be ${provider.host}, not ${config.host}. Change the host and test again.`;
      } else if (host.includes('gmail')) {
        msg = `Gmail authentication failed. Google does not accept your regular Gmail password for SMTP. Please generate a 16-character Google App Password at https://myaccount.google.com/apppasswords and paste it in the password field.`;
      } else if (host.includes('hostinger')) {
        msg =
          `Hostinger rejected the password for ${config.user}. The server and port are right, so the password is the problem. ` +
          `It must be this mailbox's own password (hPanel → Emails → Email accounts → ${config.user} → Change password), not your Hostinger account password. ` +
          `Check it by signing in at https://mail.hostinger.com with the same address and password; if that fails too, set a new mailbox password in hPanel. ` +
          `After several failed attempts Hostinger may block logins for about 15 minutes.`;
      } else {
        msg = `The mail server rejected the login for ${config.user}. Check the password by signing in to that mailbox's webmail with the same address and password.`;
      }
    } else if (msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED')) {
      msg = `Could not connect to ${config.host}:${config.port}. Please verify the host and port (465 SSL or 587 TLS).`;
    }
    return { 
      success: false, 
      message: msg 
    };
  }
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Extra headers, e.g. Auto-Submitted on automatic notifications. */
  headers?: Record<string, string>;
}

/** A readable plain-text part for mail that came with HTML only. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function sendSmtpEmail(
  config: SMTPSettingsConfig, 
  options: SendEmailOptions
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const transporter = createSmtpTransporter(config);
    const effectiveFrom = getEffectiveFromEmail(config);
    const cleanSenderName = (config.from_name || 'Support Desk')
      .replace(/["\r\n\\]/g, '')
      .trim();
    const fromAddress = `"${cleanSenderName}" <${effectiveFrom}>`;

    const info = await transporter.sendMail({
      from: fromAddress,
      to: options.to.trim(),
      replyTo: options.replyTo && isValidEmail(options.replyTo) ? options.replyTo.trim() : effectiveFrom,
      subject: options.subject.replace(/[\r\n]+/g, ' ').trim(),
      // Spam filters distrust HTML-only mail; every message gets a text part.
      text: options.text || htmlToText(options.html),
      html: options.html,
      headers: options.headers,
    });

    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error('[SMTP Send Error]:', error);
    let errMsg = error.message || 'Failed to send email';
    if (errMsg.includes('553') && errMsg.includes('Sender address rejected')) {
      errMsg = `Sender address rejected. Most email providers (including Hostinger) require the "From" address to match your authenticated login username (${config.user}).`;
    } else if (errMsg.includes('535') || errMsg.includes('BadCredentials')) {
      errMsg = (config.host || '').includes('gmail')
        ? `Google rejected SMTP login for ${config.user} (535). Use a 16-character App Password from myaccount.google.com/apppasswords.`
        : `The mail server rejected the login for ${config.user} (535). Check the mailbox password in Settings → SMTP and use "Test connection".`;
    }
    return { success: false, error: errMsg };
  }
}

/* ── Email templates (all on the shared layout, src/lib/email/layout.ts) ── */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface UnreadEmailTemplateProps {
  visitorName: string;
  workspaceName: string;
  brandColor?: string | null;
  logoUrl?: string | null;
  messageContent: string;
  ticketId: string;
  chatUrl: string;
}

/** To a customer: a reply they have not read in the chat for 5 minutes. */
export function unreadReplyEmail(p: UnreadEmailTemplateProps): RenderedEmail {
  const workspace = p.workspaceName || 'Support';
  const first = (p.visitorName || '').trim().split(/\s+/)[0];
  const preview = p.messageContent.replace(/\s+/g, ' ').trim();
  const { html, text } = renderEmail({
    brandName: workspace,
    brandColor: p.brandColor,
    logoUrl: p.logoUrl,
    preheader: preview.slice(0, 110),
    title: `${workspace} replied to your message`,
    paragraphs: [`Hi ${first && first !== 'there' ? first : 'there'}, you have a reply waiting in your conversation with ${workspace}.`],
    quote: { label: `From ${workspace}`, text: p.messageContent },
    button: { label: 'Open the conversation', url: p.chatUrl },
    afterButton: 'You can also reply from the chat on our website. If the button does not work, use this link:',
    footer: `You received this because you started a conversation with ${workspace} and had not seen this reply yet.`,
  });
  return { subject: `New reply from ${workspace}`, html, text };
}

/** Kept for older callers: the HTML part only. */
export function generateUnreadAlertEmailHtml(props: UnreadEmailTemplateProps): string {
  return unreadReplyEmail(props).html;
}

export interface VerificationCodeEmailProps {
  code: string;
  name?: string;
  platformName?: string;
  platformUrl?: string;
}

/** Sign-up email verification code. */
export function verificationCodeEmail(p: VerificationCodeEmailProps): RenderedEmail {
  const platform = p.platformName || 'Zen-try';
  const { html, text } = renderEmail({
    brandName: platform,
    preheader: `Your ${platform} verification code is ${p.code}. It expires in 10 minutes.`,
    title: 'Confirm your email address',
    paragraphs: [`Hi ${p.name || 'there'}, enter this code in ${platform} to finish creating your account.`],
    code: p.code,
    afterButton: 'The code expires in 10 minutes and works once.',
    footer: `You received this because someone used this address to sign up for ${platform}. If that was not you, ignore this email; no account is created without the code.`,
  });
  return { subject: `${p.code} is your ${platform} verification code`, html, text };
}

export function generateVerificationCodeEmailHtml(props: VerificationCodeEmailProps): string {
  return verificationCodeEmail(props).html;
}

export interface AdminInviteEmailProps {
  recipientEmail: string;
  role: 'owner' | 'admin';
  inviteUrl: string;
  ownerEmail?: string;
  platformName?: string;
}

/** Platform staff invitation (super-admin panel). */
export function adminInviteEmail(p: AdminInviteEmailProps): RenderedEmail {
  const platform = p.platformName || 'Zen-try';
  const roleLabel = p.role === 'owner' ? 'Platform owner' : 'Platform admin';
  const { html, text } = renderEmail({
    brandName: platform,
    preheader: `You have been invited to the ${platform} admin panel as ${roleLabel.toLowerCase()}.`,
    title: `Join the ${platform} admin panel`,
    paragraphs: [
      `${p.ownerEmail || 'The platform owner'} invited you to help run ${platform}. Accept the invitation to set your password and sign in.`,
    ],
    details: [
      ['Email', p.recipientEmail],
      ['Role', roleLabel],
    ],
    button: { label: 'Accept invitation', url: p.inviteUrl },
    afterButton: 'This invitation expires in 48 hours and works once. If the button does not work, use this link:',
    footer: `You received this because ${p.ownerEmail || 'the platform owner'} invited ${p.recipientEmail}. If you were not expecting it, ignore this email.`,
  });
  return { subject: `You're invited to the ${platform} admin panel`, html, text };
}

export function generateAdminInviteEmailHtml(props: AdminInviteEmailProps): string {
  return adminInviteEmail(props).html;
}

export interface AdminAccessGrantedEmailProps {
  recipientEmail: string;
  role: 'owner' | 'admin';
  adminUrl: string;
  ownerEmail?: string;
  platformName?: string;
}

/** An existing account was given platform admin access. */
export function adminAccessGrantedEmail(p: AdminAccessGrantedEmailProps): RenderedEmail {
  const platform = p.platformName || 'Zen-try';
  const roleLabel = p.role === 'owner' ? 'Platform owner' : 'Platform admin';
  const { html, text } = renderEmail({
    brandName: platform,
    preheader: `You now have ${roleLabel.toLowerCase()} access to ${platform}.`,
    title: 'You have admin access',
    paragraphs: [`${p.ownerEmail || 'The platform owner'} gave your account access to the ${platform} admin panel. Sign in with your usual email and password.`],
    details: [
      ['Email', p.recipientEmail],
      ['Role', roleLabel],
    ],
    button: { label: 'Open the admin panel', url: p.adminUrl },
    footer: `You received this because your access to ${platform} changed. If you did not expect it, tell the platform owner.`,
  });
  return { subject: `Your ${platform} admin access is ready`, html, text };
}

export function generateAdminAccessGrantedEmailHtml(props: AdminAccessGrantedEmailProps): string {
  return adminAccessGrantedEmail(props).html;
}

/** "Test connection" in SMTP settings. */
export function smtpTestEmail(p: { brandName: string; host: string; port: number; from: string; user: string }): RenderedEmail {
  const { html, text } = renderEmail({
    brandName: p.brandName,
    preheader: `Email from ${p.brandName} is set up and sending.`,
    title: 'Your email settings work',
    paragraphs: [`This test message was sent through your mail server, so customer replies, team invitations and alerts from ${p.brandName} will go out from this address.`],
    details: [
      ['Server', `${p.host}:${p.port}`],
      ['Sent from', p.from],
      ['Signed in as', p.user],
    ],
    footer: 'You received this because someone pressed "Send test email" in the email settings.',
  });
  return { subject: `Test email from ${p.brandName}`, html, text };
}

/** A plain message from the team (ticket replies, automation emails). */
export function teamMessageEmail(p: {
  brandName: string;
  brandColor?: string | null;
  logoUrl?: string | null;
  subject: string;
  /** Heading inside the email; defaults to the subject. */
  title?: string;
  body: string;
  details?: [string, string][];
  footer: string;
}): RenderedEmail {
  const paragraphs = p.body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const { html, text } = renderEmail({
    brandName: p.brandName,
    brandColor: p.brandColor,
    logoUrl: p.logoUrl,
    preheader: p.body.replace(/\s+/g, ' ').slice(0, 110),
    title: p.title || p.subject,
    paragraphs: paragraphs.length ? paragraphs : [p.body],
    details: p.details,
    footer: p.footer,
  });
  return { subject: p.subject, html, text };
}
