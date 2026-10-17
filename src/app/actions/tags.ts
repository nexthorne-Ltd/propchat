'use server';

import { getWorkspaceAccess } from '@/lib/team/access';
import { userError } from '@/lib/errors/user-error';

/**
 * Settings → Tickets → Tags. Tags are text on each ticket (synced to the
 * conversation by the ticketing triggers); these list, rename/merge and
 * delete them through database functions that check the caller's role
 * (migration 20261105090000). Closed tickets keep their tags: they are
 * read-only history.
 */

export interface WorkspaceTag {
  tag: string;
  tickets: number;
  open_tickets: number;
  last_used: string | null;
}

const MAX_TAG = 50;

export async function listTagsAction(workspaceId: string): Promise<WorkspaceTag[]> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'view');
  const { data, error } = await supabase.rpc('fn_workspace_tags', { p_workspace_id: workspaceId });
  if (error) throw userError(error.message);
  return (data as WorkspaceTag[]) || [];
}

/** Renames a tag; if the new name already exists the two are merged. */
export async function renameTagAction(workspaceId: string, from: string, to: string): Promise<{ changed: number }> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const next = (to || '').trim();
  if (!next) throw userError('Enter the new tag name.');
  if (next.length > MAX_TAG) throw userError(`A tag can be at most ${MAX_TAG} characters.`);
  const { data, error } = await supabase.rpc('fn_rename_tag', { p_workspace_id: workspaceId, p_from: from, p_to: next });
  if (error) throw userError(error.message);
  return { changed: Number(data) || 0 };
}

export async function deleteTagAction(workspaceId: string, tag: string): Promise<{ changed: number }> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  const { data, error } = await supabase.rpc('fn_delete_tag', { p_workspace_id: workspaceId, p_tag: tag });
  if (error) throw userError(error.message);
  return { changed: Number(data) || 0 };
}
