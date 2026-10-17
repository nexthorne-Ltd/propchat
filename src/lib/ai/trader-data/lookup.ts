/**
 * The lookup step of the bot pipeline: before a lookup specialist answers,
 * fetch the trader's record, proving their email first.
 *
 * Why a code in the chat: anyone can type someone else's email, and a record
 * (balance, breach, KYC, orders) is personal. The widget has no login, so the
 * proof happens in the conversation itself, and works the same on every
 * channel: the bot asks for the account email, sends a 6-digit code to it,
 * and the visitor types the code back. Only then is the record fetched, and
 * only for that email. Verification lasts VERIFIED_FOR_MS in the conversation.
 * A coupon check needs no identity (a code is not personal) and goes straight
 * to the endpoint.
 *
 * Everything here fails towards the old behaviour: no connection, no SMTP to
 * send a code, a failing endpoint or a missing table all give `none` (or an
 * answer without a record), and the specialist then explains and hands over
 * as it did before. The fixed messages are sent without a model.
 *
 * State lives in trader_identity_verifications (one row per conversation,
 * service role only); only a hash of the code is stored.
 */
import crypto from 'node:crypto';
import { serviceClient } from '@/lib/supabase/service';
import { checkRateLimit } from '@/lib/rate-limit';
import { sendSmtpEmail } from '@/lib/email/smtp';
import { renderEmail } from '@/lib/email/layout';
import { loadTeamAlertSmtp } from '@/lib/email/workspace-smtp';
import { logAiEvent } from '@/lib/ai/bot-control';
import type { ReplyLanguage } from '@/lib/ai/intent';
import { SUB_AGENT_BY_ID, isSubAgentId, type SubAgentId } from '@/lib/ai/sub-agents';
import { loadTraderDataConnection, traderDataActive, type TraderRecord } from './client';
import { fetchTraderRecord } from './source';
import { extractCode, extractEmail, extractHints, verificationLockedText, verificationText } from './parse';

export const CODE_TTL_MS = 10 * 60_000;
export const VERIFIED_FOR_MS = 12 * 60 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
/** Codes per conversation before a person takes over. */
export const MAX_CODES_PER_CONVERSATION = 3;
const RESEND_AFTER_MS = 60_000;

export type LookupStep =
  /** Nothing to do here: the specialist answers as without a connection. */
  | { kind: 'none' }
  /** A fixed verification message for the visitor; no model call. */
  | { kind: 'reply'; text: string; subAgent: SubAgentId; handover?: string }
  /** Answer `question` with the record (null when the lookup failed). */
  | {
      kind: 'answer';
      subAgent: SubAgentId;
      question: string;
      record: TraderRecord | null;
      verifiedEmail: string | null;
      justVerified: boolean;
    };

interface VerificationRow {
  id: string;
  status: 'awaiting_email' | 'awaiting_code' | 'verified';
  email: string | null;
  code_hash: string | null;
  attempts: number;
  codes_sent: number;
  last_sent_at: string | null;
  code_expires_at: string | null;
  verified_at: string | null;
  pending_question: string | null;
  pending_sub_agent: string | null;
}

export function hashCode(conversationId: string, code: string): string {
  return crypto.createHash('sha256').update(`${conversationId}:${code}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function isVerified(row: Pick<VerificationRow, 'status' | 'verified_at' | 'email'> | null, now = Date.now()): boolean {
  return Boolean(row && row.status === 'verified' && row.email && row.verified_at && now - Date.parse(row.verified_at) < VERIFIED_FOR_MS);
}

async function loadState(conversationId: string): Promise<VerificationRow | null> {
  const { data, error } = await serviceClient()
    .from('trader_identity_verifications')
    .select('id, status, email, code_hash, attempts, codes_sent, last_sent_at, code_expires_at, verified_at, pending_question, pending_sub_agent')
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as VerificationRow | null) ?? null;
}

async function saveState(workspaceId: string, conversationId: string, patch: Partial<VerificationRow>): Promise<void> {
  const { error } = await serviceClient()
    .from('trader_identity_verifications')
    .upsert(
      { workspace_id: workspaceId, conversation_id: conversationId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'conversation_id' }
    );
  if (error) throw new Error(error.message);
}

export interface PrepareLookupInput {
  workspaceId: string;
  conversationId: string;
  message: string;
  /** The specialist the router picked for this message. */
  routedAgent: SubAgentId;
  /** Whether the workspace has that specialist switched on. */
  enabled: (id: SubAgentId) => boolean;
  lang: ReplyLanguage;
  brand: string;
}

export async function prepareTraderLookup(input: PrepareLookupInput): Promise<LookupStep> {
  try {
    const connection = await loadTraderDataConnection(input.workspaceId);
    if (!traderDataActive(connection)) return { kind: 'none' };
    const state = await loadState(input.conversationId);
    const pending = state && state.status !== 'verified' ? state : null;

    const lookup = async (subAgent: SubAgentId, question: string, email: string | null, justVerified: boolean): Promise<LookupStep> => {
      const action = SUB_AGENT_BY_ID[subAgent].lookup?.action;
      if (!action) return { kind: 'none' };
      try {
        const { record, latencyMs } = await fetchTraderRecord(connection, {
          action,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          verifiedEmail: email,
          hints: extractHints(input.message, question),
          question,
          findByIds: !connection.requireCode,
        });
        void logAiEvent(serviceClient(), {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          event: 'trader_lookup',
          reason: record.found ? 'found' : 'not_found',
          detail: { action, latency_ms: latencyMs, verified: Boolean(email) },
        });
        return { kind: 'answer', subAgent, question, record, verifiedEmail: email, justVerified };
      } catch (err) {
        console.warn('[Trader Data] Lookup failed, answering without the record:', (err as Error)?.message);
        void logAiEvent(serviceClient(), {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          event: 'trader_lookup',
          reason: 'error',
          detail: { action, error: String((err as Error)?.message || '').slice(0, 200) },
        });
        return { kind: 'answer', subAgent, question, record: null, verifiedEmail: email, justVerified };
      }
    };

    // 0. Without the code (the default): the email the trader types, or the
    // one on the pre-chat form, is the identity; the record is read at once.
    if (!connection.requireCode) {
      const typed = extractEmail(input.message);
      const def = SUB_AGENT_BY_ID[input.routedAgent];
      // An email answering "which email is your account on?" answers the
      // question asked before it.
      if (pending && typed) {
        const pendingAgent: SubAgentId =
          isSubAgentId(pending.pending_sub_agent) && SUB_AGENT_BY_ID[pending.pending_sub_agent].lookup
            ? pending.pending_sub_agent
            : input.routedAgent;
        await identify(input, typed);
        return lookup(pendingAgent, pending.pending_question || input.message, typed, true);
      }
      if (!def.lookup || !input.enabled(input.routedAgent)) return { kind: 'none' };
      if (!def.lookup.needsIdentity) return lookup(input.routedAgent, input.message, typed ?? (isVerified(state) ? state!.email : null), false);
      // A new email in the message wins over the one used before.
      const email = typed ?? (isVerified(state) ? state!.email : null) ?? (await visitorEmail(input));
      if (email) {
        if (email !== state?.email || !isVerified(state)) await identify(input, email);
        return lookup(input.routedAgent, input.message, email, false);
      }
      // An order id or login is enough to find the trader: no email asked.
      const hints = extractHints(input.message);
      if (hints.order_id || hints.account_login) return lookup(input.routedAgent, input.message, null, false);
      await saveState(input.workspaceId, input.conversationId, {
        status: 'awaiting_email',
        pending_question: input.message,
        pending_sub_agent: input.routedAgent,
      });
      logVerification(input, 'asked_email');
      return { kind: 'reply', text: verificationText.askEmailOnly(input.lang), subAgent: input.routedAgent };
    }

    // 1. A verification in progress takes the code or the email first,
    // whatever the router made of "482913" or "ali@example.com".
    if (pending) {
      const pendingAgent: SubAgentId =
        isSubAgentId(pending.pending_sub_agent) && SUB_AGENT_BY_ID[pending.pending_sub_agent].lookup
          ? pending.pending_sub_agent
          : input.routedAgent;
      const code = extractCode(input.message);
      if (code && pending.status === 'awaiting_code' && pending.code_hash) {
        if (!pending.code_expires_at || Date.parse(pending.code_expires_at) < Date.now()) {
          await saveState(input.workspaceId, input.conversationId, { status: 'awaiting_email', code_hash: null });
          return { kind: 'reply', text: verificationText.expired(input.lang), subAgent: pendingAgent };
        }
        if (!sameHash(hashCode(input.conversationId, code), pending.code_hash)) {
          const attempts = (pending.attempts || 0) + 1;
          const left = MAX_CODE_ATTEMPTS - attempts;
          await saveState(input.workspaceId, input.conversationId, {
            attempts,
            ...(left <= 0 ? { status: 'awaiting_email', code_hash: null } : {}),
          });
          logVerification(input, left <= 0 ? 'locked' : 'wrong_code');
          return left <= 0
            ? { kind: 'reply', text: verificationLockedText(input.lang), subAgent: pendingAgent, handover: 'Trader could not verify their email (too many wrong codes)' }
            : { kind: 'reply', text: verificationText.wrongCode(input.lang, left), subAgent: pendingAgent };
        }
        const question = pending.pending_question || input.message;
        const email = pending.email;
        await saveState(input.workspaceId, input.conversationId, {
          status: 'verified',
          verified_at: new Date().toISOString(),
          code_hash: null,
          attempts: 0,
          pending_question: null,
          pending_sub_agent: null,
        });
        logVerification(input, 'verified');
        return lookup(pendingAgent, question, email, true);
      }

      const email = extractEmail(input.message);
      if (email) return sendCode(input, pending, email, pendingAgent);

      // Something else meanwhile: a lookup question becomes the one to answer
      // after verifying; anything else is answered normally.
      const def = SUB_AGENT_BY_ID[input.routedAgent];
      if (def.lookup?.needsIdentity && input.enabled(input.routedAgent)) {
        await saveState(input.workspaceId, input.conversationId, { pending_question: input.message, pending_sub_agent: input.routedAgent });
        return pending.status === 'awaiting_code' && pending.email
          ? { kind: 'reply', text: verificationText.codeSent(input.lang, pending.email), subAgent: input.routedAgent }
          : { kind: 'reply', text: verificationText.askEmail(input.lang), subAgent: input.routedAgent };
      }
      return { kind: 'none' };
    }

    // 2. A new lookup question.
    const def = SUB_AGENT_BY_ID[input.routedAgent];
    if (!def.lookup || !input.enabled(input.routedAgent)) return { kind: 'none' };
    if (!def.lookup.needsIdentity) return lookup(input.routedAgent, input.message, isVerified(state) ? state!.email : null, false);
    if (isVerified(state)) return lookup(input.routedAgent, input.message, state!.email, false);

    await saveState(input.workspaceId, input.conversationId, {
      status: 'awaiting_email',
      email: null,
      code_hash: null,
      attempts: 0,
      verified_at: null,
      pending_question: input.message,
      pending_sub_agent: input.routedAgent,
    });
    const email = extractEmail(input.message);
    if (email) return sendCode(input, { ...(state ?? emptyRow()), status: 'awaiting_email', pending_question: input.message }, email, input.routedAgent);
    logVerification(input, 'asked_email');
    return { kind: 'reply', text: verificationText.askEmail(input.lang), subAgent: input.routedAgent };
  } catch (err) {
    // A missing table (migration not run) or a database error: carry on as before.
    console.warn('[Trader Data] Lookup step skipped:', (err as Error)?.message);
    return { kind: 'none' };
  }
}

/**
 * Without the code: remembers the email the trader gave for this
 * conversation (status 'verified' here means "identified", for
 * VERIFIED_FOR_MS), so a follow-up question needs no email again.
 */
async function identify(input: PrepareLookupInput, email: string): Promise<void> {
  await saveState(input.workspaceId, input.conversationId, {
    status: 'verified',
    email,
    verified_at: new Date().toISOString(),
    code_hash: null,
    attempts: 0,
    pending_question: null,
    pending_sub_agent: null,
  });
  logVerification(input, 'email_given');
}

/** The email the visitor gave on the pre-chat form, if any, for this workspace's conversation. */
async function visitorEmail(input: PrepareLookupInput): Promise<string | null> {
  const { data } = await serviceClient()
    .from('conversations')
    .select('workspace_id, visitor:visitors(email)')
    .eq('id', input.conversationId)
    .maybeSingle();
  if (!data || data.workspace_id !== input.workspaceId) return null;
  const visitor = (Array.isArray(data.visitor) ? data.visitor[0] : data.visitor) as { email?: string | null } | null;
  return extractEmail(visitor?.email || '');
}

function emptyRow(): VerificationRow {
  return {
    id: '',
    status: 'awaiting_email',
    email: null,
    code_hash: null,
    attempts: 0,
    codes_sent: 0,
    last_sent_at: null,
    code_expires_at: null,
    verified_at: null,
    pending_question: null,
    pending_sub_agent: null,
  };
}

function logVerification(input: PrepareLookupInput, reason: string) {
  void logAiEvent(serviceClient(), {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    event: 'trader_verification',
    reason,
  });
}

async function sendCode(input: PrepareLookupInput, row: VerificationRow, email: string, subAgent: SubAgentId): Promise<LookupStep> {
  const lastSent = row.last_sent_at ? Date.parse(row.last_sent_at) : 0;
  if (row.email === email && row.status === 'awaiting_code' && Date.now() - lastSent < RESEND_AFTER_MS) {
    return { kind: 'reply', text: verificationText.waitBeforeResend(input.lang, Math.ceil((RESEND_AFTER_MS - (Date.now() - lastSent)) / 1000)), subAgent };
  }
  // The row's own count is the hard cap; the shared buckets also stop one
  // address (or one workspace) being sent codes from many conversations.
  const allowed =
    (row.codes_sent || 0) < MAX_CODES_PER_CONVERSATION &&
    (await checkRateLimit(`trader_otp_email:${email}`, 5, 3600)) &&
    (await checkRateLimit(`trader_otp_ws:${input.workspaceId}`, 200, 3600));
  if (!allowed) {
    logVerification(input, 'rate_limited');
    return { kind: 'reply', text: verificationLockedText(input.lang), subAgent, handover: 'Trader asked for too many verification codes' };
  }

  const smtp = await loadTeamAlertSmtp(input.workspaceId);
  if (!smtp) {
    console.warn('[Trader Data] No SMTP to send a verification code; answering without the record.');
    logVerification(input, 'no_smtp');
    return { kind: 'none' };
  }

  const code = crypto.randomInt(100000, 1000000).toString();
  await saveState(input.workspaceId, input.conversationId, {
    status: 'awaiting_code',
    email,
    code_hash: hashCode(input.conversationId, code),
    attempts: 0,
    codes_sent: (row.codes_sent || 0) + 1,
    last_sent_at: new Date().toISOString(),
    code_expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    pending_question: row.pending_question,
    pending_sub_agent: row.pending_sub_agent || subAgent,
  });

  const { data: ws } = await serviceClient().from('workspaces').select('name, brand_color, logo_url').eq('id', input.workspaceId).maybeSingle();
  const brand = (ws?.name as string | undefined)?.trim() || input.brand;
  const { html, text } = renderEmail({
    brandName: brand,
    brandColor: (ws?.brand_color as string | null) ?? null,
    logoUrl: (ws?.logo_url as string | null) ?? null,
    preheader: `Your ${brand} chat verification code is ${code}. It expires in 10 minutes.`,
    title: 'Confirm it is you',
    paragraphs: [`Type this code in your chat with ${brand} so we can look up your account.`],
    code,
    afterButton: 'The code expires in 10 minutes and works once. Never share it with anyone else.',
    footer: `You received this because someone asked ${brand} support to look up the account for this address. If that was not you, ignore this email: nothing is shown without the code.`,
  });
  const sent = await sendSmtpEmail(smtp.smtp, {
    to: email,
    subject: `${code} is your ${brand} verification code`,
    html,
    text,
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Zentry-Mail': 'trader-verification' },
  });
  if (!sent.success) {
    console.error('[Trader Data] Verification email failed:', sent.error);
    await saveState(input.workspaceId, input.conversationId, { status: 'awaiting_email', code_hash: null });
    logVerification(input, 'send_failed');
    return { kind: 'none' };
  }
  logVerification(input, 'code_sent');
  return { kind: 'reply', text: verificationText.codeSent(input.lang, email), subAgent };
}
