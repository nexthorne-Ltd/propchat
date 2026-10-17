import 'server-only';
import crypto from 'node:crypto';
import type { serviceClient } from '@/lib/supabase/service';

/**
 * Generates a cryptographically sound 6-digit OTP code using crypto.randomInt
 */
export function generate6DigitCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Compares two codes in constant time to prevent timing attacks.
 */
export function timingSafeCodeCheck(input: string, stored: string): boolean {
  const bufInput = Buffer.from(input, 'utf8');
  const bufStored = Buffer.from(stored, 'utf8');
  if (bufInput.length !== bufStored.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufInput, bufStored);
}

/**
 * Looks up an auth user by email across all pages.
 */
export async function findAuthUserByEmail(
  admin: ReturnType<typeof serviceClient>,
  email: string
) {
  const targetEmail = (email || '').trim().toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      console.error('[Verification] Error listing users:', error);
      break;
    }
    const found = (data?.users || []).find((u) => u.email?.toLowerCase() === targetEmail);
    if (found) return found;
    if (!data?.users || data.users.length < 1000) break;
  }
  return null;
}
