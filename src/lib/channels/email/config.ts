/**
 * Environment the email channel needs. Everything is read lazily so a missing
 * variable shows up as a clear message on the channel page, not a crash.
 */

export interface EmailConfig {
  /** Domain whose MX points at the provider's inbound servers: workspaces get `<slug>@<this>`. */
  inboundDomain: string | null;
  /** Domain the platform sends from when a workspace has no verified domain of its own. */
  fromDomain: string | null;
  /** Signs the ticket token in reply-to addresses. */
  tokenSecret: string | null;
  appUrl: string;
}

export function emailConfig(): EmailConfig {
  const inboundDomain = (process.env.EMAIL_INBOUND_DOMAIN || '').trim().toLowerCase() || null;
  return {
    inboundDomain,
    fromDomain: (process.env.EMAIL_FROM_DOMAIN || '').trim().toLowerCase() || inboundDomain,
    tokenSecret: process.env.EMAIL_TOKEN_SECRET || process.env.CHANNEL_ENCRYPTION_KEY || null,
    appUrl: (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, ''),
  };
}

/** What is missing on the server, in words an admin can act on. */
export function emailSetupProblems(providerConfigured: boolean, providerName: string): string[] {
  const cfg = emailConfig();
  const out: string[] = [];
  if (!cfg.inboundDomain) out.push('EMAIL_INBOUND_DOMAIN is not set, so workspaces cannot be given a support address.');
  if (!cfg.tokenSecret) out.push('EMAIL_TOKEN_SECRET (or CHANNEL_ENCRYPTION_KEY) is not set, so replies cannot be matched to tickets.');
  if (!providerConfigured) out.push(`The ${providerName} email provider is not configured (see POSTMARK_SERVER_TOKEN), so email cannot be sent.`);
  if (!process.env.EMAIL_WEBHOOK_AUTH) out.push('EMAIL_WEBHOOK_AUTH is not set, so inbound email webhooks are refused.');
  if (!cfg.appUrl) out.push('NEXT_PUBLIC_APP_URL is not set, so the webhook URL cannot be shown.');
  return out;
}
