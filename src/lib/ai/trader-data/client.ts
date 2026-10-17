/**
 * The workspace's trader data connection: where the lookup specialists read
 * the firm's own records (account status, KYC, orders, affiliate numbers,
 * coupons). Usually the firm's prop-firm backend on Supabase
 * (prop-firm-supabase.ts); this file holds the connection, the shared types
 * and the HTTP endpoint variant. Contract in docs/TRADER_DATA.md.
 *
 * The URL is chosen by a workspace admin and called from our servers, so it
 * gets the same guard as the LangGraph bridge (checkAgentUrl: https, public
 * host, no credentials in the URL) and redirects are refused. The call is
 * short (TRADER_DATA_TIMEOUT_MS) because the visitor is waiting and the reply
 * still has a model call after it; any failure means "no record", and the
 * specialist answers the way it does without a connection.
 */
import { serviceClient } from '@/lib/supabase/service';
import { decryptSecret } from '@/lib/channels/crypto';
import { checkAgentUrl } from '@/lib/agent/external-agent';
import type { TraderLookupAction } from '@/lib/ai/sub-agents';
import type { LookupHints } from './parse';

export const TRADER_DATA_TIMEOUT_MS = 6_000;
/** The record goes into the prompt; more than this is cut. */
export const MAX_RECORD_CHARS = 4_000;

/**
 * 'supabase': the firm's prop-firm backend project, read directly
 * (prop-firm-supabase.ts). 'http': the firm's own endpoint (contract below).
 */
export type TraderDataKind = 'supabase' | 'http';

export interface TraderDataConnection {
  enabled: boolean;
  kind: TraderDataKind;
  url: string | null;
  /** The service-role key or the endpoint's bearer key, decrypted. */
  secret: string | null;
  /** A key is stored but could not be decrypted (CHANNEL_ENCRYPTION_KEY changed or missing). */
  secretUnreadable?: boolean;
  /**
   * Prove the email with a 6-digit code before a record is read
   * (20261121090000). Off by default: the email the trader gives is used.
   */
  requireCode?: boolean;
}

export async function loadTraderDataConnection(workspaceId: string): Promise<TraderDataConnection | null> {
  const { data, error } = await serviceClient()
    .from('trader_data_connections')
    // '*' so a database without require_code yet (20261121090000) still loads.
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) {
    // Before the migration has run the table does not exist: no connection.
    console.warn('[Trader Data] Could not load the connection:', error.message);
    return null;
  }
  if (!data) return null;
  let secret: string | null = null;
  let secretUnreadable = false;
  if (data.secret_encrypted) {
    try {
      secret = decryptSecret<string>(data.secret_encrypted);
    } catch (err) {
      console.error('[Trader Data] Could not decrypt the saved key:', (err as Error)?.message);
      secretUnreadable = true;
    }
  }
  return {
    enabled: Boolean(data.enabled),
    kind: data.kind === 'http' ? 'http' : 'supabase',
    url: data.url?.trim() || null,
    secret,
    secretUnreadable,
    requireCode: data.require_code === true,
  };
}

/** On, pointed somewhere, and (for Supabase, which needs one) holding a key. */
export function traderDataActive(c: TraderDataConnection | null): c is TraderDataConnection & { url: string } {
  return Boolean(c?.enabled && c.url && (c.kind === 'http' || c.secret));
}

export interface TraderRecord {
  found: boolean;
  /** What the endpoint returned for the prompt, as compact JSON. */
  text: string;
}

export class TraderDataError extends Error {}

/** Reads the endpoint's answer: `found` plus a `record` (or `records`) object. */
export function parseTraderRecord(body: unknown): TraderRecord | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const record = b.record ?? b.records ?? b.data ?? null;
  const found = typeof b.found === 'boolean' ? b.found : record !== null && record !== undefined;
  const message = typeof b.message === 'string' ? b.message.trim().slice(0, 500) : null;
  if (!found) return { found: false, text: message ? JSON.stringify({ message }) : '' };
  const payload = message ? { record, message } : { record };
  let text = JSON.stringify(payload);
  if (text.length > MAX_RECORD_CHARS) text = `${text.slice(0, MAX_RECORD_CHARS)}…(cut)`;
  return { found: true, text };
}

export interface TraderLookupRequest {
  action: TraderLookupAction | 'test';
  workspaceId: string;
  conversationId: string;
  /** The email the visitor proved (or, without the code, gave) in this conversation. */
  verifiedEmail: string | null;
  hints: LookupHints;
  question: string;
  /**
   * Without the email code (the workspace's choice): an order id or account
   * login the trader typed finds the trader by itself, before the email.
   * With the code it only narrows the verified email's own rows.
   */
  findByIds?: boolean;
}

/** One POST to the endpoint; throws TraderDataError with a reason an admin can act on. */
export async function callTraderData(
  connection: { url: string; apiKey: string | null },
  req: TraderLookupRequest,
  timeoutMs = TRADER_DATA_TIMEOUT_MS
): Promise<{ record: TraderRecord; latencyMs: number }> {
  const checked = checkAgentUrl(connection.url);
  if (!checked.ok) throw new TraderDataError(checked.reason.replace('agent', 'endpoint'));
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(checked.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Zentry-Trader-Data/1',
        ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
      },
      body: JSON.stringify({
        version: 1,
        action: req.action,
        workspace_id: req.workspaceId,
        conversation_id: req.conversationId,
        email: req.verifiedEmail,
        email_verified: Boolean(req.verifiedEmail),
        account_login: req.hints.account_login ?? null,
        order_id: req.hints.order_id ?? null,
        coupon_code: req.hints.coupon_code ?? null,
        question: req.question.slice(0, 1000),
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as { name?: string; message?: string };
    throw new TraderDataError(
      e?.name === 'TimeoutError' ? `No answer within ${Math.round(timeoutMs / 1000)} s.` : `Could not reach the endpoint (${e?.message || 'network error'}).`
    );
  }
  const latencyMs = Date.now() - started;
  if (res.status >= 300 && res.status < 400) throw new TraderDataError(`The endpoint answered with a redirect (HTTP ${res.status}); use its final URL.`);
  if (res.status === 404) return { record: { found: false, text: '' }, latencyMs };
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160);
    throw new TraderDataError(`The endpoint returned HTTP ${res.status}${detail ? `: ${detail}` : ''}.`);
  }
  const body = await res.json().catch(() => null);
  const record = parseTraderRecord(body);
  if (!record) throw new TraderDataError('The endpoint did not answer with a JSON object.');
  return { record, latencyMs };
}
