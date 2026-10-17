import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Channel credentials (access tokens, app secrets, webhook verify tokens) are
 * encrypted before they reach the database, so a leaked backup, a stray
 * service-role query or a mistaken policy shows ciphertext, not a token that
 * can message a company's customers.
 *
 * AES-256-GCM with a 32-byte key from CHANNEL_ENCRYPTION_KEY (base64 or hex).
 * Output: "v1:<iv>:<tag>:<ciphertext>", each part base64. The version prefix
 * leaves room to rotate the scheme without guessing what old rows hold.
 */

const VERSION = 'v1';

export class ChannelCryptoError extends Error {}

export function parseKey(raw: string | undefined): Buffer {
  const value = (raw || '').trim();
  if (!value) {
    throw new ChannelCryptoError('CHANNEL_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.');
  }
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new ChannelCryptoError('CHANNEL_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex characters).');
  }
  return key;
}

export function hasEncryptionKey(): boolean {
  try {
    parseKey(process.env.CHANNEL_ENCRYPTION_KEY);
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plain: unknown, rawKey = process.env.CHANNEL_ENCRYPTION_KEY): string {
  const key = parseKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret<T = unknown>(payload: string, rawKey = process.env.CHANNEL_ENCRYPTION_KEY): T {
  const key = parseKey(rawKey);
  const [version, iv, tag, data] = (payload || '').split(':');
  if (version !== VERSION || !iv || !tag || data === undefined) {
    throw new ChannelCryptoError('Unrecognised secret format.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  } catch {
    // Wrong key or tampered ciphertext: GCM refuses both, and so do we.
    throw new ChannelCryptoError('Could not decrypt channel credentials. Was CHANNEL_ENCRYPTION_KEY changed?');
  }
}

/** A random token for webhook verification handshakes. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
