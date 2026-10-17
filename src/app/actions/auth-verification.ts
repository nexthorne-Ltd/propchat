'use server';

import { headers } from 'next/headers';
import { serviceClient } from '@/lib/supabase/service';
import { clientIpOf } from '@/lib/geo';
import { checkRateLimit } from '@/lib/rate-limit';
import { sendSmtpEmail, verificationCodeEmail, isValidEmail } from '@/lib/email/smtp';
import { SMTPSettingsConfig } from '@/types/database';
import { userError } from '@/lib/errors/user-error';
import {
  generate6DigitCode,
  timingSafeCodeCheck,
  findAuthUserByEmail,
} from '@/lib/auth/verification-code';

/**
 * Server Action: Start user registration and dispatch 6-digit OTP verification email from ZenTry
 */
export async function sendSignupVerificationCodeAction(params: {
  email: string;
  name: string;
  password?: string;
}): Promise<{ success: boolean; error?: string; email?: string; warning?: string; code?: string }> {
  try {
    const normalizedEmail = (params.email || '').trim().toLowerCase();
    const cleanName = (params.name || '').trim();

    if (!isValidEmail(normalizedEmail)) {
      return { success: false, error: 'Please enter a valid email address.' };
    }

    if (!cleanName) {
      return { success: false, error: 'Please enter your full name or company name.' };
    }

    const supabaseAdmin = serviceClient();

    // 1. Check existing account.
    // - Existing account WITH email_confirmed_at -> refuse ("already exists, sign in or reset password").
    // - Existing account WITHOUT email_confirmed_at -> do NOT create user and do NOT call updateUserById with password.
    //   Just send a new code. When it is verified, the account keeps the password it was created with.
    const existingUser = await findAuthUserByEmail(supabaseAdmin, normalizedEmail);
    if (existingUser?.email_confirmed_at) {
      throw userError('An account with this email already exists. Sign in, or use "Forgot password".');
    }

    // 2. IP rate limit: 10 verification requests an hour per IP
    let clientIp = 'unknown';
    try {
      const headerList = await headers();
      clientIp = clientIpOf(headerList) || 'unknown';
    } catch {}

    const ipAllowed = await checkRateLimit(`signup_ip:${clientIp}`, 10, 3600);
    if (!ipAllowed) {
      return {
        success: false,
        error: 'Too many verification codes requested from this IP. Please try again later.',
      };
    }

    // 3. Rate limit sending: no more than 1 code per 60 seconds and 5 per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentCodes } = await supabaseAdmin
      .from('email_verifications')
      .select('created_at, locked_until')
      .eq('email', normalizedEmail)
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false });

    const rows = recentCodes || [];

    if (rows.length > 0) {
      const mostRecentTime = new Date(rows[0].created_at).getTime();
      const elapsedSeconds = (Date.now() - mostRecentTime) / 1000;
      if (elapsedSeconds < 60) {
        const waitSec = Math.ceil(60 - elapsedSeconds);
        return {
          success: false,
          error: `Please wait ${waitSec} second${waitSec === 1 ? '' : 's'} before requesting another verification code.`,
        };
      }
    }

    if (rows.length >= 5) {
      return {
        success: false,
        error: 'Too many verification codes requested. Please try again in an hour.',
      };
    }

    // Create user unconfirmed in Supabase Auth if this is a fresh registration and password is provided.
    // If an unconfirmed user already exists, do NOT create a user and do NOT call updateUserById with a password.
    if (!existingUser && params.password) {
      const { error: createError } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        password: params.password,
        email_confirm: false,
        user_metadata: { name: cleanName },
      });

      if (createError) {
        if (/already registered|already exists/i.test(createError.message)) {
          throw userError('An account with this email already exists. Sign in, or use "Forgot password".');
        }
        console.error('[Verification] Error creating staged user:', createError);
        return { success: false, error: createError.message };
      }
    }

    // 3. Generate cryptographically sound 6-digit OTP Code
    const code = generate6DigitCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins

    // Reset wrong attempt counts and unlocks when a new code is sent
    await supabaseAdmin
      .from('email_verifications')
      .update({ attempts: 0, locked_until: null })
      .eq('email', normalizedEmail);

    // Save fresh code
    const { error: insertError } = await supabaseAdmin
      .from('email_verifications')
      .insert({
        email: normalizedEmail,
        code,
        expires_at: expiresAt,
        attempts: 0,
        locked_until: null,
      });

    if (insertError) {
      console.error('[Verification] Error storing verification code:', insertError);
      return { success: false, error: 'Failed to generate verification code. Please try again.' };
    }

    // 4. Dispatch official ZenTry verification email via Platform SMTP
    const { data: platformData } = await supabaseAdmin
      .from('platform_settings')
      .select('*')
      .eq('id', 'default')
      .maybeSingle();

    const smtpConfig = platformData?.smtp_settings as SMTPSettingsConfig | null;

    let emailSent = false;
    let sendError: string | undefined = undefined;

    if (smtpConfig && smtpConfig.user && smtpConfig.pass && smtpConfig.enabled) {
      const email = verificationCodeEmail({
        code,
        name: cleanName,
        platformName: platformData?.platform_name || 'Zen-try',
        platformUrl: platformData?.platform_url || 'https://zen-try.site',
      });

      const sendResult = await sendSmtpEmail(smtpConfig, {
        to: normalizedEmail,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: { 'Auto-Submitted': 'auto-generated' },
      });

      if (!sendResult.success) {
        console.error('[Verification] SMTP dispatch failed:', sendResult.error);
        sendError = sendResult.error || 'Failed to dispatch verification email.';
      } else {
        emailSent = true;
      }
    } else {
      console.warn('[Verification] Platform SMTP not configured yet. Code generated:', code);
      sendError = 'Platform email delivery is not configured or active.';
    }

    // Fail closed: if email cannot be sent, return an error.
    // Never return code in production (already gated by NODE_ENV).
    if (!emailSent) {
      return {
        success: false,
        error: sendError || 'Failed to dispatch verification email.',
        code: process.env.NODE_ENV !== 'production' ? code : undefined,
      };
    }

    return {
      success: true,
      email: normalizedEmail,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Verification] Unexpected error sending code:', err);
    return { success: false, error: message || 'Failed to dispatch verification email.' };
  }
}

/**
 * Server Action: Verify 6-digit OTP code entered/pasted by user
 */
export async function verifySignupCodeAction(params: {
  email: string;
  code: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const normalizedEmail = (params.email || '').trim().toLowerCase();
    const cleanCode = (params.code || '').replace(/\D/g, '').trim();

    if (!normalizedEmail) {
      return { success: false, error: 'Email address is missing.' };
    }

    if (cleanCode.length !== 6) {
      return { success: false, error: 'Please enter a valid 6-digit verification code.' };
    }

    const supabaseAdmin = serviceClient();

    // 1. Look up latest verification record for this email
    const { data: record, error: lookupError } = await supabaseAdmin
      .from('email_verifications')
      .select('*')
      .eq('email', normalizedEmail)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lookupError || !record) {
      return {
        success: false,
        error: 'Invalid or expired verification code. Please check your email or request a new one.',
      };
    }

    // 2. Check if locked out due to too many failed attempts (5 wrong tries locks for 15 minutes)
    if (record.locked_until && new Date(record.locked_until).getTime() > Date.now()) {
      return {
        success: false,
        error: 'Too many wrong attempts. This email is locked for 15 minutes.',
      };
    }

    // 3. Timing-safe comparison and expiration check
    const isExpired = new Date(record.expires_at).getTime() <= Date.now();
    const isValid = !isExpired && timingSafeCodeCheck(cleanCode, record.code);

    if (!isValid) {
      const newAttempts = (record.attempts || 0) + 1;
      const shouldLock = newAttempts >= 5;
      const lockTimestamp = shouldLock
        ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
        : null;

      await supabaseAdmin
        .from('email_verifications')
        .update({
          attempts: newAttempts,
          locked_until: lockTimestamp,
        })
        .eq('id', record.id);

      if (shouldLock) {
        return {
          success: false,
          error: 'Too many wrong attempts. This email is locked for 15 minutes.',
        };
      }

      return {
        success: false,
        error: 'Invalid or expired verification code. Please check your email or request a new one.',
      };
    }

    // 4. Code is valid! Delete verification records for this email
    await supabaseAdmin
      .from('email_verifications')
      .delete()
      .eq('email', normalizedEmail);

    // 5. Mark user confirmed in Supabase Auth
    const targetUser = await findAuthUserByEmail(supabaseAdmin, normalizedEmail);

    if (targetUser) {
      const { error: confirmError } = await supabaseAdmin.auth.admin.updateUserById(
        targetUser.id,
        { email_confirm: true }
      );

      if (confirmError) {
        console.error('[Verification] Error confirming user email:', confirmError);
        return { success: false, error: 'Failed to activate user account. Please try again.' };
      }
    }

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Verification] Error verifying code:', err);
    return { success: false, error: message || 'Verification failed.' };
  }
}

/**
 * Server Action: Resend fresh 6-digit OTP code to user
 */
export async function resendSignupVerificationCodeAction(params: {
  email: string;
  name?: string;
}): Promise<{ success: boolean; error?: string; email?: string; warning?: string; code?: string }> {
  return sendSignupVerificationCodeAction({
    email: params.email,
    name: params.name || 'Business Owner',
  });
}
