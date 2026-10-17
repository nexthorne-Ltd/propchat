/**
 * Workspace API keys for the public chat API (/api/v1).
 *
 * A key is `zk_live_` plus 32 random bytes. Only its SHA-256 hash is stored
 * (migration 20261101090000), so the database never holds a working key;
 * the key itself is shown once, when it is created. Lookups hash the
 * presented key and compare hashes, which are fixed-length, so a lookup by
 * hash leaks nothing useful about how close a guess was.
 */
import { createHash, randomBytes } from 'node:crypto';
import { serviceClient } from '@/lib/supabase/service';

const KEY_PREFIX = 'zk_live_';
const KEY_SHAPE = /^zk_live_[A-Za-z0-9_-]{43}$/;

export interface NewApiKey {
  /** The full key. Show it once; it cannot be recovered later. */
  key: string;
  /** What the settings list shows, e.g. "zk_live_Ab3d…". */
  prefix: string;
  hash: string;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): NewApiKey {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, KEY_PREFIX.length + 4), hash: hashApiKey(key) };
}

/** `Authorization: Bearer <key>`, or `X-Api-Key: <key>`. */
export function apiKeyFrom(req: Request): string | null {
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.match(/^Bearer\s+(\S+)$/i)?.[1];
  const key = (bearer || req.headers.get('x-api-key') || '').trim();
  return KEY_SHAPE.test(key) ? key : null;
}

export interface ApiCaller {
  keyId: string;
  workspaceId: string;
}

/**
 * The workspace a request acts for, or null for a missing, malformed,
 * unknown or revoked key.
 */
export async function authenticateApiKey(req: Request): Promise<ApiCaller | null> {
  const key = apiKeyFrom(req);
  if (!key) return null;
  const supabase = serviceClient();
  const { data, error } = await supabase
    .from('workspace_api_keys')
    .select('id, workspace_id, revoked_at, last_used_at')
    .eq('key_hash', hashApiKey(key))
    .maybeSingle();
  if (error) {
    console.error('[API Keys] Key lookup failed:', error.message);
    return null;
  }
  if (!data || data.revoked_at) return null;

  // At most one write a minute per key: "last used" is for people, not audit.
  const lastUsed = data.last_used_at ? Date.parse(data.last_used_at) : 0;
  if (Date.now() - lastUsed > 60_000) {
    supabase
      .from('workspace_api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(({ error: touchErr }) => {
        if (touchErr) console.warn('[API Keys] Could not record last use:', touchErr.message);
      });
  }
  return { keyId: data.id, workspaceId: data.workspace_id };
}
