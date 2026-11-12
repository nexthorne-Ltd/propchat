'use server';

import crypto from 'crypto';
import { headers } from 'next/headers';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { checkRateLimit } from '@/lib/rate-limit';
import { findAuthUserByEmail } from '@/lib/auth/verification-code';

/*
 * Self-service sign-up and sign-in for the platform admin panel.
 *
 * An admin can open every workspace, change its plan and read its data, so
 * sign-up is never open: it needs ADMIN_SIGNUP_KEY, a secret only the
 * operator (whoever controls the deployment's env vars) knows. Without the
 * env var the page refuses every request. A key-holder becomes an `admin`,
 * never the `owner` (platform_access allows one owner; owner changes stay on
 * the invite flow in platform.ts).
 *
 * Someone who already has a Zentry login (a workspace owner, say) keeps it:
 * their password must match, it is never changed, and their workspace
 * membership is left alone. Only the admin flag and platform_access are
 * added.
 */

const MIN_KEY_LENGTH = 16;

function keyMatches(given: string, expected: string): boolean {
  // Hash both sides so the comparison is constant time whatever the lengths.
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get('x-forwarded-for') || h.get('x-real-ip') || 'unknown').split(',')[0].trim();
}

export async function isAdminSignupEnabledAction(): Promise<boolean> {
  return (process.env.ADMIN_SIGNUP_KEY || '').trim().length >= MIN_KEY_LENGTH;
}

export async function adminSignupAction(input: {
  setupKey: string;
  name: string;
  email: string;
  password: string;
}): Promise<{ success: boolean; error?: string; existingAccount?: boolean }> {
  const expected = (process.env.ADMIN_SIGNUP_KEY || '').trim();
  if (expected.length < MIN_KEY_LENGTH) {
    return { success: false, error: 'Admin sign-up is turned off. Set ADMIN_SIGNUP_KEY (16+ characters) on the server to enable it.' };
  }

  // Slows down guessing the key: 5 tries per 15 minutes per address.
  if (!(await checkRateLimit(`admin_signup:${await clientIp()}`, 5, 15 * 60))) {
    return { success: false, error: 'Too many attempts. Try again in 15 minutes.' };
  }

  if (!keyMatches((input.setupKey || '').trim(), expected)) {
    console.warn('[Admin Signup] Rejected: wrong setup key');
    return { success: false, error: 'The setup key is not correct.' };
  }

  const name = (input.name || '').trim();
  const email = (input.email || '').trim().toLowerCase();
  const password = input.password || '';
  if (name.length < 2) return { success: false, error: 'Please enter your full name.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { success: false, error: 'Please enter a valid email address.' };
  if (password.length < 8) return { success: false, error: 'Password must be at least 8 characters long.' };

  const admin = serviceClient();

  let userId: string | null = (await findAuthUserByEmail(admin, email))?.id ?? null;

  let existingAccount = false;
  if (userId) {
    existingAccount = true;
    // The account is someone's: prove it is yours with its own password.
    // A throwaway client (no session kept) so nothing is signed in here.
    const verifier = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { error: pwErr } = await verifier.auth.signInWithPassword({ email, password });
    if (pwErr) {
      return { success: false, error: 'This email already has an account. Enter that account\'s current password to make it an admin.' };
    }

    const { data: access } = await admin.from('platform_access').select('role').eq('user_id', userId).maybeSingle();
    if (access) {
      return { success: true, existingAccount: true };
    }

    const { data: agentRow } = await admin.from('agents').select('id').eq('id', userId).maybeSingle();
    if (agentRow) {
      const { error } = await admin.from('agents').update({ is_super_admin: true }).eq('id', userId);
      if (error) console.error('[Admin Signup] Could not flag agent as admin:', error);
    } else {
      const { error } = await admin.from('agents').insert({
        id: userId, name, email, workspace_id: null, role: 'admin', status: 'offline',
        is_active: true, is_super_admin: true, is_platform_owner: false, platform_staff_role: 'support',
      });
      if (error) console.error('[Admin Signup] Could not create agent row:', error);
    }
  } else {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    });
    if (createErr || !created?.user) {
      console.error('[Admin Signup] Create user failed:', createErr);
      return { success: false, error: createErr?.message || 'Could not create the account.' };
    }
    userId = created.user.id;

    // Admin-only: no workspace, so onboarding is never shown.
    const { error: agentErr } = await admin.from('agents').upsert(
      {
        id: userId, name, email, workspace_id: null, role: 'admin', status: 'offline',
        is_active: true, is_super_admin: true, is_platform_owner: false, platform_staff_role: 'support',
      },
      { onConflict: 'id' }
    );
    if (agentErr) console.error('[Admin Signup] Could not create agent row:', agentErr);
  }

  const { error: accessErr } = await admin.from('platform_access').insert({
    user_id: userId,
    role: 'admin',
    granted_by: null,
    granted_at: new Date().toISOString(),
  });
  if (accessErr) {
    console.error('[Admin Signup] Could not grant platform access:', accessErr);
    return { success: false, error: 'The account was created but admin access could not be granted. Try again.' };
  }

  const { error: auditErr } = await admin.from('super_admin_audit_logs').insert({
    admin_id: userId,
    admin_email: email,
    admin_name: name,
    action: 'platform_admin_self_signup',
    workspace_id: null,
    workspace_name: null,
    details: { via: 'setup_key', existing_account: existingAccount },
  });
  if (auditErr) console.error('[Admin Signup] Audit log failed:', auditErr);

  return { success: true, existingAccount };
}

/** Whether the signed-in user may open /admin. Used by the admin login page. */
export async function checkAdminAccessAction(): Promise<{ isAdmin: boolean; role: 'owner' | 'admin' | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { isAdmin: false, role: null };
  const { data: access } = await serviceClient()
    .from('platform_access')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();
  const role = access && ['owner', 'admin'].includes(access.role) ? (access.role as 'owner' | 'admin') : null;
  return { isAdmin: Boolean(role), role };
}
