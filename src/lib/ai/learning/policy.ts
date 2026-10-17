import { serviceClient } from '@/lib/supabase/service';
import { REWARD } from './safety';

/**
 * The bot's one tunable decision: how close a passage must be before it is
 * treated as a direct answer (retrieval confidence 'high' in help-answer.ts).
 * Each workspace runs a Thompson-sampling bandit over three fixed settings;
 * rewards come from what visitors did after each answer (safety.ts,
 * scoreOutcome). The settings are fixed and close together, so the bandit can
 * make the bot more or less willing to trust a close match, but an answer
 * still has to pass every other check (citation, figures, Jev): the policy
 * never changes what the bot says.
 */
export type PolicyArm = 'strict' | 'standard' | 'open';

export const POLICY_ARMS: Record<PolicyArm, { similarity: number; combined: number }> = {
  strict: { similarity: 0.7, combined: 0.6 },
  standard: { similarity: 0.65, combined: 0.55 },
  open: { similarity: 0.6, combined: 0.5 },
};

export const DEFAULT_ARM: PolicyArm = 'standard';

export interface ArmPosterior {
  arm: PolicyArm;
  alpha: number;
  beta: number;
  pulls: number;
}

/* ── Sampling ─────────────────────────────────────────────────────────── */

function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(shape, 1) by Marsaglia and Tsang; shape < 1 via the boost identity. */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, rng) * Math.pow(rng() || Number.MIN_VALUE, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, rng: () => number = Math.random): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

/**
 * Picks an arm by Thompson sampling. Until every arm has some evidence the
 * default is used half the time, so a new workspace starts from today's
 * behaviour instead of exploring from its first visitor.
 */
export function chooseArm(posteriors: ArmPosterior[], rng: () => number = Math.random): PolicyArm {
  const byArm = new Map(posteriors.map((p) => [p.arm, p]));
  const all = (Object.keys(POLICY_ARMS) as PolicyArm[]).map(
    (arm) => byArm.get(arm) ?? { arm, alpha: 1, beta: 1, pulls: 0 }
  );
  const warm = all.every((p) => p.pulls >= 20);
  if (!warm && rng() < 0.5) return DEFAULT_ARM;
  let best: { arm: PolicyArm; draw: number } | null = null;
  for (const p of all) {
    const draw = sampleBeta(p.alpha, p.beta, rng);
    if (!best || draw > best.draw) best = { arm: p.arm, draw };
  }
  return best?.arm ?? DEFAULT_ARM;
}

/* ── Storage ──────────────────────────────────────────────────────────── */

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; enabled: boolean; posteriors: ArmPosterior[] }>();

/**
 * The arm for this reply. Any failure (tables missing, database slow) gives
 * the default, so the policy can never stop the bot from answering.
 */
export async function pickPolicyArm(workspaceId: string): Promise<PolicyArm> {
  try {
    let entry = cache.get(workspaceId);
    if (!entry || Date.now() - entry.at > CACHE_MS) {
      const supabase = serviceClient();
      const [{ data: settings }, { data: arms }] = await Promise.all([
        supabase.from('bot_learning_settings').select('enabled, adaptive_retrieval').eq('workspace_id', workspaceId).maybeSingle(),
        supabase.from('bot_policy_arms').select('arm, alpha, beta, pulls').eq('workspace_id', workspaceId),
      ]);
      entry = {
        at: Date.now(),
        // No settings row means the defaults: learning and the policy on.
        enabled: settings ? settings.enabled !== false && settings.adaptive_retrieval !== false : true,
        posteriors: ((arms as ArmPosterior[] | null) || []).filter((a) => a.arm in POLICY_ARMS),
      };
      cache.set(workspaceId, entry);
    }
    return entry.enabled ? chooseArm(entry.posteriors) : DEFAULT_ARM;
  } catch {
    return DEFAULT_ARM;
  }
}

export function forgetPolicyCache(workspaceId: string): void {
  cache.delete(workspaceId);
}

/**
 * Records which arm a delivered help-centre reply was made under. A handover
 * is scored at once; an answer is scored later by the learning cron, once
 * the visitor's reaction is known.
 */
export async function recordPolicyOutcome(input: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  arm: PolicyArm;
  kind: 'answer' | 'handover';
}): Promise<void> {
  try {
    const supabase = serviceClient();
    const { error } = await supabase.from('bot_policy_outcomes').insert({
      message_id: input.messageId,
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      arm: input.arm,
      kind: input.kind,
    });
    if (error) {
      if (error.code !== '23505') console.warn('[Bot Policy] Could not record outcome:', error.message);
      return;
    }
    if (input.kind === 'handover') {
      const { error: rewardError } = await supabase.rpc('fn_bot_policy_reward', {
        p_message_id: input.messageId,
        p_reward: REWARD.handover,
      });
      if (rewardError) console.warn('[Bot Policy] Could not score handover:', rewardError.message);
    }
  } catch (err) {
    console.warn('[Bot Policy] Could not record outcome:', (err as Error)?.message);
  }
}
