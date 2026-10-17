# Zentry Chat API (v1)

Put Zentry's chat, with the AI bot and your team behind it, inside any system: a mobile app, a CRM, a WhatsApp gateway of your own, a backend that relays messages. Conversations started through the API appear in the inbox like any other chat; the bot answers them with the same rules as the widget (help center answers, handover to a person, the bot stays quiet once a person takes over).

Base URL: `https://zen-try.site/api/v1`

## Authentication

Create a key in **Settings → API & webhooks → API keys**. It is shown once. Send it on every request:

```
Authorization: Bearer zk_live_...
```

(`X-Api-Key: zk_live_...` works too.) Call the API **from your server only**. A key inside a web page or a mobile app can be read by anyone; the API sends no CORS headers for that reason. Create one key per system, so you can revoke one without breaking the others.

A key acts for its workspace only, and only on conversations it started through the API.

## Endpoints

### Start a conversation

`POST /conversations`

```json
{
  "visitor": { "external_id": "user-42", "name": "Sara", "email": "sara@example.com" },
  "message": "How do I reset my password?",
  "metadata": { "plan": "pro" },
  "wait_for_reply": true
}
```

| Field | | |
|---|---|---|
| `visitor.external_id` | optional | Your id for the user. The same id finds the same visitor again, so the inbox shows one person with their history. |
| `visitor.name`, `visitor.email` | optional | Shown to agents. |
| `message` | optional | The first message. Up to 4000 characters. |
| `metadata` | optional | Any JSON object up to 2000 characters, kept with the conversation. |
| `wait_for_reply` | default `true` | Wait for the bot (usually 3–15 s) and return its reply. `false` returns at once; read the reply later. |

Response `201`:

```json
{
  "conversation": { "id": "…", "status": "open", "answered_by": "bot", "ai_paused_reason": null, "created_at": "…" },
  "visitor_id": "…",
  "message": { "id": "…", "role": "customer", "content": "How do I reset my password?", "attachment_url": null, "created_at": "…" },
  "replies": [{ "id": "…", "role": "bot", "content": "Open the login page and click \"Forgot password\"…", "attachment_url": null, "created_at": "…" }],
  "bot": { "replied": true, "reason": null }
}
```

### Send a message

`POST /conversations/{id}/messages`

```json
{ "content": "It still doesn't work", "wait_for_reply": true }
```

Returns the stored `message`, the `replies` that followed it, and the conversation's current state. When a person has taken the conversation over, `replies` is empty, `answered_by` is `"team"`, and `bot.reason` says why the bot stayed quiet.

### Read messages

`GET /conversations/{id}/messages?after={message_id}&limit=50`

Public messages, oldest first (`limit` up to 100). Agents answer in their own time, so poll with `after` set to the last message id you have, for example every 5–10 seconds while the user has the chat open. Internal notes are never returned.

### Conversation state

`GET /conversations/{id}` → `{ "conversation": { "id", "status", "answered_by", "ai_paused_reason", "created_at" } }`

## Message roles

| `role` | Who wrote it |
|---|---|
| `customer` | Your user (through the API or the widget) |
| `bot` | The AI assistant, or an automatic welcome line |
| `agent` | A person on your team |
| `system` | A status notice, such as "We've passed this to our team." |

## Errors

Errors are JSON: `{ "error": { "code": "…", "message": "…" } }`.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_json`, `invalid_content`, `content_too_long`, `invalid_field`, `invalid_cursor` | Fix the request. |
| 401 | `unauthorized` | Missing, malformed, unknown or revoked key. |
| 404 | `not_found` | No such conversation for this key. |
| 429 | `plan_limit_reached` | The plan's monthly API request limit is used up. |
| 500 | `internal_error` | Try again; details are in Zentry's logs, not the response. |

## Example (Node.js)

```js
const API = 'https://zen-try.site/api/v1';
const headers = { Authorization: `Bearer ${process.env.ZENTRY_API_KEY}`, 'Content-Type': 'application/json' };

const start = await fetch(`${API}/conversations`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ visitor: { external_id: 'user-42', name: 'Sara' }, message: 'What is your refund policy?' }),
}).then((r) => r.json());

console.log(start.replies.map((m) => m.content));

// Later: anything new, such as an agent's reply.
const lastId = start.replies.at(-1)?.id ?? start.message.id;
const { messages } = await fetch(`${API}/conversations/${start.conversation.id}/messages?after=${lastId}`, { headers }).then((r) => r.json());
```


## Webhooks

Settings → API & webhooks → Webhooks sends events to your own https endpoint as they happen (within about two minutes; failed deliveries are retried up to five times with growing gaps).

Events: `ticket.created`, `ticket.updated` (status, priority, assignee, group, tags, subject, type or custom fields changed), `ticket.solved`, `message.created` (public messages only; internal notes are never sent). "Send test" posts a `ping` event.

Each delivery is a `POST` with a JSON body:

```json
{
  "id": "5f0c…",
  "event": "ticket.updated",
  "workspace_id": "…",
  "occurred_at": "2026-10-13T09:30:00Z",
  "ticket": { "id": "…", "number": 1042, "subject": "…", "status": "open", "priority": "high", "tags": ["billing"], "custom_fields": { "order_number": "A-118" }, "…": "…" },
  "previous": { "status": "new", "priority": "normal", "assignee_id": null, "tags": [] }
}
```

`message.created` carries `message` (`id`, `conversation_id`, `ticket_id`, `sender_type`, `content`, `attachment_url`, `created_at`) instead of `previous`.

Headers: `X-Zentry-Event` (the event) and `X-Zentry-Signature: sha256=<hex>`, the HMAC-SHA256 of the **raw** request body keyed with the webhook's signing secret. Check it before trusting the body:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return header && header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

Answer with any 2xx status. Use the `id` to ignore a delivery you have already handled (a retry after a timeout can arrive twice).
