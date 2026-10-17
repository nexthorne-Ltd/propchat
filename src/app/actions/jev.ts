'use server';

/**
 * Super admin → Platform AI → Jev: TypeSafe's decision model next to the
 * platform's DeepSeek model, set once for every workspace.
 *
 * Stored on the platform_ai_settings row (service role only), beside the
 * DeepSeek key. The TypeSafe key is write-only: the screen learns whether one
 * is saved and its last four characters. "Test connection" asks Jev a real
 * intent question from our server. The summary reads the decisions the bot
 * logged across the platform (ai_reply_events), so the super admin can see
 * how often Jev agreed with DeepSeek before letting it decide.
 */
import { assertSuperAdmin, recordSuperAdminAudit } from '@/app/actions/platform';
import { serviceClient } from '@/lib/supabase/service';
import { DEFAULT_JEV_SETTINGS, jevIntent, normalizeJevSettings, type JevSettings } from '@/lib/ai/jev';
import { errorMessage } from '@/lib/errors/user-error';

export interface JevSettingsView extends JevSettings {
  hasApiKey: boolean;
  keyLast4: string | null;
  /** The server has TYPESAFE_API_KEY, used when no key is saved here. */
  envKey: boolean;
}

export interface JevSummary {
  days: number;
  intent: {
    total: number;
    /** Live: Jev decided. */
    decided: number;
    /** Shadow, or live below the bar: compared with the deciding path. */
    compared: number;
    agreed: number;
    errors: number;
    avgLatencyMs: number | null;
  };
  grounding: {
    total: number;
    /** Answers stopped (live) or that would have been (shadow). */
    flagged: number;
    blocked: number;
    errors: number;
    avgLatencyMs: number | null;
  };
  /** Specialist picks where the router's rules were unsure (router-assist.ts). */
  routing: {
    total: number;
    /** Live: Jev decided. */
    decided: number;
    /** Jev picked another specialist than the rules. */
    changed: number;
    errors: number;
  };
}

type Result<T> = ({ success: true } & T) | { success: false; error: string };

async function readRow(): Promise<{ jev_settings?: unknown; jev_api_key?: string | null } | null> {
  const { data, error } = await serviceClient()
    .from('platform_ai_settings')
    .select('jev_settings, jev_api_key')
    .eq('id', true)
    .maybeSingle();
  if (error) {
    console.error('[Jev Settings] Load failed:', error.message);
    throw new Error(
      /jev_/.test(error.message)
        ? 'Run the migration 20261109090000_jev_decisions.sql in Supabase first.'
        : 'Could not load the Jev settings.'
    );
  }
  return data as { jev_settings?: unknown; jev_api_key?: string | null } | null;
}

function toView(row: { jev_settings?: unknown; jev_api_key?: string | null } | null): JevSettingsView {
  const key = row?.jev_api_key || '';
  return {
    ...normalizeJevSettings(row?.jev_settings),
    hasApiKey: Boolean(key),
    keyLast4: key ? key.slice(-4) : null,
    envKey: Boolean(process.env.TYPESAFE_API_KEY),
  };
}

async function readSummary(days = 14): Promise<JevSummary> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await serviceClient()
    .from('ai_reply_events')
    .select('event, reason, detail')
    .in('event', ['jev_intent', 'jev_grounding', 'route_assist'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(10000);
  const rows = (data || []) as { event: string; reason: string | null; detail: Record<string, unknown> | null }[];
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const latency = (d: Record<string, unknown> | null) => (typeof d?.latency_ms === 'number' ? (d.latency_ms as number) : null);

  const intents = rows.filter((r) => r.event === 'jev_intent');
  const compared = intents.filter((r) => typeof r.detail?.agreed === 'boolean');
  const grounding = rows.filter((r) => r.event === 'jev_grounding');
  const routing = rows.filter((r) => r.event === 'route_assist' && /^jev_/.test(r.reason || ''));
  return {
    days,
    intent: {
      total: intents.length,
      decided: intents.filter((r) => r.reason === 'decided').length,
      compared: compared.length,
      agreed: compared.filter((r) => r.detail?.agreed === true).length,
      errors: intents.filter((r) => r.reason === 'error').length,
      avgLatencyMs: avg(intents.map((r) => latency(r.detail)).filter((x): x is number => x !== null)),
    },
    grounding: {
      total: grounding.length,
      flagged: grounding.filter((r) => r.detail?.would_block === true).length,
      blocked: grounding.filter((r) => r.reason === 'blocked').length,
      errors: grounding.filter((r) => r.reason === 'error').length,
      avgLatencyMs: avg(grounding.map((r) => latency(r.detail)).filter((x): x is number => x !== null)),
    },
    routing: {
      total: routing.length,
      decided: routing.filter((r) => r.reason === 'jev_decided').length,
      changed: routing.filter((r) => r.detail?.agreed === false).length,
      errors: routing.filter((r) => r.reason === 'jev_error').length,
    },
  };
}

export async function getJevSettingsAction(): Promise<Result<{ settings: JevSettingsView; summary: JevSummary }>> {
  await assertSuperAdmin();
  try {
    const [row, summary] = await Promise.all([readRow(), readSummary()]);
    return { success: true, settings: toView(row), summary };
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Could not load the Jev settings.') };
  }
}

export async function saveJevSettingsAction(
  input: Partial<JevSettings> & {
    /** undefined keeps the saved key; null or '' removes it. */
    apiKey?: string | null;
  }
): Promise<Result<{ settings: JevSettingsView; summary: JevSummary }>> {
  const { user, agent } = await assertSuperAdmin();
  const settings = normalizeJevSettings({ ...DEFAULT_JEV_SETTINGS, ...input });
  const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : input.apiKey;
  if (typeof key === 'string' && key.length > 500) return { success: false, error: 'The API key is too long.' };

  let current: Awaited<ReturnType<typeof readRow>>;
  try {
    current = await readRow();
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Could not load the Jev settings.') };
  }
  const finalKey = key === undefined ? current?.jev_api_key || null : key || null;
  if (settings.mode !== 'off' && !finalKey && !process.env.TYPESAFE_API_KEY) {
    return { success: false, error: 'Add the TypeSafe API key before turning Jev on.' };
  }

  const { error } = await serviceClient()
    .from('platform_ai_settings')
    .upsert(
      {
        id: true,
        jev_api_key: finalKey,
        jev_settings: {
          mode: settings.mode,
          intent: settings.intent,
          grounding: settings.grounding,
          minConfidence: settings.minConfidence,
          minGrounding: settings.minGrounding,
          router: settings.router,
          minRouteConfidence: settings.minRouteConfidence,
        },
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      },
      { onConflict: 'id' }
    );
  if (error) {
    console.error('[Jev Settings] Save failed:', error.message);
    return { success: false, error: 'Could not save the Jev settings.' };
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'platform_jev_settings_updated',
    details: {
      mode: settings.mode,
      intent: settings.intent,
      grounding: settings.grounding,
      min_confidence: settings.minConfidence,
      min_grounding: settings.minGrounding,
      router: settings.router,
      min_route_confidence: settings.minRouteConfidence,
      key_updated: key !== undefined,
    },
  });
  return getJevSettingsAction();
}

/**
 * Asks Jev to classify a sample Roman Urdu message, with the key from the
 * form (if one was typed) or the saved one. Proves the key works and shows
 * how fast it answers from our server.
 */
export async function testJevAction(apiKey?: string): Promise<Result<{ intent: string; confidence: number; latencyMs: number }>> {
  await assertSuperAdmin();
  let key = (apiKey || '').trim();
  if (!key) {
    try {
      key = ((await readRow())?.jev_api_key || process.env.TYPESAFE_API_KEY || '').trim();
    } catch (err) {
      return { success: false, error: errorMessage(err, 'Could not load the saved key.') };
    }
  }
  if (!key) return { success: false, error: 'Enter the TypeSafe API key first.' };
  try {
    const verdict = await jevIntent(
      { apiKey: key, settings: { ...DEFAULT_JEV_SETTINGS, mode: 'shadow' } },
      { message: 'bhai mera order abhi tak nahi aya, kahan hai?', workspaceName: 'Test shop', topics: ['Shipping', 'Refunds', 'Pricing'] }
    );
    return { success: true, intent: verdict.intent, confidence: verdict.confidence, latencyMs: verdict.latencyMs };
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Jev did not answer.') };
  }
}
