'use client';

import React, { useState } from 'react';
import { ThumbsUp, ThumbsDown, MessageSquare, Mail, Sparkles, HelpCircle } from 'lucide-react';
import type { Workspace, CsatSettingsConfig } from '@/types/database';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { SaveBar, SettingsCard, useReportDirty } from './parts';
import { updateCsatSettingsAction } from '@/app/actions/settings';
import { errorMessage } from '@/lib/errors/user-error';

const DEFAULT_CSAT: CsatSettingsConfig = {
  enabled: true,
  ask_chat: true,
  ask_email: true,
  survey_prompt: 'How would you rate the support you received?',
};

interface CsatSettingsCardProps {
  workspace: Workspace;
  onWorkspaceUpdated?: (ws: Workspace) => void;
}

export function CsatSettingsCard({ workspace, onWorkspaceUpdated }: CsatSettingsCardProps) {
  const toast = useToast();
  const initial = workspace.csat_settings ?? DEFAULT_CSAT;

  const [enabled, setEnabled] = useState(initial.enabled ?? true);
  const [askChat, setAskChat] = useState(initial.ask_chat ?? true);
  const [askEmail, setAskEmail] = useState(initial.ask_email ?? true);
  const [prompt, setPrompt] = useState(initial.survey_prompt || DEFAULT_CSAT.survey_prompt || '');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preview mock state
  const [previewRating, setPreviewRating] = useState<'good' | 'bad' | null>(null);
  const [previewComment, setPreviewComment] = useState('');

  const dirty =
    enabled !== (initial.enabled ?? true) ||
    askChat !== (initial.ask_chat ?? true) ||
    askEmail !== (initial.ask_email ?? true) ||
    prompt.trim() !== (initial.survey_prompt || DEFAULT_CSAT.survey_prompt || '').trim();

  useReportDirty(dirty);

  const handleDiscard = () => {
    setEnabled(initial.enabled ?? true);
    setAskChat(initial.ask_chat ?? true);
    setAskEmail(initial.ask_email ?? true);
    setPrompt(initial.survey_prompt || DEFAULT_CSAT.survey_prompt || '');
    setError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: CsatSettingsConfig = {
        enabled,
        ask_chat: askChat,
        ask_email: askEmail,
        survey_prompt: prompt.trim() || DEFAULT_CSAT.survey_prompt,
      };

      const res = await updateCsatSettingsAction(workspace.id, payload);
      if (!res.success) {
        setError(res.error || 'Failed to save CSAT settings.');
        toast.error(res.error || 'Failed to save CSAT settings.');
        return;
      }

      setJustSaved(true);
      toast.success('CSAT settings updated.');
      if (res.workspace) {
        onWorkspaceUpdated?.(res.workspace);
      }
    } catch (e) {
      const msg = errorMessage(e) || 'An unexpected error occurred.';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Customer Satisfaction (CSAT)"
        description="Ask requesters whether they had a good or bad experience as soon as a ticket is marked solved."
      >
        <div className="space-y-6 pt-1">
          {/* Main switch */}
          <label className="flex items-start gap-3.5 p-3.5 rounded-xl border border-line bg-surface/50 hover:bg-surface transition-colors cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-0.5 w-5 h-5 accent-[var(--ds-accent)] rounded cursor-pointer shrink-0"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setJustSaved(false);
              }}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-ui font-semibold text-ink">Collect customer satisfaction ratings</span>
                <Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'Active' : 'Disabled'}</Badge>
              </div>
              <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                When enabled, customers can rate their experience as Good or Bad and provide optional feedback.
              </p>
            </div>
          </label>

          {/* Delivery Channels */}
          <div className={`space-y-4 transition-opacity ${enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Survey Channels</h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex items-start gap-3 p-3.5 rounded-xl border border-line bg-surface/50 hover:bg-surface cursor-pointer select-none">
                <input
                  type="checkbox"
                  disabled={!enabled}
                  className="mt-0.5 w-4 h-4 accent-[var(--ds-accent)] rounded cursor-pointer shrink-0"
                  checked={askChat}
                  onChange={(e) => {
                    setAskChat(e.target.checked);
                    setJustSaved(false);
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-ui font-medium text-ink">
                    <MessageSquare className="w-4 h-4 text-accent" />
                    <span>Chat widget</span>
                  </div>
                  <p className="text-2xs text-ink-3 mt-1 leading-normal">
                    Displays survey card inline in the chat widget when a chat conversation is closed.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 p-3.5 rounded-xl border border-line bg-surface/50 hover:bg-surface cursor-pointer select-none">
                <input
                  type="checkbox"
                  disabled={!enabled}
                  className="mt-0.5 w-4 h-4 accent-[var(--ds-accent)] rounded cursor-pointer shrink-0"
                  checked={askEmail}
                  onChange={(e) => {
                    setAskEmail(e.target.checked);
                    setJustSaved(false);
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-ui font-medium text-ink">
                    <Mail className="w-4 h-4 text-accent" />
                    <span>Email & other tickets</span>
                  </div>
                  <p className="text-2xs text-ink-3 mt-1 leading-normal">
                    Includes one-click Good / Bad survey links in the ticket solved notification email.
                  </p>
                </div>
              </label>
            </div>

            {/* Survey Prompt */}
            <div className="pt-2">
              <Field
                label="Survey Prompt"
                hint="The question shown to customers above the Good and Bad rating options."
              >
                <Input
                  disabled={!enabled}
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setJustSaved(false);
                  }}
                  placeholder="How would you rate the support you received?"
                  className="max-w-xl"
                />
              </Field>
            </div>
          </div>
        </div>
      </SettingsCard>

      {/* Live Preview Card */}
      <SettingsCard
        title="Customer Survey Preview"
        description="This is how the survey card appears to your customers when their ticket is resolved."
      >
        <div className="p-4 sm:p-6 rounded-xl border border-line bg-canvas/60 max-w-lg mx-auto">
          <div className="text-center space-y-4">
            <div className="w-10 h-10 rounded-full bg-accent/10 text-accent flex items-center justify-center mx-auto">
              <Sparkles className="w-5 h-5" />
            </div>

            <div>
              <p className="text-sm font-medium text-ink">
                {prompt.trim() || 'How would you rate the support you received?'}
              </p>
              <p className="text-2xs text-ink-3 mt-0.5">Please let us know how we did on this ticket</p>
            </div>

            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setPreviewRating('good')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-xs font-semibold transition-all ${
                  previewRating === 'good'
                    ? 'border-success bg-success-soft text-success shadow-sm'
                    : 'border-line bg-surface text-ink hover:border-success hover:bg-surface/80'
                }`}
              >
                <ThumbsUp className="w-4 h-4 text-success" />
                <span>Good, I&apos;m satisfied</span>
              </button>

              <button
                type="button"
                onClick={() => setPreviewRating('bad')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-xs font-semibold transition-all ${
                  previewRating === 'bad'
                    ? 'border-danger bg-danger-soft text-danger shadow-sm'
                    : 'border-line bg-surface text-ink hover:border-danger hover:bg-surface/80'
                }`}
              >
                <ThumbsDown className="w-4 h-4 text-danger" />
                <span>Bad, I&apos;m unsatisfied</span>
              </button>
            </div>

            {previewRating && (
              <div className="pt-2 text-left space-y-2 animate-in fade-in duration-200">
                <label htmlFor="preview-comment-input" className="text-2xs font-medium text-ink-3">Optional comment</label>
                <textarea
                  id="preview-comment-input"
                  rows={2}
                  value={previewComment}
                  onChange={(e) => setPreviewComment(e.target.value)}
                  placeholder="Tell us what went well or what could be better…"
                  className="w-full text-xs rounded-lg border border-line bg-surface px-3 py-2 text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-[var(--ds-accent)]"
                />
                <div className="flex justify-end">
                  <Button size="sm" variant="primary" onClick={() => toast.success('Mock feedback submitted!')}>
                    Submit feedback
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </SettingsCard>

      <SaveBar
        dirty={dirty}
        saving={saving}
        saved={justSaved}
        error={error}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
    </div>
  );
}
