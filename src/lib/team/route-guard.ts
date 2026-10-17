/**
 * Role checks for API routes called from the dashboard. Each returns the
 * caller's own Supabase session (so row level security and the database's
 * permission triggers apply too) or the response to send back.
 */
import { NextResponse } from 'next/server';
import { AccessError, getWorkspaceAccess, type WorkspaceAccess } from './access';
import type { Capability } from './permissions';
import { sessionUser } from '@/lib/supabase/session-user';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Guarded = { ok: true; access: WorkspaceAccess } | { ok: false; response: NextResponse };

function refusal(err: unknown): NextResponse {
  if (err instanceof AccessError) return NextResponse.json({ error: err.message }, { status: err.status });
  return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
}

export async function guardWorkspace(workspaceId: unknown, capability: Capability): Promise<Guarded> {
  try {
    return { ok: true, access: await getWorkspaceAccess(String(workspaceId ?? ''), capability) };
  } catch (err) {
    return { ok: false, response: refusal(err) };
  }
}

/**
 * Checks the caller's role in the workspace the conversation belongs to.
 * Conversations the caller cannot see are reported as not found.
 */
export async function guardConversation(
  conversationId: unknown,
  capability: Capability
): Promise<(Guarded & { ok: true; workspaceId: string }) | { ok: false; response: NextResponse }> {
  const id = String(conversationId ?? '');
  if (!UUID.test(id)) return { ok: false, response: NextResponse.json({ error: 'Conversation not found' }, { status: 404 }) };
  // Look the workspace up through the caller's session: RLS hides other workspaces' rows.
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  const user = await sessionUser(supabase);
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized: sign in again.' }, { status: 401 }) };
  const { data: conv } = await supabase.from('conversations').select('workspace_id').eq('id', id).maybeSingle();
  if (!conv?.workspace_id) return { ok: false, response: NextResponse.json({ error: 'Conversation not found' }, { status: 404 }) };
  const guarded = await guardWorkspace(conv.workspace_id, capability);
  return guarded.ok ? { ok: true, access: guarded.access, workspaceId: conv.workspace_id as string } : guarded;
}

/**
 * For routes that are not about one workspace's data (translate a snippet,
 * test SMTP settings): the caller must be an active member of the workspace
 * they work in, with `capability` there.
 */
export async function guardMember(capability: Capability): Promise<Guarded> {
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  const user = await sessionUser(supabase);
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized: sign in again.' }, { status: 401 }) };
  const [{ data: agent }, { data: owned }] = await Promise.all([
    supabase.from('agents').select('workspace_id').eq('id', user.id).maybeSingle(),
    supabase.from('workspaces').select('id').eq('owner_id', user.id).limit(1).maybeSingle(),
  ]);
  const workspaceId = agent?.workspace_id ?? owned?.id;
  if (!workspaceId) return { ok: false, response: NextResponse.json({ error: 'Forbidden: this workspace is not yours.' }, { status: 403 }) };
  return guardWorkspace(workspaceId, capability);
}
