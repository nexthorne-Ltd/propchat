import type {
  ChannelAdapter,
  ChannelContext,
  MessageTemplate,
  OutboundContent,
  OutboundMedia,
  SendResult,
} from '@/lib/channels/types';
import { safeEqual, verifyMetaSignature } from '@/lib/channels/meta-signature';
import { GraphError, graphRequest } from './graph';
import { parseWhatsAppWebhook } from './webhook';
import { templateParamCount } from '@/lib/channels/templates';
import { userError } from '@/lib/errors/user-error';

export { renderTemplate, templateParamCount } from '@/lib/channels/templates';

/**
 * WhatsApp through Meta's official WhatsApp Business Cloud API.
 *
 * Two ways in, same adapter:
 *   - Embedded Signup: the customer logs in with Facebook inside Zentry; the
 *     platform's Meta app (META_APP_ID / META_APP_SECRET) receives the
 *     webhooks at /api/channels/whatsapp/webhook.
 *   - Manual setup: the customer pastes a permanent system-user token from
 *     their own Meta app; their app secret and a generated verify token are
 *     stored with the connection, and their webhook URL carries its id.
 */

export interface WhatsAppCredentials {
  accessToken: string;
  /** The Meta app secret that signs this connection's webhooks. Unset: the platform app (META_APP_SECRET). */
  appSecret?: string;
  /** Manual setup: the token Meta echoes during the webhook handshake. */
  verifyToken?: string;
}

export interface WhatsAppConnectInput {
  phoneNumberId: string;
  wabaId: string;
}

type Ctx = ChannelContext<WhatsAppCredentials>;

interface SendResponse {
  messages?: { id: string }[];
}

const ID = /^\d{5,25}$/;

/** WhatsApp wants international numbers without "+", spaces or dashes. */
export function normalizePhone(raw: string): string {
  return (raw || '').replace(/[^\d]/g, '');
}

export function buildTextPayload(to: string, content: OutboundContent): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: normalizePhone(to) };
  if (content.type === 'template') {
    const params = content.template.bodyParams || [];
    return {
      ...base,
      type: 'template',
      template: {
        name: content.template.name,
        language: { code: content.template.language },
        ...(params.length
          ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] }
          : {}),
      },
    };
  }
  return {
    ...base,
    type: 'text',
    text: { body: content.text.slice(0, 4096), preview_url: /https?:\/\//.test(content.text) },
    ...(content.replyToExternalId ? { context: { message_id: content.replyToExternalId } } : {}),
  };
}

export function buildMediaPayload(to: string, media: OutboundMedia): Record<string, unknown> {
  const object: Record<string, string> = { link: media.url };
  // Audio carries no caption on WhatsApp; documents keep their file name.
  if (media.caption && media.kind !== 'audio') object.caption = media.caption.slice(0, 1024);
  if (media.kind === 'document' && media.filename) object.filename = media.filename;
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: normalizePhone(to), type: media.kind, [media.kind]: object };
}

async function send(ctx: Ctx, payload: Record<string, unknown>): Promise<SendResult> {
  const phoneNumberId = ctx.connection.external_account_id;
  if (!phoneNumberId) return { ok: false, error: 'WhatsApp is not connected.', retryable: false, needsAttention: true };
  try {
    const res = await graphRequest<SendResponse>(ctx.credentials.accessToken, `${phoneNumberId}/messages`, {
      method: 'POST',
      body: payload,
    });
    const id = res.messages?.[0]?.id;
    if (!id) return { ok: false, error: 'WhatsApp accepted the request but returned no message id.', retryable: true };
    return { ok: true, providerMessageId: id };
  } catch (err) {
    if (err instanceof GraphError) {
      const f = err.failure;
      return { ok: false, error: f.error, retryable: f.retryable, needsAttention: f.needsAttention, windowClosed: f.windowClosed };
    }
    return { ok: false, error: (err as Error).message || 'Could not send.', retryable: true };
  }
}

interface PhoneNumberInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  name_status?: string;
}

interface TemplateRow {
  name: string;
  language: string;
  status: string;
  category: string;
  components?: { type: string; text?: string }[];
}

export const whatsappAdapter: ChannelAdapter<WhatsAppCredentials, WhatsAppConnectInput> = {
  id: 'whatsapp',
  label: 'WhatsApp',
  capabilities: { media: true, templates: true, readReceipts: true, serviceWindowHours: 24 },

  async connect(input, credentials) {
    const phoneNumberId = (input.phoneNumberId || '').trim();
    const wabaId = (input.wabaId || '').trim();
    if (!ID.test(phoneNumberId)) throw userError('The phone number ID is the long number under WhatsApp → API Setup, not the phone number itself.');
    if (!ID.test(wabaId)) throw userError('The WhatsApp Business Account ID is a long number under WhatsApp → API Setup.');
    if (!credentials.accessToken?.trim()) throw userError('Paste an access token.');

    const token = credentials.accessToken.trim();
    const phone = await graphRequest<PhoneNumberInfo>(token, phoneNumberId, {
      query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status' },
    });
    const numbers = await graphRequest<{ data?: { id: string }[] }>(token, `${wabaId}/phone_numbers`, { query: { fields: 'id', limit: '100' } });
    if (!numbers.data?.some((n) => n.id === phoneNumberId)) {
      throw userError('That phone number does not belong to this WhatsApp Business Account.');
    }
    // Without this subscription Meta sends this account's webhooks nowhere.
    await graphRequest(token, `${wabaId}/subscribed_apps`, { method: 'POST' });

    return {
      externalAccountId: phoneNumberId,
      externalBusinessId: wabaId,
      displayName: [phone.display_phone_number, phone.verified_name].filter(Boolean).join(' · ') || phoneNumberId,
      settings: {
        verified_name: phone.verified_name || null,
        display_phone_number: phone.display_phone_number || null,
        quality_rating: phone.quality_rating || null,
        name_status: phone.name_status || null,
      },
    };
  },

  verifyWebhookChallenge(query, expectedToken) {
    const challenge = query.get('hub.challenge');
    if (query.get('hub.mode') !== 'subscribe' || !challenge) return null;
    return safeEqual(query.get('hub.verify_token') || '', expectedToken) ? challenge : null;
  },

  verifyWebhookSignature(req, secret) {
    return verifyMetaSignature(req.rawBody, req.headers.get('x-hub-signature-256'), secret);
  },

  parseWebhook: parseWhatsAppWebhook,

  sendMessage(ctx, to, content) {
    return send(ctx, buildTextPayload(to, content));
  },

  sendMedia(ctx, to, media) {
    return send(ctx, buildMediaPayload(to, media));
  },

  async markRead(ctx, externalId) {
    if (!ctx.connection.external_account_id) return;
    await graphRequest(ctx.credentials.accessToken, `${ctx.connection.external_account_id}/messages`, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', status: 'read', message_id: externalId },
    }).catch((err) => console.warn('[WhatsApp] Could not mark read:', (err as Error).message));
  },

  async downloadMedia(ctx, mediaId) {
    const meta = await graphRequest<{ url?: string; mime_type?: string }>(ctx.credentials.accessToken, mediaId);
    if (!meta.url) throw userError('WhatsApp returned no download URL for this media.');
    const res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw userError(`Media download failed with HTTP ${res.status}.`);
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type || res.headers.get('content-type') || 'application/octet-stream' };
  },

  async listTemplates(ctx) {
    const wabaId = ctx.connection.external_business_id;
    if (!wabaId) return [];
    const res = await graphRequest<{ data?: TemplateRow[] }>(ctx.credentials.accessToken, `${wabaId}/message_templates`, {
      query: { fields: 'name,language,status,category,components', limit: '200' },
    });
    return (res.data || [])
      .filter((t) => t.status === 'APPROVED')
      .map<MessageTemplate>((t) => {
        const body = t.components?.find((c) => c.type === 'BODY')?.text || '';
        return { name: t.name, language: t.language, category: t.category, status: t.status, body, paramCount: templateParamCount(body) };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
  },

  async disconnect(ctx) {
    if (!ctx.connection.external_business_id) return;
    await graphRequest(ctx.credentials.accessToken, `${ctx.connection.external_business_id}/subscribed_apps`, { method: 'DELETE' });
  },
};
