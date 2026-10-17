import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Secret used to sign CSAT survey links sent via email.
 * Falls back to NEXT_PUBLIC_SUPABASE_ANON_KEY or a hardcoded pepper if unset.
 */
function getSigningSecret(): string {
  return (
    process.env.CHANNEL_ENCRYPTION_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    'zentry-csat-token-secret-fallback'
  );
}

/**
 * Generates a tamper-proof hex HMAC token for a ticket CSAT survey link.
 */
export function generateCsatToken(ticketId: string, workspaceId: string): string {
  const hmac = createHmac('sha256', getSigningSecret());
  hmac.update(`csat:${workspaceId}:${ticketId}`);
  return hmac.digest('hex').slice(0, 32); // 32-character hex token
}

/**
 * Verifies a CSAT token against ticketId and workspaceId.
 */
export function verifyCsatToken(ticketId: string, workspaceId: string, token: string): boolean {
  if (!ticketId || !workspaceId || !token) return false;
  const expected = generateCsatToken(ticketId, workspaceId);
  try {
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
