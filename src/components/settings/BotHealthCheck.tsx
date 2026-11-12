'use client';

import React, { useCallback, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Activity, Send, Power } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Textarea } from '@/components/ui/Input';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/lib/errors/user-error';
import { cn } from '@/lib/utils';
import { SettingsCard } from './parts';
import {
  askBotTestQuestionAction,
  resumeBotEverywhereAction,
  runBotHealthCheckAction,
  type BotHealthReport,
  type BotTestAnswer,
  type CheckStatus,
} from '@/app/actions/bot-health';

/**
 * Settings → AI bot → Health check: one button that says whether the bot
 * can reply right now and, if not, why; plus a test question run through the
 * real pipeline. Logic lives in src/app/actions/bot-health.ts.
 */

const STATUS_ICON: Record<CheckStatus, React.ReactNode> = {
  ok: <CheckCircle2 className="w-4 h-4 text-success" aria-hidden="true" />,
  warn: <AlertTriangle className="w-4 h-4 text-warn" aria-hidden="true" />,
  fail: <XCircle className="w-4 h-4 text-danger" aria-hidden="true" />,
};

const OVERALL: Record<CheckStatus, { tone: 'success' | 'warn' | 'danger'; text: string }> = {
  ok: { tone: 'success', text: 'The bot can reply' },
  warn: { tone: 'warn', text: 'The bot works, with warnings' },
  fail: { tone: 'danger', text: 'The bot cannot reply' },
};

function time(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function BotHealthCheck({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [report, setReport] = useState<BotHealthReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<BotTestAnswer | null>(null);
  const [resuming, setResuming] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      setReport(await runBotHealthCheckAction(workspaceId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }, [workspaceId]);

  const ask = async () => {
    setAsking(true);
    setAnswer(null);
    try {
      setAnswer(await askBotTestQuestionAction(workspaceId, question));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAsking(false);
    }
  };

  const resume = async () => {
    setResuming(true);
    try {
      const { resumed } = await resumeBotEverywhereAction(workspaceId);
      toast.success(resumed ? `Bot turned back on in ${resumed} conversation(s).` : 'No conversation needed it.');
      await run();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setResuming(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Is the bot replying?"
        description="Runs every check the bot goes through before it answers a visitor, makes one real call to the AI model, and shows why recent messages were or were not answered."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={run} loading={running}>
            <Activity className="w-4 h-4" aria-hidden="true" /> {report ? 'Run again' : 'Run health check'}
          </Button>
          {report && (
            <>
              <Badge tone={OVERALL[report.overall].tone}>{OVERALL[report.overall].text}</Badge>
              <span className="text-xs text-ink-3">Checked {time(report.checkedAt)}</span>
            </>
          )}
        </div>

        <div className="mt-4">
          {running && !report && <LoadingState label="Checking the bot…" />}
          {error && <ErrorState title="The check could not run" message={error} onRetry={run} />}
          {!running && !error && !report && (
            <EmptyState title="Not checked yet" description="Press Run health check. It takes a few seconds." />
          )}

          {report && (
            <ul className="divide-y divide-line border border-line rounded-lg">
              {report.checks.map((c) => (
                <li key={c.id} className="flex gap-3 p-3">
                  <span className="mt-0.5 shrink-0">{STATUS_ICON[c.status]}</span>
                  <div className="min-w-0">
                    <p className="text-ui font-medium text-ink">{c.label}</p>
                    <p className="text-ui text-ink-2 break-words">{c.detail}</p>
                    {c.fix && <p className="mt-1 text-xs text-ink-3">How to fix: {c.fix}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {report && report.botOffConversations > 0 && (
            <div className="mt-3">
              <Button onClick={resume} loading={resuming}>
                <Power className="w-4 h-4" aria-hidden="true" /> Turn the bot back on ({report.botOffConversations})
              </Button>
            </div>
          )}
        </div>
      </SettingsCard>

      {report && (
        <SettingsCard title="Last bot decisions" description="The newest first, from the last 24 hours.">
          {report.recent.length === 0 ? (
            <EmptyState title="Nothing in the last 24 hours" description="Send a message from your widget, then run the check again." />
          ) : (
            <ul className="divide-y divide-line border border-line rounded-lg">
              {report.recent.map((r, i) => (
                <li key={`${r.at}-${i}`} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 p-3">
                  <span className="text-xs text-ink-3 shrink-0 sm:w-32">{time(r.at)}</span>
                  <span
                    className={cn(
                      'text-ui break-words',
                      r.event === 'reply_delivered' ? 'text-ink' : r.event.endsWith('error') ? 'text-danger' : 'text-ink-2'
                    )}
                  >
                    {r.explained}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>
      )}

      <SettingsCard
        title="Ask the bot a test question"
        description="Uses the same help center, instructions and model a visitor gets. Nothing is saved to any chat."
      >
        <Field label="Question">
          <Textarea
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. How do payouts work?"
            maxLength={1000}
          />
        </Field>
        <div className="mt-3">
          <Button variant="primary" onClick={ask} loading={asking} disabled={!question.trim()}>
            <Send className="w-4 h-4" aria-hidden="true" /> Ask the bot
          </Button>
        </div>

        {asking && <div className="mt-4"><LoadingState label="The bot is writing…" /></div>}
        {answer && (
          <div className="mt-4 space-y-2">
            {answer.error ? (
              <ErrorState title="The bot failed" message={answer.error} onRetry={ask} />
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={answer.handedOver ? 'warn' : 'success'}>
                    {answer.handedOver ? 'Would hand over to the team' : 'Would reply'}
                  </Badge>
                  {answer.subAgent && <Badge tone="neutral">{answer.subAgent}</Badge>}
                  {answer.intent && <Badge tone="info">{answer.intent}</Badge>}
                  <Badge tone="neutral">{(answer.ms / 1000).toFixed(1)} s</Badge>
                </div>
                <div className="rounded-lg border border-line bg-surface-2 p-3 text-ui text-ink whitespace-pre-wrap break-words">
                  {answer.replyText || 'No reply text.'}
                </div>
                {answer.handedOver && answer.handoverReason && (
                  <p className="text-xs text-ink-3">Why: {answer.handoverReason}</p>
                )}
              </>
            )}
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
