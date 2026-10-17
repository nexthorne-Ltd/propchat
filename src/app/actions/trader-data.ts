'use server';

/**
 * Settings → AI bot → Trader data: where the lookup specialists read the
 * firm's records (src/lib/ai/trader-data/, docs/TRADER_DATA.md). Usually the
 * firm's prop-firm backend on Supabase (project URL + service_role key);
 * otherwise an HTTPS endpoint.
 *
 * Written with the service role after assertAdminUser, because the table has
 * no RLS policy. The key is encrypted before it is stored and is write-only:
 * the screen learns only whether one is set. A saved key is never sent to a
 * URL other than the one it was saved for, so changing the URL means pasting
 * the key again. "Test connection" runs the same checks as the bot, with no
 * email, so a test never reads anyone's record.
 */
import { assertAdminUser } from '@/app/actions/admin';
import { serviceClient } from '@/lib/supabase/service';
import { checkAgentUrl } from '@/lib/agent/external-agent';
import { encryptSecret, hasEncryptionKey } from '@/lib/channels/crypto';
import { loadTraderDataConnection, TraderDataError, type TraderDataKind } from '@/lib/ai/trader-data/client';
import { checkServiceRoleKey, checkSupabaseUrl } from '@/lib/ai/trader-data/prop-firm-supabase';
import { fetchTraderRecord } from '@/lib/ai/trader-data/source';
import { loadTeamAlertSmtp } from '@/lib/email/workspace-smtp';

export interface TraderDataSettings {
  enabled: boolean;
  kind: TraderDataKind;
  url: string;
  hasSecret: boolean;
  /** A key is saved but cannot be decrypted: it must be pasted again. */
  secretUnreadable: boolean;
  /** Whether a verification code can be emailed (workspace or platform SMTP). */
  canSendCodes: boolean;
  /** Whether the server can encrypt a key (CHANNEL_ENCRYPTION_KEY is set). */
  canStoreKeys: boolean;
  /** Prove the email with a 6-digit code before reading a record (off by default). */
  requireCode: boolean;
}

type Result<T> = ({ success: true } & T) | { success: false; error: string };

export async function getTraderDataSettingsAction(workspaceId: string): Promise<Result<{ settings: TraderDataSettings }>> {
  await assertAdminUser(workspaceId);
  const [config, smtp] = await Promise.all([loadTraderDataConnection(workspaceId), loadTeamAlertSmtp(workspaceId).catch(() => null)]);
  return {
    success: true,
    settings: {
      enabled: Boolean(config?.enabled && config.url),
      kind: config?.kind ?? 'supabase',
      url: config?.url || '',
      hasSecret: Boolean(config?.secret || config?.secretUnreadable),
      secretUnreadable: Boolean(config?.secretUnreadable),
      canSendCodes: Boolean(smtp),
      canStoreKeys: hasEncryptionKey(),
      requireCode: Boolean(config?.requireCode),
    },
  };
}

function normaliseUrl(kind: TraderDataKind, raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  if (kind === 'supabase') return checkSupabaseUrl(raw);
  const checked = checkAgentUrl(raw);
  return checked.ok ? { ok: true, url: checked.url.toString() } : { ok: false, reason: checked.reason.replace('agent', 'endpoint') };
}

export async function saveTraderDataSettingsAction(
  workspaceId: string,
  input: {
    enabled: boolean;
    kind: TraderDataKind;
    url: string;
    /** undefined keeps the saved key; null or '' removes it. */
    secret?: string | null;
    /** undefined keeps the saved choice. */
    requireCode?: boolean;
  }
): Promise<Result<{ settings: TraderDataSettings }>> {
  await assertAdminUser(workspaceId);
  const kind: TraderDataKind = input.kind === 'http' ? 'http' : 'supabase';
  const raw = (input.url || '').trim();
  let url: string | null = null;
  if (raw || input.enabled) {
    const checked = normaliseUrl(kind, raw);
    if (!checked.ok) return { success: false, error: checked.reason };
    url = checked.url;
  }
  const secret = typeof input.secret === 'string' ? input.secret.trim() : input.secret;
  if (typeof secret === 'string' && secret.length > 2000) return { success: false, error: 'The key is too long.' };

  const saved = await loadTraderDataConnection(workspaceId);
  const urlChanged = (saved?.url || null) !== url || (saved?.kind ?? 'supabase') !== kind;
  // A saved key only ever goes to the URL it was saved for.
  const keepsOldKey = secret === undefined && !urlChanged && Boolean(saved?.secret);
  const newKey = typeof secret === 'string' && secret ? secret : null;

  if (kind === 'supabase' && input.enabled) {
    if (!newKey && !keepsOldKey) {
      return { success: false, error: urlChanged && saved?.secret ? 'The project URL changed: paste the service_role key again.' : 'Paste the service_role key.' };
    }
  }
  if (newKey && kind === 'supabase') {
    const keyCheck = checkServiceRoleKey(newKey);
    if (!keyCheck.ok) return { success: false, error: keyCheck.reason };
  }

  const patch: Record<string, unknown> = {
    workspace_id: workspaceId,
    enabled: Boolean(input.enabled && url),
    kind,
    url,
    updated_at: new Date().toISOString(),
  };
  if (typeof input.requireCode === 'boolean') patch.require_code = input.requireCode;
  if (newKey) {
    if (!hasEncryptionKey()) {
      return { success: false, error: 'The server cannot store keys yet: CHANNEL_ENCRYPTION_KEY is not set. Ask the platform owner to set it.' };
    }
    patch.secret_encrypted = encryptSecret(newKey);
  } else if (secret === null || secret === '' || (urlChanged && secret === undefined)) {
    patch.secret_encrypted = null;
  }

  const { error } = await serviceClient().from('trader_data_connections').upsert(patch, { onConflict: 'workspace_id' });
  if (error) {
    console.error('[Trader Data] Save failed:', error.message);
    return {
      success: false,
      error: /require_code/.test(error.message)
        ? 'Run the migration 20261121090000_trader_data_code_optional.sql in Supabase first.'
        : 'Could not save the trader data settings.',
    };
  }
  return getTraderDataSettingsAction(workspaceId);
}

/**
 * Tries the connection in the form: its URL and key, or the saved key when
 * the form leaves it untouched and the URL is the saved one.
 */
export async function testTraderDataAction(
  workspaceId: string,
  input: { kind: TraderDataKind; url: string; secret?: string | null }
): Promise<Result<{ latencyMs: number }>> {
  await assertAdminUser(workspaceId);
  const kind: TraderDataKind = input.kind === 'http' ? 'http' : 'supabase';
  const checked = normaliseUrl(kind, input.url);
  if (!checked.ok) return { success: false, error: checked.reason };
  const saved = await loadTraderDataConnection(workspaceId);
  const sameTarget = saved?.url === checked.url && saved.kind === kind;
  const secret = input.secret === undefined ? (sameTarget ? saved?.secret ?? null : null) : input.secret?.trim() || null;
  if (kind === 'supabase') {
    const keyCheck = checkServiceRoleKey(secret);
    if (!keyCheck.ok) return { success: false, error: keyCheck.reason };
  }
  try {
    const { latencyMs } = await fetchTraderRecord(
      { enabled: true, kind, url: checked.url, secret },
      { action: 'test', workspaceId, conversationId: 'test', verifiedEmail: null, hints: {}, question: 'Connection test from Zentry.' },
      10_000
    );
    return { success: true, latencyMs };
  } catch (err) {
    if (err instanceof TraderDataError) return { success: false, error: err.message };
    console.error('[Trader Data] Test failed:', err);
    return { success: false, error: 'The test could not be run.' };
  }
}
