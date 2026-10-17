import { domainOf, isEmail, normalizeEmail } from './address-basics';

export const DEFAULT_SIGNATURE = '{{agent.name}}\n{{workspace.name}} Support';

/**
 * Validation for Settings → Channels → Email, shared by the form (inline
 * errors) and the server action (the real check).
 */

export interface EmailSettingsInput {
  from_name: string;
  signature: string;
  /** Empty means "use the platform address only". */
  custom_address: string;
}

export type EmailSettingsErrors = Partial<Record<keyof EmailSettingsInput, string>>;

export const FROM_NAME_MAX = 80;
export const SIGNATURE_MAX = 500;

/** Domains nobody may claim as their sending domain: free mail providers can never be authenticated by us. */
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'zoho.com']);

export function validateEmailSettings(input: EmailSettingsInput, ctx: { inboundDomain: string | null; forwardingAddress: string }): EmailSettingsErrors {
  const errors: EmailSettingsErrors = {};
  if (input.from_name.trim().length > FROM_NAME_MAX) errors.from_name = `Keep the name under ${FROM_NAME_MAX} characters.`;
  if (input.signature.length > SIGNATURE_MAX) errors.signature = `Keep the signature under ${SIGNATURE_MAX} characters.`;
  const unknown = Array.from(input.signature.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)).map((m) => m[1]).filter((k) => k !== 'agent.name' && k !== 'workspace.name');
  if (!errors.signature && unknown.length) errors.signature = `Only {{agent.name}} and {{workspace.name}} can be used (found {{${unknown[0]}}}).`;

  const custom = input.custom_address.trim();
  if (custom) {
    const email = normalizeEmail(custom);
    if (!isEmail(email)) errors.custom_address = 'Enter a full email address, such as help@yourcompany.com.';
    else if (email === normalizeEmail(ctx.forwardingAddress) || (ctx.inboundDomain && domainOf(email) === ctx.inboundDomain)) {
      errors.custom_address = 'That is the address we gave you. Enter your own address here, such as help@yourcompany.com.';
    } else if (FREE_MAIL.has(domainOf(email))) {
      errors.custom_address = 'Free mail providers (Gmail, Outlook, …) cannot be used as a sending address. Use an address on your own domain.';
    }
  }
  return errors;
}

