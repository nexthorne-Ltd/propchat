/**
 * POST /api/v1/conversations — start a conversation for one of your users.
 *
 *   { "visitor": { "external_id": "user-42", "name": "Sara", "email": "sara@example.com" },
 *     "message": "How do I reset my password?",      // optional first message
 *     "metadata": { "plan": "pro" },                 // optional, shown to agents
 *     "wait_for_reply": true }                        // default true
 *
 * Returns the conversation, the first message and the bot's reply to it.
 * See docs/API.md.
 */
import {
  apiJson,
  ApiInputError,
  conversationState,
  createApiConversation,
  findOrCreateVisitor,
  messageContent,
  readJson,
  sendCustomerMessage,
  visitorInput,
  withApiCaller,
} from '@/lib/api/chat';

export const maxDuration = 60;

export async function POST(req: Request) {
  return withApiCaller(req, async (caller) => {
    const body = await readJson(req);
    const visitor = visitorInput(body.visitor);
    const first = body.message === undefined || body.message === null ? null : messageContent(body.message);
    const metadata = body.metadata ?? {};
    if (typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 2000) {
      throw new ApiInputError('invalid_field', '"metadata" must be an object of at most 2000 characters as JSON.');
    }

    const visitorId = await findOrCreateVisitor(caller.workspaceId, visitor);
    const conv = await createApiConversation(caller, visitorId, { integration_metadata: metadata });
    const sent = first ? await sendCustomerMessage(caller, conv, first, body.wait_for_reply !== false) : null;

    return apiJson(
      {
        conversation: conversationState(conv),
        visitor_id: visitorId,
        message: sent?.message ?? null,
        replies: sent?.replies ?? [],
        bot: sent?.bot ?? null,
      },
      201
    );
  });
}
