/**
 * GET /api/v1/conversations/{id} — the conversation's status and who is
 * answering it (the bot, or the team after a handover). See docs/API.md.
 */
import { apiError, apiJson, conversationState, loadApiConversation, withApiCaller } from '@/lib/api/chat';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return withApiCaller(req, async (caller) => {
    const conv = await loadApiConversation(caller, id);
    if (!conv) return apiError(404, 'not_found', 'Conversation not found.');
    return apiJson({ conversation: conversationState(conv) });
  });
}
