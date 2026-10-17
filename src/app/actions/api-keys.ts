'use server';

/**
 * API keys for the public chat API (/api/v1), from Settings → API.
 *
 * The table has no write policies (migration 20261101090000): a key is created
 * and revoked here, with the service role, after assertAdminUser has checked
 * manage_settings on this workspace. The full key is returned once, from
 * createApiKeyAction; only its hash is stored.
 */
import { assertAdminUser } from '@/app/actions/admin';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { generateApiKey } from '@/lib/api/keys';

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const COLUMNS = 'id, name, key_prefix, created_at, last_used_at, revoked_at';
const MAX_ACTIVE_KEYS = 20;

export async function listApiKeysAction(workspaceId: string): Promise<{ success: true; keys: ApiKeyRow[] } | { success: false; error: string }> {
  await assertAdminUser(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('workspace_api_keys')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[API Keys] List failed:', error.message);
    return { success: false, error: 'Could not load API keys.' };
  }
  return { success: true, keys: (data || []) as ApiKeyRow[] };
}

export async function createApiKeyAction(
  workspaceId: string,
  name: string
): Promise<{ success: true; key: string; row: ApiKeyRow } | { success: false; error: string }> {
  const { user } = await assertAdminUser(workspaceId);
  const label = (name || '').trim();
  if (!label || label.length > 80) return { success: false, error: 'Give the key a name of up to 80 characters.' };

  const admin = serviceClient();
  const { count, error: countErr } = await admin
    .from('workspace_api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .is('revoked_at', null);
  if (countErr) {
    console.error('[API Keys] Count failed:', countErr.message);
    return { success: false, error: 'Could not create the key.' };
  }
  if ((count ?? 0) >= MAX_ACTIVE_KEYS) {
    return { success: false, error: `A workspace can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.` };
  }

  const generated = generateApiKey();
  const { data, error } = await admin
    .from('workspace_api_keys')
    .insert({ workspace_id: workspaceId, name: label, key_prefix: generated.prefix, key_hash: generated.hash, created_by: user.id })
    .select(COLUMNS)
    .single();
  if (error || !data) {
    console.error('[API Keys] Create failed:', error?.message);
    return { success: false, error: 'Could not create the key.' };
  }
  return { success: true, key: generated.key, row: data as ApiKeyRow };
}

export async function revokeApiKeyAction(workspaceId: string, keyId: string): Promise<{ success: true } | { success: false; error: string }> {
  await assertAdminUser(workspaceId);
  const { data, error } = await serviceClient()
    .from('workspace_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)
    .is('revoked_at', null)
    .select('id');
  if (error) {
    console.error('[API Keys] Revoke failed:', error.message);
    return { success: false, error: 'Could not revoke the key.' };
  }
  if (!data?.length) return { success: false, error: 'Key not found or already revoked.' };
  return { success: true };
}
