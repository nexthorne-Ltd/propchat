'use client';

import React, { useState } from 'react';
import {
  Mail,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Send,
  Sparkles,
  Eye,
  EyeOff,
  ShieldCheck,
  Clock,
  ExternalLink,
  Check,
  Trash2,
} from 'lucide-react';
import { SMTPSettingsConfig, Workspace } from '@/types/database';
import { removeSMTPSettingsAction, updateSMTPSettingsAction } from '@/app/actions/admin';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

/** Whether a password is saved; the password itself stays on the server. */
function smtpHasPassword(smtp: unknown): boolean {
  const s = smtp as { pass?: string; has_pass?: boolean } | null;
  return Boolean(s?.has_pass || s?.pass);
}

interface SMTPSettingsSectionProps {
  workspace: Workspace;
  onWorkspaceUpdated?: (updated: Workspace) => void;
}

const isValidEmail = (email: string | undefined | null) => {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
};

export function SMTPSettingsSection({
  workspace,
  onWorkspaceUpdated,
}: SMTPSettingsSectionProps) {
  const rawSmtp = (workspace.smtp_settings as SMTPSettingsConfig | null);
  const hasSavedPassword = smtpHasPassword(rawSmtp);
  const initialSmtp: SMTPSettingsConfig = {
    enabled: rawSmtp?.enabled ?? true,
    host: rawSmtp?.host || 'smtp.hostinger.com',
    port: rawSmtp?.port || 465,
    secure: rawSmtp?.secure ?? true,
    user: rawSmtp?.user || '',
    // Never sent to the browser any more; empty here means "keep the saved one".
    pass: '',
    from_email: (rawSmtp?.from_email && isValidEmail(rawSmtp.from_email))
      ? rawSmtp.from_email
      : (rawSmtp?.user || ''),
    from_name: rawSmtp?.from_name || workspace.name || 'Support Desk',
    unread_threshold_minutes: rawSmtp?.unread_threshold_minutes || 5,
  };

  const [smtp, setSmtp] = useState<SMTPSettingsConfig>(initialSmtp);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [checkingCron, setCheckingCron] = useState(false);
  const [testEmailTo, setTestEmailTo] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Something is saved (as opposed to the empty form a new workspace sees).
  const [isConnected, setIsConnected] = useState(Boolean(rawSmtp?.host && rawSmtp?.user));
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  const applyPreset = (presetId: 'hostinger' | 'gmail' | 'outlook' | 'zoho' | 'custom') => {
    switch (presetId) {
      case 'hostinger':
        setSmtp((prev) => ({
          ...prev,
          host: 'smtp.hostinger.com',
          port: 465,
          secure: true,
          from_email: isValidEmail(prev.from_email) ? prev.from_email : (prev.user || ''),
          from_name: prev.from_name || workspace.name || 'Support Desk',
        }));
        setStatusMessage({
          type: 'info',
          text: 'Hostinger SMTP defaults applied (smtp.hostinger.com:465 SSL).',
        });
        break;
      case 'gmail':
        setSmtp((prev) => ({
          ...prev,
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          from_email: isValidEmail(prev.from_email) ? prev.from_email : (prev.user || ''),
          from_name: prev.from_name || workspace.name || 'Support Desk',
        }));
        setStatusMessage({
          type: 'info',
          text: 'Gmail SMTP defaults applied (smtp.gmail.com:465 SSL). Note: Generate an App Password in your Google Account security settings.',
        });
        break;
      case 'outlook':
        setSmtp((prev) => ({
          ...prev,
          host: 'smtp.office365.com',
          port: 587,
          secure: false,
          from_email: isValidEmail(prev.from_email) ? prev.from_email : (prev.user || ''),
          from_name: prev.from_name || workspace.name || 'Support Desk',
        }));
        setStatusMessage({
          type: 'info',
          text: 'Outlook / Microsoft 365 defaults applied (smtp.office365.com:587 STARTTLS).',
        });
        break;
      case 'zoho':
        setSmtp((prev) => ({
          ...prev,
          host: 'smtp.zoho.com',
          port: 465,
          secure: true,
          from_email: isValidEmail(prev.from_email) ? prev.from_email : (prev.user || ''),
          from_name: prev.from_name || workspace.name || 'Support Desk',
        }));
        setStatusMessage({
          type: 'info',
          text: 'Zoho Mail defaults applied (smtp.zoho.com:465 SSL).',
        });
        break;
      case 'custom':
        setStatusMessage({
          type: 'info',
          text: 'Custom SMTP mode selected. Enter your host, port, username, and password below.',
        });
        break;
    }
  };

  const handleTestConnection = async (withTestEmail: boolean = false) => {
    setTesting(true);
    setStatusMessage(null);
    try {
      const effectiveFrom = (smtp.from_email && isValidEmail(smtp.from_email))
        ? smtp.from_email.trim()
        : smtp.user.trim();

      const normalizedConfig: SMTPSettingsConfig = {
        ...smtp,
        host: (smtp.host || 'smtp.hostinger.com').trim(),
        port: Number(smtp.port) || 465,
        user: smtp.user.trim(),
        pass: smtp.pass,
        from_name: (smtp.from_name || workspace.name || 'Support Desk').trim(),
        from_email: effectiveFrom,
        secure: Number(smtp.port) === 465,
        unread_threshold_minutes: Number(smtp.unread_threshold_minutes) || 5,
      };

      // Auto-correct on screen if invalid text was present
      if (smtp.from_email !== effectiveFrom) {
        setSmtp(normalizedConfig);
      }

      if (!normalizedConfig.host || !normalizedConfig.port || !normalizedConfig.user || (!normalizedConfig.pass && !hasSavedPassword)) {
        setStatusMessage({
          type: 'error',
          text: 'Please fill in Host, Port, Username and Password before testing.',
        });
        setTesting(false);
        return;
      }

      if (!isValidEmail(normalizedConfig.user)) {
        setStatusMessage({
          type: 'error',
          text: 'Hostinger Email Address (Username) must be a valid email (e.g. helpdesk@range4ex.com).',
        });
        setTesting(false);
        return;
      }

      let recipientToSend: string | undefined = undefined;
      if (withTestEmail) {
        const targetRecipient = testEmailTo.trim();
        if (!targetRecipient || !isValidEmail(targetRecipient)) {
          setStatusMessage({
            type: 'error',
            text: 'Please enter a valid recipient email (e.g. raiusman671@gmail.com) in the test email box.',
          });
          setTesting(false);
          return;
        }
        recipientToSend = targetRecipient;
      }

      const res = await fetch('/api/workspace/smtp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: normalizedConfig,
          sendTestTo: recipientToSend,
          workspace_id: workspace.id,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setStatusMessage({
          type: 'error',
          text: data.error || 'Connection failed. Please verify your Hostinger email & password.',
        });
      } else {
        setStatusMessage({
          type: 'success',
          text: data.message || 'Hostinger SMTP connection verified successfully!',
        });
      }
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: errorMessage(err, 'Failed to connect to SMTP server.'),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await removeSMTPSettingsAction(workspace.id);
      setSmtp({
        enabled: true,
        host: 'smtp.hostinger.com',
        port: 465,
        secure: true,
        user: '',
        pass: '',
        from_email: '',
        from_name: workspace.name || 'Support Desk',
        unread_threshold_minutes: 5,
      });
      setIsConnected(false);
      setConfirmRemove(false);
      setStatusMessage({ type: 'info', text: 'Email settings removed. Nothing is sent from this workspace until you set up a mail server again.' });
      if (res.workspace) onWorkspaceUpdated?.(res.workspace);
    } catch (err) {
      setStatusMessage({ type: 'error', text: errorMessage(err) || 'Could not remove the email settings.' });
      setConfirmRemove(false);
    } finally {
      setRemoving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setStatusMessage(null);
    try {
      const effectiveFrom = (smtp.from_email && isValidEmail(smtp.from_email))
        ? smtp.from_email.trim()
        : smtp.user.trim();

      const normalizedConfig: SMTPSettingsConfig = {
        ...smtp,
        host: (smtp.host || 'smtp.hostinger.com').trim(),
        port: Number(smtp.port) || 465,
        user: smtp.user.trim(),
        pass: smtp.pass,
        from_name: (smtp.from_name || workspace.name || 'Support Desk').trim(),
        from_email: effectiveFrom,
        secure: Number(smtp.port) === 465,
        unread_threshold_minutes: Number(smtp.unread_threshold_minutes) || 5,
      };

      setSmtp(normalizedConfig);

      if (!normalizedConfig.host || !normalizedConfig.user || (!normalizedConfig.pass && !hasSavedPassword)) {
        setStatusMessage({
          type: 'error',
          text: 'Please fill in Host, Username and Password before saving.',
        });
        setSaving(false);
        return;
      }

      const res = await updateSMTPSettingsAction(workspace.id, normalizedConfig);
      if (res.workspace) {
        setIsConnected(true);
        onWorkspaceUpdated?.(res.workspace);
        setStatusMessage({
          type: 'success',
          text: '✓ Hostinger SMTP settings and 5-minute automated email notifications saved and active!',
        });
      }
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: errorMessage(err, 'Failed to save SMTP settings.'),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTriggerCronCheck = async () => {
    setCheckingCron(true);
    try {
      const res = await fetch(`/api/cron/unread-notifications?workspace_id=${workspace.id}`, { method: 'POST' });
      const data = await res.json();
      if (data.sentEmails > 0) {
        setStatusMessage({
          type: 'success',
          text: `Check complete! Sent ${data.sentEmails} unread email alert(s).`,
        });
      } else {
        setStatusMessage({
          type: 'info',
          text: `Check complete: No unread messages older than 5 minutes needed an email alert right now.`,
        });
      }
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: errorMessage(err, 'Cron check failed.'),
      });
    } finally {
      setCheckingCron(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="card bg-surface p-6 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-accent text-white p-3 shadow-sm">
              <Mail className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-ink">
                  {workspace.name} Email (SMTP) Integration
                </h3>
                <span className="px-2 py-0.5 rounded-md text-2xs font-bold bg-surface-2 border border-line text-ink-2">
                  Company workspace
                </span>
              </div>
              <p className="text-ui text-ink-2 mt-0.5 leading-relaxed">
                Configure custom email credentials specifically for <strong>{workspace.name}</strong>. When a website visitor has not seen an agent reply for 5 minutes, an automatic email notification is sent from this company&apos;s address.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => applyPreset('hostinger')}
            className="btn btn-sm btn-secondary font-bold text-xs gap-1.5 hover:border-line-3 text-accent shrink-0 shadow-xs"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Auto-fill Hostinger settings
          </button>
        </div>

        {/* Preset Selector */}
        <div className="pt-2 border-t border-line/60 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider mr-1">
            Presets:
          </span>
          <button
            type="button"
            onClick={() => applyPreset('hostinger')}
            className={cn(
              "px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all",
              smtp.host === 'smtp.hostinger.com'
                ? "bg-accent/10 border-accent/40 text-accent font-bold shadow-2xs"
                : "bg-surface-2 border-line text-ink-2 hover:text-ink hover:bg-surface-3"
            )}
          >
            Hostinger
          </button>
          <button
            type="button"
            onClick={() => applyPreset('gmail')}
            className={cn(
              "px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all",
              smtp.host === 'smtp.gmail.com'
                ? "bg-accent/10 border-accent/40 text-accent font-bold shadow-2xs"
                : "bg-surface-2 border-line text-ink-2 hover:text-ink hover:bg-surface-3"
            )}
          >
            Gmail
          </button>
          <button
            type="button"
            onClick={() => applyPreset('outlook')}
            className={cn(
              "px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all",
              smtp.host === 'smtp.office365.com'
                ? "bg-accent/10 border-accent/40 text-accent font-bold shadow-2xs"
                : "bg-surface-2 border-line text-ink-2 hover:text-ink hover:bg-surface-3"
            )}
          >
            Outlook / Office 365
          </button>
          <button
            type="button"
            onClick={() => applyPreset('zoho')}
            className={cn(
              "px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all",
              smtp.host === 'smtp.zoho.com'
                ? "bg-accent/10 border-accent/40 text-accent font-bold shadow-2xs"
                : "bg-surface-2 border-line text-ink-2 hover:text-ink hover:bg-surface-3"
            )}
          >
            Zoho Mail
          </button>
          <button
            type="button"
            onClick={() => applyPreset('custom')}
            className={cn(
              "px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all",
              !['smtp.hostinger.com', 'smtp.gmail.com', 'smtp.office365.com', 'smtp.zoho.com'].includes(smtp.host)
                ? "bg-accent/10 border-accent/40 text-accent font-bold shadow-2xs"
                : "bg-surface-2 border-line text-ink-2 hover:text-ink hover:bg-surface-3"
            )}
          >
            Custom SMTP
          </button>
        </div>
      </div>

      {/* Main Form */}
      <div className="card bg-surface p-6 shadow-xs space-y-6">
        {/* Toggle 5-min alert */}
        <div className="flex items-center justify-between p-4.5 panel">
          <div className="space-y-0.5 pr-4">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-accent" />
              <label htmlFor="smtp-enabled-toggle" className="text-sm font-bold text-ink cursor-pointer">
                Automated 5-Minute Unread Email Notifications
              </label>
            </div>
            <p className="text-xs text-ink-2 leading-relaxed">
              If a customer leaves the site or doesn&apos;t read an agent&apos;s reply within 5 minutes, email them the reply automatically with a direct link to the conversation.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              id="smtp-enabled-toggle"
              type="checkbox"
              checked={smtp.enabled}
              onChange={(e) => setSmtp({ ...smtp, enabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-12 h-6.5 bg-line-2 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-5.5 after:w-5.5 after:transition-all peer-checked:bg-accent shadow-xs"></div>
          </label>
        </div>

        {/* Credentials Form */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-ui font-bold text-ink mb-1.5">
              SMTP Host Server <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={smtp.host}
              onChange={(e) => setSmtp({ ...smtp, host: e.target.value })}
              placeholder="smtp.hostinger.com"
              className="input text-sm font-medium focus:border-accent text-ink"
            />
            <p className="text-xs text-ink-2 mt-1">
              Hostinger: <code className="font-mono font-bold text-accent">smtp.hostinger.com</code> &bull; Gmail: <code className="font-mono font-bold text-accent">smtp.gmail.com</code>
            </p>
          </div>

          <div>
            <label className="block text-ui font-bold text-ink mb-1.5">
              SMTP port &amp; encryption
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                value={smtp.port}
                onChange={(e) => {
                  const portNum = parseInt(e.target.value, 10) || 465;
                  setSmtp({
                    ...smtp,
                    port: portNum,
                    secure: portNum === 465,
                  });
                }}
                placeholder="465"
                className="input w-28 text-sm font-mono font-bold focus:border-accent text-ink"
              />
              <select
                value={smtp.port === 465 ? '465' : '587'}
                onChange={(e) => {
                  const portNum = parseInt(e.target.value, 10);
                  setSmtp({
                    ...smtp,
                    port: portNum,
                    secure: portNum === 465,
                  });
                }}
                className="input flex-1 text-sm font-semibold focus:border-accent text-ink"
              >
                <option value="465">Port 465 (SSL - Recommended)</option>
                <option value="587">Port 587 (TLS / STARTTLS)</option>
              </select>
            </div>
            <p className="text-xs text-ink-2 mt-1">
              Use Port 465 for SSL or Port 587 for TLS / STARTTLS
            </p>
          </div>

          <div>
            <label className="block text-ui font-bold text-ink mb-1.5">
              SMTP Email Address (Username) <span className="text-danger">*</span>
            </label>
            <input
              type="email"
              value={smtp.user}
              onChange={(e) => {
                const val = e.target.value;
                setSmtp((prev) => ({
                  ...prev,
                  user: val,
                  from_email: (!prev.from_email || prev.from_email === prev.user || !isValidEmail(prev.from_email))
                    ? val
                    : prev.from_email,
                }));
              }}
              placeholder="support@company.com"
              className="input text-sm font-medium focus:border-accent text-ink"
            />
            <p className="text-xs text-ink-2 mt-1">
              Your primary authenticated mailbox address
            </p>
          </div>

          <div>
            <label className="block text-ui font-bold text-ink mb-1.5">
              Email Password <span className="text-danger">*</span>
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={smtp.pass}
                onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })}
                placeholder={hasSavedPassword ? 'Saved. Leave empty to keep it' : '••••••••••••••••'}
                className="input text-sm font-medium pr-10 focus:border-accent text-ink"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-2 hover:text-ink p-1"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-ui font-bold text-ink">
                Sender Email (&quot;From&quot; Address)
              </label>
              {smtp.user && smtp.from_email !== smtp.user && (
                <button
                  type="button"
                  onClick={() => setSmtp((prev) => ({ ...prev, from_email: prev.user.trim() }))}
                  className="text-xs font-bold text-accent hover:underline"
                >
                  Use Hostinger email
                </button>
              )}
            </div>
            <input
              type="email"
              value={smtp.from_email}
              onChange={(e) => setSmtp({ ...smtp, from_email: e.target.value })}
              onBlur={() => {
                if (smtp.from_email && !isValidEmail(smtp.from_email)) {
                  if (smtp.user && isValidEmail(smtp.user)) {
                    setSmtp((prev) => ({ ...prev, from_email: prev.user.trim() }));
                  }
                }
              }}
              placeholder={smtp.user || 'helpdesk@range4ex.com'}
              className={`input text-sm font-medium ${
                smtp.from_email && !isValidEmail(smtp.from_email)
                  ? 'border-danger focus:border-danger'
                  : 'border-line-2 focus:border-accent text-ink'
              }`}
            />
            {smtp.from_email && !isValidEmail(smtp.from_email) ? (
              <p className="text-xs text-danger font-semibold mt-1 flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                Must be a valid email (e.g. {smtp.user || 'helpdesk@range4ex.com'}).
              </p>
            ) : (
              <p className="text-xs text-ink-2 mt-1">
                Must match your Hostinger mailbox address
              </p>
            )}
          </div>

          <div>
            <label className="block text-ui font-bold text-ink mb-1.5">
              Sender name
            </label>
            <input
              type="text"
              value={smtp.from_name}
              onChange={(e) => setSmtp({ ...smtp, from_name: e.target.value })}
              placeholder={workspace.name || 'Range HELP Desk'}
              className="input text-sm font-semibold focus:border-accent text-ink"
            />
          </div>
        </div>

        {/* Status Alerts */}
        {statusMessage && (
          <div
            className={`p-4 rounded-md text-sm font-medium flex items-start gap-3 border ${
              statusMessage.type === 'success'
                ? 'bg-success/10 text-success border-success/30'
                : statusMessage.type === 'error'
                ? 'bg-danger/10 text-danger border-danger/30'
                : 'bg-accent/10 text-accent border-accent/30'
            }`}
          >
            {statusMessage.type === 'success' && <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />}
            {statusMessage.type === 'error' && <AlertCircle className="h-5 w-5 shrink-0 text-danger" />}
            {statusMessage.type === 'info' && <ShieldCheck className="h-5 w-5 shrink-0 text-accent" />}
            <div className="flex-1 whitespace-pre-wrap">{statusMessage.text}</div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="pt-4 border-t-2 border-line-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={testing}
              onClick={() => handleTestConnection(false)}
              className="btn btn-sm btn-secondary font-bold text-xs gap-1.5 hover:border-line-3"
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5 text-accent" />}
              Test connection
            </button>

            <div className="flex items-center gap-1.5">
              <input
                type="email"
                placeholder="test@example.com"
                value={testEmailTo}
                onChange={(e) => setTestEmailTo(e.target.value)}
                className="input w-48 text-xs font-medium py-1.5 h-8"
              />
              <button
                type="button"
                disabled={testing}
                onClick={() => handleTestConnection(true)}
                className="btn btn-sm btn-accent font-bold text-xs gap-1.5 shadow-xs"
              >
                <Send className="h-3 w-3" />
                Send test email
              </button>
            </div>

            <button
              type="button"
              disabled={checkingCron}
              onClick={handleTriggerCronCheck}
              title="Manually trigger the 5-minute unread check"
              className="btn btn-sm btn-ghost font-semibold text-xs text-ink-2 hover:text-ink gap-1.5"
            >
              {checkingCron ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
              Run 5m Unread Check
            </button>
          </div>

          <div className="flex items-center gap-2">
            {isConnected && (
              <button
                type="button"
                disabled={saving || removing}
                onClick={() => setConfirmRemove(true)}
                className="btn btn-sm btn-ghost text-danger font-semibold text-xs gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              className="btn btn-sm btn-primary font-bold text-sm px-5 py-2 shadow-sm gap-2"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Save settings
            </button>
          </div>
        </div>

        <Modal
          open={confirmRemove}
          size="sm"
          title="Remove email settings?"
          description={`${rawSmtp?.user || 'This mailbox'} will be disconnected and its saved password deleted.`}
          onClose={() => (removing ? undefined : setConfirmRemove(false))}
          footer={
            <>
              <Button variant="ghost" size="sm" disabled={removing} onClick={() => setConfirmRemove(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" loading={removing} onClick={() => void handleRemove()}>
                Remove
              </Button>
            </>
          }
        >
          <p className="text-ui text-ink-2">
            Until you add a mail server again, this workspace sends no email: no reply alerts to customers, no team
            invitation or handover emails, and ticket replies are not emailed. You can still share invitation links by hand.
          </p>
        </Modal>
      </div>
    </div>
  );
}
