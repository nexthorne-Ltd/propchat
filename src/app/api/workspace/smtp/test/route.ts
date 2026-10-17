import { NextRequest, NextResponse } from 'next/server';
import { guardMember, guardWorkspace } from '@/lib/team/route-guard';
import { storedSmtpPassword } from '@/lib/email/workspace-smtp';
import { testSmtpConnection, sendSmtpEmail, isValidEmail, getEffectiveFromEmail, smtpTestEmail } from '@/lib/email/smtp';
import { SMTPSettingsConfig } from '@/types/database';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { config, sendTestTo, workspace_id } = body as {
      config: SMTPSettingsConfig;
      sendTestTo?: string;
      workspace_id?: string;
    };
    // With a workspace, an empty password means "the one already saved" (it
    // is never sent to the browser); otherwise the form must supply one.
    const guard = workspace_id ? await guardWorkspace(workspace_id, 'manage_settings') : await guardMember('manage_settings');
    if (!guard.ok) return guard.response;
    if (config && !config.pass && workspace_id) {
      config.pass = await storedSmtpPassword(String(workspace_id));
    }

    if (!config || !config.host || !config.port || !config.user || !config.pass) {
      return NextResponse.json(
        { error: 'Missing required SMTP fields (Host, Port, User, Password)' },
        { status: 400 }
      );
    }

    // Normalize config
    const normalizedConfig: SMTPSettingsConfig = {
      ...config,
      host: config.host.trim(),
      port: Number(config.port) || 465,
      user: config.user.trim(),
      pass: config.pass,
      from_name: (config.from_name || '').trim(),
      from_email: (config.from_email && isValidEmail(config.from_email))
        ? config.from_email.trim()
        : config.user.trim(),
    };

    // 1. Verify connection
    const testResult = await testSmtpConnection(normalizedConfig);
    if (!testResult.success) {
      return NextResponse.json(
        { error: testResult.message || 'Could not connect to SMTP server' },
        { status: 400 }
      );
    }

    // 2. Optionally send a real test email if an email is provided
    if (sendTestTo) {
      const recipient = sendTestTo.trim();
      if (!isValidEmail(recipient)) {
        return NextResponse.json(
          { error: `Invalid test recipient email "${recipient}". Please enter a valid recipient address (e.g. yourname@gmail.com).` },
          { status: 400 }
        );
      }

      const effectiveSender = getEffectiveFromEmail(normalizedConfig);

      const test = smtpTestEmail({
        brandName: normalizedConfig.from_name || 'Support',
        host: normalizedConfig.host,
        port: Number(normalizedConfig.port),
        from: effectiveSender,
        user: normalizedConfig.user,
      });
      const emailResult = await sendSmtpEmail(normalizedConfig, {
        to: recipient,
        subject: test.subject,
        html: test.html,
        text: test.text,
      });

      if (!emailResult.success) {
        return NextResponse.json(
          { error: emailResult.error || 'Connection passed, but failed to send test email' },
          { status: 400 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      message: sendTestTo
        ? `SMTP verified! A test email has been successfully sent to ${sendTestTo.trim()}`
        : 'Connected. The mail server accepted the login.',
    });
  } catch (error: any) {
    console.error('[SMTP Test Route Error]:', error);
    return NextResponse.json(
      { error: error.message || 'SMTP test failed' },
      { status: 500 }
    );
  }
}
