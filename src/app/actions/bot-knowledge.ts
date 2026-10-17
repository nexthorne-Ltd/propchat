'use server';

import { createClient } from '@/lib/supabase/server';
import { getWorkspaceAccess } from '@/lib/team/access';
import { invalidateHelpIndex } from '@/lib/ai/help-answer';
import { describeEmbeddingProvider } from '@/lib/ai/semantic-retrieval';
import { embedBotKnowledge, type BotKnowledgeEmbedResult } from '@/lib/ai/bot-knowledge';
import type { BotKnowledge } from '@/types/database';
import { userError } from '@/lib/errors/user-error';

/**
 * Bot knowledge (Help Center → Bot knowledge): material the bot answers from
 * that is not published to the help centre. Entries are written through the
 * cookie session, so RLS and the content-role trigger apply; embedding runs
 * with the service role after the same membership check.
 */

const MAX_TITLE = 200;
const MAX_CONTENT = 100_000;
/** Kept small so one call finishes well inside a serverless time limit. */
const EMBED_BATCH_LIMIT = 5;

export type BotKnowledgeListItem = Omit<BotKnowledge, 'content'>;

export interface BotKnowledgeList {
  embeddings: { available: boolean; provider: string | null };
  entries: BotKnowledgeListItem[];
}

const LIST_COLUMNS =
  'id, workspace_id, title, status, content_version, chunk_count, embedded_count, last_error, embedded_at, created_by, updated_by, created_at, updated_at';

/** Entries without their text (that can be long); the editor loads one in full. */
export async function listBotKnowledgeAction(workspaceId: string): Promise<BotKnowledgeList> {
  await getWorkspaceAccess(workspaceId, 'view');
  const supabase = await createClient();
  const [{ data, error }, embeddings] = await Promise.all([
    supabase
      .from('bot_knowledge')
      .select(LIST_COLUMNS)
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false }),
    describeEmbeddingProvider(),
  ]);
  if (error) throw userError(error.message);
  return { embeddings, entries: (data as BotKnowledgeListItem[]) || [] };
}

export async function getBotKnowledgeAction(workspaceId: string, id: string): Promise<BotKnowledge> {
  await getWorkspaceAccess(workspaceId, 'view');
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('bot_knowledge')
    .select('*')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw userError(error.message);
  if (!data) throw userError('This entry no longer exists.');
  return data as BotKnowledge;
}

/**
 * Creates or updates an entry. Changing the text puts it back to pending (a
 * database trigger does this and drops the old chunks), so the bot stops
 * using it until embeddings are generated again.
 */
export async function saveBotKnowledgeAction(
  workspaceId: string,
  input: { id?: string | null; title: string; content: string }
): Promise<{ success: true; entry: BotKnowledge } | { success: false; error: string }> {
  await getWorkspaceAccess(workspaceId, 'edit_content');
  const title = (input.title || '').trim();
  const content = (input.content || '').replace(/\r\n/g, '\n').trim();
  if (!title) return { success: false, error: 'Give the entry a title.' };
  if (title.length > MAX_TITLE) return { success: false, error: `The title can be at most ${MAX_TITLE} characters.` };
  if (!content) return { success: false, error: 'Add the information the bot should know.' };
  if (content.length > MAX_CONTENT) {
    return { success: false, error: `One entry can hold at most ${MAX_CONTENT.toLocaleString()} characters. Split it into several entries.` };
  }

  const supabase = await createClient();
  const query = input.id
    ? supabase.from('bot_knowledge').update({ title, content }).eq('id', input.id).eq('workspace_id', workspaceId)
    : supabase.from('bot_knowledge').insert({ workspace_id: workspaceId, title, content });
  const { data, error } = await query.select('*').single();
  if (error) {
    console.error('[Bot Knowledge] Save failed:', error);
    return { success: false, error: error.message };
  }

  invalidateHelpIndex(workspaceId);
  return { success: true, entry: data as BotKnowledge };
}

export async function deleteBotKnowledgeAction(workspaceId: string, id: string): Promise<{ success: true }> {
  await getWorkspaceAccess(workspaceId, 'edit_content');
  const supabase = await createClient();
  const { error } = await supabase.from('bot_knowledge').delete().eq('id', id).eq('workspace_id', workspaceId);
  if (error) throw userError(error.message);
  invalidateHelpIndex(workspaceId);
  return { success: true };
}

/**
 * Generates embeddings for a few entries. The Help Center calls this with
 * the next batch until every pending entry is done, so a long list never
 * runs into a time limit and one failure does not stop the rest.
 */
export async function embedBotKnowledgeBatchAction(
  workspaceId: string,
  ids: string[]
): Promise<{ results: BotKnowledgeEmbedResult[] }> {
  await getWorkspaceAccess(workspaceId, 'edit_content');
  if (!Array.isArray(ids) || ids.length === 0) return { results: [] };
  if (ids.length > EMBED_BATCH_LIMIT) {
    throw userError(`At most ${EMBED_BATCH_LIMIT} entries can be embedded per request.`);
  }

  // embedBotKnowledge reads each entry scoped to this workspace, so an id
  // from another workspace is treated as missing and changes nothing.
  const results: BotKnowledgeEmbedResult[] = [];
  for (const id of ids) {
    results.push(await embedBotKnowledge(workspaceId, String(id)));
  }
  if (results.some((r) => r.status === 'ready')) invalidateHelpIndex(workspaceId);
  return { results };
}
