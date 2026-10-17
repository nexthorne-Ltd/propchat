import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs every webhook POST (WhatsApp now, Instagram and Messenger later)
 * with HMAC-SHA256 of the raw body, keyed by the app secret, in
 * `X-Hub-Signature-256: sha256=<hex>`. Anything unsigned or mis-signed is
 * someone else talking, so it is dropped before a byte of it is parsed.
 */
export function verifyMetaSignature(rawBody: string, header: string | null | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signMetaPayload(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
}

/** Constant-time string comparison for verify tokens. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a || '', 'utf8');
  const y = Buffer.from(b || '', 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
