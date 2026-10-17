/**
 * GET  /api/v1/conversations/{id}/messages?after={message_id}&limit=50
 *      Public messages, oldest first. Poll with `after` set to the last id you
 *      have to receive agent replies that come later.
 *
 * POST /api/v1/conversations/{id}/messages
 *      { "content": "...", "wait_for_reply": true }
 *      Sends the customer's message; returns it and the bot's reply.
 *
 * See docs/API.md.
 */
import {
  apiError,
  apiJson,
  conversationState,
  listMessages,
  loadApiConversation,
  messageContent,
  readJson,
  sendCustomerMessage,
  withApiCaller,
} from '@/lib/api/chat';

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return withApiCaller(req, async (caller) => {
    const conv = await loadApiConversation(caller, id);
    if (!conv) return apiError(404, 'not_found', 'Conversation not found.');
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') || 50);
    const messages = await listMessages(conv.id, {
      after: url.searchParams.get('after'),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return apiJson({ conversation: conversationState(conv), messages });
  });
}

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return withApiCaller(req, async (caller) => {
    const conv = await loadApiConversation(caller, id);
    if (!conv) return apiError(404, 'not_found', 'Conversation not found.');
    const body = await readJson(req);
    const content = messageContent(body.content);
    const sent = await sendCustomerMessage(caller, conv, content, body.wait_for_reply !== false);
    const fresh = (await loadApiConversation(caller, conv.id)) ?? conv;
    return apiJson({ conversation: conversationState(fresh), ...sent }, 201);
  });
}
