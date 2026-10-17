import { updateTag } from 'next/cache';
import { HELP_KEYS_TAG, helpTag } from '@/lib/help/tags';

/**
 * Drops a workspace's cached help center (src/lib/help/data.ts) so the next
 * visitor sees an edit at once. Call it after the write succeeds, from a
 * Server Action. updateTag works only there; anywhere else the cache simply
 * expires on its own within minutes, which is fine, so failures are logged.
 */
export function refreshHelpCenter(workspaceId: string) {
  try {
    updateTag(helpTag(workspaceId));
  } catch (err) {
    console.warn('[Help Cache] refresh skipped:', err);
  }
}

/** After a slug or custom domain change: addresses map to workspaces anew. */
export function refreshHelpAddresses(workspaceId: string) {
  refreshHelpCenter(workspaceId);
  try {
    updateTag(HELP_KEYS_TAG);
  } catch (err) {
    console.warn('[Help Cache] address refresh skipped:', err);
  }
}
