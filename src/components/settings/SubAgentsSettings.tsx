'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  BadgeCheck,
  Bot,
  ChevronDown,
  CircleHelp,
  Cpu,
  FlaskConical,
  Hand,
  Headset,
  IdCard,
  MessageSquare,
  Monitor,
  Receipt,
  RotateCcw,
  Route,
  ShieldCheck,
  Tag,
  Ticket,
  TrendingUp,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';
import {
  routeSubAgent,
  SUB_AGENT_BY_ID,
  SUB_AGENT_INSTRUCTIONS_MAX,
  SUB_AGENTS,
  subAgentEnabled,
  type SubAgentDefinition,
  type SubAgentEngine,
  type SubAgentId,
} from '@/lib/ai/sub-agents';
import {
  getSubAgentConfigAction,
  saveSubAgentConfigAction,
  type SubAgentConfig,
  type SubAgentStats,
} from '@/app/actions/sub-agents';
import { SaveBar, SettingsCard, useReportDirty } from './parts';

/**
 * Settings → AI bot → Sub-agents. Shows the prop-firm specialists of agent
 * mode, how a message flows through the router to one of them, and lets an
 * admin switch a specialist off (its topic then goes to the team) or give it
 * extra instructions. The router tester runs the same router as the bot.
 */

const ICONS: Record<SubAgentDefinition['icon'], React.ComponentType<{ className?: string }>> = {
  hand: Hand,
  tag: Tag,
  shield: ShieldCheck,
  wallet: Wallet,
  user: UserRound,
  monitor: Monitor,
  'id-card': IdCard,
  users: Users,
  help: CircleHelp,
  headset: Headset,
  cpu: Cpu,
  activity: Activity,
  'badge-check': BadgeCheck,
  ticket: Ticket,
  receipt: Receipt,
  'trending-up': TrendingUp,
  'rotate-ccw': RotateCcw,
};

const ENGINE: Record<SubAgentEngine, { label: string; tone: BadgeTone }> = {
  template: { label: 'Instant reply', tone: 'info' },
  model: { label: 'AI specialist', tone: 'accent' },
  team: { label: 'Your team', tone: 'warn' },
};

// The live bot asks the intent classifier first; these two cover what it
// decides before the router, so the tester matches what traders will see.
const TESTER_SMALL_TALK =
  /^(hi+|hello+|hey+|salam|salaam|aoa|assalam\w*(?:\s*(?:o|u)?\s*alaik\w*)?|good\s+(?:morning|afternoon|evening)|thanks?|thank\s+you|shukriya|ok|okay|bye|allah\s+hafiz|aap\s+kaun\s+ho|who\s+are\s+you|what\s+can\s+you\s+do)[\s!.?]*$/i;
const TESTER_HUMAN =
  /\b(human|real\s+person|representative|(?:talk|speak)\s+(?:to|with)\s+(?:someone|a\s+person|an\s+agent|support)|connect\s+me|insaan|insan|(?:agent|team|banday?)\s+se\s+baat|baat\s+karwa\w*)\b/i;

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60 disabled:cursor-not-allowed',
        checked ? 'bg-accent border-accent' : 'bg-surface-3 border-line'
      )}
    >
      <span className={cn('inline-block h-4 w-4 rounded-full bg-surface shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

function AgentIcon({ def, className }: { def: SubAgentDefinition; className?: string }) {
  const Icon = ICONS[def.icon];
  return (
    <span className={cn('w-9 h-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0', className)}>
      <Icon className="w-4 h-4" aria-hidden="true" />
    </span>
  );
}

function FlowStep({ icon: Icon, title, body }: { icon: React.ComponentType<{ className?: string }>; title: string; body: string }) {
  return (
    <div className="flex-1 min-w-0 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-accent shrink-0" aria-hidden="true" />
        <span className="text-ui font-semibold text-ink">{title}</span>
      </div>
      <p className="mt-1 text-xs text-ink-2">{body}</p>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex items-center justify-center text-ink-3 shrink-0" aria-hidden="true">
      <ArrowRight className="w-4 h-4 hidden md:block" />
      <ArrowDown className="w-4 h-4 md:hidden" />
    </div>
  );
}

/** Trader message → Router → one specialist → answer or the team. */
function FlowDiagram({ config }: { config: SubAgentConfig }) {
  const specialists = SUB_AGENTS.filter((a) => a.engine === 'model');
  const Step = FlowStep;
  const Arrow = FlowArrow;
  return (
    <div className="space-y-3">
      <div className="flex flex-col md:flex-row gap-2 md:items-stretch">
        <Step icon={MessageSquare} title="1. Trader writes" body="Any language: English, Roman Urdu, typos, short forms." />
        <Arrow />
        <Step icon={Route} title="2. Router" body="Greeting or a request for a person first, then the topic of the message (or of the last few messages for a follow-up)." />
        <Arrow />
        <Step icon={Bot} title="3. Specialist answers" body="Its own brief, its topic's articles first, the whole help center in view." />
        <Arrow />
        <Step icon={Headset} title="4. Team only if needed" body="When a person must look up or change something, with a summary for your agent." />
      </div>
      <div className="rounded-xl border border-dashed border-line p-3">
        <p className="text-2xs font-semibold uppercase tracking-wide text-ink-3">Specialists the router can pick</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {specialists.map((a) => {
            const on = subAgentEnabled(config.subAgents, a.id);
            return (
              <span key={a.id} className={cn('pill', on ? 'pill-accent' : 'pill-neutral')}>
                {a.name}
                {!on && ' (off: team)'}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RouterTester({ config }: { config: SubAgentConfig }) {
  const [message, setMessage] = useState('');
  const result = useMemo(() => {
    const text = message.trim();
    if (!text) return null;
    if (TESTER_HUMAN.test(text)) return routeSubAgent({ message: text, intent: 'wants_human', asksForHuman: true });
    if (TESTER_SMALL_TALK.test(text)) return routeSubAgent({ message: text, intent: 'small_talk' });
    return routeSubAgent({ message: text, intent: 'help_center_question' });
  }, [message]);
  const def = result ? SUB_AGENT_BY_ID[result.agent] : null;
  const off = def ? !subAgentEnabled(config.subAgents, def.id) : false;

  return (
    <div className="space-y-3">
      <Field label="Try a trader message" hint="Shows which specialist would take it. The live bot also reads the earlier messages of the chat.">
        <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. dd kitna hai 10k pe" autoComplete="off" />
      </Field>
      <div aria-live="polite">
        {def && result ? (
          <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 p-3">
            <AgentIcon def={def} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ui font-semibold text-ink">{def.name}</span>
                <Badge tone={ENGINE[def.engine].tone}>{ENGINE[def.engine].label}</Badge>
                {off && <Badge tone="warn">Off: goes to your team</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-ink-2">{result.reason}</p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-ink-3">
            Examples:{' '}
            {['10k challenge kitne ka hai?', 'can I trade news?', 'payout kab milega?', 'mt5 login kaise karun'].map((ex, i) => (
              <React.Fragment key={ex}>
                {i > 0 && ', '}
                <button type="button" className="text-accent hover:underline focus:outline-none focus-visible:underline" onClick={() => setMessage(ex)}>
                  {ex}
                </button>
              </React.Fragment>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}

function AgentCard({
  def,
  enabled,
  instructions,
  stats,
  onToggle,
  onInstructions,
}: {
  def: SubAgentDefinition;
  enabled: boolean;
  instructions: string;
  stats?: { replies: number; handovers: number };
  onToggle: (v: boolean) => void;
  onInstructions: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = `sub-agent-${def.id}-details`;
  return (
    <article className={cn('card p-4 flex flex-col gap-3', !enabled && 'opacity-75')}>
      <header className="flex items-start gap-3">
        <AgentIcon def={def} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-ui font-semibold text-ink">{def.name}</h4>
            <Badge tone={ENGINE[def.engine].tone}>{ENGINE[def.engine].label}</Badge>
            {!enabled && <Badge tone="warn">Off: team answers</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-ink-2">{def.summary}</p>
        </div>
        {def.canDisable ? (
          <Switch checked={enabled} onChange={onToggle} label={`${def.name} specialist on`} />
        ) : (
          <span className="text-2xs text-ink-3 shrink-0">Always on</span>
        )}
      </header>

      <dl className="grid grid-cols-2 gap-2 text-2xs">
        <div className="rounded-lg bg-surface-2 px-2.5 py-1.5">
          <dt className="text-ink-3">Replies (30 days)</dt>
          <dd className="text-ui font-semibold text-ink">{stats ? stats.replies : '—'}</dd>
        </div>
        <div className="rounded-lg bg-surface-2 px-2.5 py-1.5">
          <dt className="text-ink-3">Handovers (30 days)</dt>
          <dd className="text-ui font-semibold text-ink">{stats ? stats.handovers : '—'}</dd>
        </div>
      </dl>

      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 self-start text-xs font-medium text-accent hover:underline focus:outline-none focus-visible:underline"
      >
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
        {open ? 'Hide details' : 'What it does'}
      </button>

      {open && (
        <div id={detailsId} className="space-y-3">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-wide text-ink-3">Handles</p>
            <ul className="mt-1 list-disc pl-4 space-y-0.5 text-xs text-ink-2">
              {def.handles.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-2xs font-semibold uppercase tracking-wide text-ink-3">Traders ask</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {def.examples.map((e) => (
                <span key={e} className="pill pill-neutral">
                  {e}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="text-2xs font-semibold uppercase tracking-wide text-ink-3">Brings in your team when</p>
            <p className="mt-1 text-xs text-ink-2">{def.handsOverWhen}</p>
          </div>
          {def.engine === 'model' && (
            <Field
              label="Extra instructions for this specialist"
              hint={`Optional. Added to its brief, e.g. "Always mention the 10% off code for first-time buyers." ${instructions.length}/${SUB_AGENT_INSTRUCTIONS_MAX}`}
            >
              <Textarea
                rows={3}
                value={instructions}
                maxLength={SUB_AGENT_INSTRUCTIONS_MAX}
                onChange={(e) => onInstructions(e.target.value)}
                placeholder="Facts still come from your help center; use this for tone and emphasis."
              />
            </Field>
          )}
        </div>
      )}
    </article>
  );
}

const sameConfig = (a: SubAgentConfig, b: SubAgentConfig) => {
  if (a.answerMode !== b.answerMode) return false;
  return SUB_AGENTS.every((def) => {
    const x = a.subAgents[def.id];
    const y = b.subAgents[def.id];
    return subAgentEnabled(a.subAgents, def.id) === subAgentEnabled(b.subAgents, def.id) && (x?.instructions || '').trim() === (y?.instructions || '').trim();
  });
};

export function SubAgentsSettings({ workspaceId }: { workspaceId: string }) {
  const [saved, setSaved] = useState<SubAgentConfig | null>(null);
  const [draft, setDraft] = useState<SubAgentConfig | null>(null);
  const [stats, setStats] = useState<SubAgentStats>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await getSubAgentConfigAction(workspaceId);
      return res.success ? { res, error: null } : { res: null, error: res.error };
    } catch (err) {
      return { res: null, error: errorMessage(err, 'Could not load the sub-agent settings.') };
    }
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    fetchConfig().then(({ res, error }) => {
      if (cancelled) return;
      if (res) {
        setSaved(res.config);
        setDraft(res.config);
        setStats(res.stats);
      }
      setLoadError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchConfig]);

  const reload = async () => {
    setLoadError(null);
    setSaved(null);
    const { res, error } = await fetchConfig();
    if (res) {
      setSaved(res.config);
      setDraft(res.config);
      setStats(res.stats);
    }
    setLoadError(error);
  };

  const dirty = Boolean(saved && draft && !sameConfig(saved, draft));
  useReportDirty(dirty);

  const setAgent = (id: SubAgentId, patch: { enabled?: boolean; instructions?: string }) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            subAgents: {
              ...d.subAgents,
              [id]: { enabled: subAgentEnabled(d.subAgents, id), instructions: d.subAgents[id]?.instructions || '', ...patch },
            },
          }
        : d
    );

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveSubAgentConfigAction(workspaceId, draft);
      if (!res.success) {
        setSaveError(res.error);
        return;
      }
      setSaved(res.config);
      setDraft(res.config);
      setStats(res.stats);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (err) {
      setSaveError(errorMessage(err, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) return <ErrorState title="Could not load the sub-agents" message={loadError} onRetry={reload} />;
  if (!saved || !draft) return <LoadingState label="Loading sub-agents…" />;

  const agentMode = draft.answerMode === 'agent';

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Your prop-firm agent team"
        description="Every trader message goes to one specialist, trained for that topic on your published help center. Each answers in the trader's own language and brings in your team only when a person has to act."
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {agentMode ? (
              <Badge tone="success" dot>
                Agent mode on: specialists are answering
              </Badge>
            ) : (
              <>
                <Badge tone="warn" dot>
                  Strict mode: specialists are not used
                </Badge>
                <Button size="sm" variant="primary" onClick={() => setDraft({ ...draft, answerMode: 'agent' })}>
                  Switch to agent mode
                </Button>
              </>
            )}
          </div>
          <FlowDiagram config={draft} />
        </div>
      </SettingsCard>

      <SettingsCard title="Test the router" description="Type what a trader might send and see who answers.">
        <div className="flex items-start gap-2 text-xs text-ink-3 mb-3">
          <FlaskConical className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>Nothing is sent to a customer or saved.</span>
        </div>
        <RouterTester config={draft} />
      </SettingsCard>

      <section aria-labelledby="sub-agents-heading" className="space-y-3">
        <div>
          <h3 id="sub-agents-heading" className="text-md font-semibold text-ink">
            Specialists
          </h3>
          <p className="text-ui text-ink-2">Switch one off to send its topic straight to your team. Open a card to see exactly what it does.</p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {SUB_AGENTS.map((def) => (
            <AgentCard
              key={def.id}
              def={def}
              enabled={subAgentEnabled(draft.subAgents, def.id)}
              instructions={draft.subAgents[def.id]?.instructions || ''}
              stats={stats ? stats[def.id] ?? { replies: 0, handovers: 0 } : undefined}
              onToggle={(v) => setAgent(def.id, { enabled: v })}
              onInstructions={(v) => setAgent(def.id, { instructions: v })}
            />
          ))}
        </div>
      </section>

      <SaveBar dirty={dirty} saving={saving} saved={justSaved} error={saveError} onSave={save} onDiscard={() => setDraft(saved)} />
    </div>
  );
}
