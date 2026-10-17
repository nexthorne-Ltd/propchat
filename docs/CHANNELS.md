# Social channels: X, Threads, LinkedIn, TikTok

What Zentry can and cannot do on each platform, what it costs or needs, and how to set it up. Everything here uses **official APIs only**: no scraping, no browser automation, no unofficial endpoints.

Code: `src/lib/channels/{x,threads,linkedin,tiktok}/`, the card text in `src/lib/channels/social-info.ts` (the Settings → Channels page and this file say the same things), the database changes in `supabase/migrations/20261017090000_social_channels.sql`.

> **How this was checked, and what is not verified.** The platform documentation was last checked in **October 2026**. The sandbox this was written in could not open the platforms' documentation sites directly (outbound access to them is blocked), so the facts below come from search results that quote the official pages, cross-checked against third-party integration guides. Each section lists what is **unverified**. Treat those lines as the first things to test, and platforms change pricing and access rules often: the linked official pages win over this file.

## At a glance

| | Direct messages | Mentions / replies / comments | Reply from a ticket | Access | Delivery |
|---|---|---|---|---|---|
| **X** | Yes (read and send) | Mentions and replies to your posts | DM: private. Post: **public** reply (280 chars) | **Paid** (credits) | Poll mentions every 2 min; DMs by webhook or optional slow poll |
| **Threads** | **No** (not in the API) | Replies to your posts; mentions (webhook only) | **Public** reply (500 chars) | Free, **Meta App Review** for production | Webhook; replies also polled every 5 min |
| **LinkedIn** | **No** (partners only) | Comments on your Page's posts | **Public** comment as the Page (1,250 chars) | **LinkedIn approval** (Community Management API) | Poll every 15 min |
| **TikTok** | **No** (not implemented) | Comments on your own videos | **Public** reply (150 chars) | **TikTok approval** | Signed webhook |

## How public items become tickets

- A public item (a post that mentions you, a reply, a comment) is stored through the same function as every other message (`fn_channel_ingest_inbound`). Its sender id is `pub:<author>`; a direct message's is the bare id. Because conversations are looked up by that sender, **a person's public posts and their DMs are separate tickets**, and a reply can never cross from one to the other.
- The item's details (kind, post, permalink) are stored in `messages.metadata.channel_public`. A reply is posted under the item the agent is answering: the newest public item from the customer.
- The ticket page says it plainly: a warning-coloured notice above the reply box reads **"Public reply on X: everyone can see it"**, names the item it will be posted under with a link, counts characters against the platform's limit, and the button reads **Post public reply**. Customers' public messages carry a "Public mention on X" chip; sent replies carry "Posted publicly". X direct messages say "Private message: only the customer can see your reply".
- Replies are text only. Nothing has a customer-service window, so the 24-hour rules of WhatsApp and Instagram do not apply.

## Delivery, de-duplication and secrets

- **Webhooks** are verified before a byte is parsed: X (`x-twitter-webhooks-signature`, HMAC-SHA256 base64 with the app's API secret, plus the CRC `GET` check), Threads (`X-Hub-Signature-256` and the `hub.challenge` handshake, like every Meta webhook), TikTok (`Tiktok-Signature: t=…,s=…`, HMAC-SHA256 of `<t>.<body>` with the client secret; requests older than 5 minutes are refused). LinkedIn's push notifications are not used (see below).
- **Polling** (`/api/cron/channel-poll`, every 5 minutes) asks each connection no more often than its channel allows: X 2 min, Threads 5 min, LinkedIn 15 min. A poll is claimed (`last_polled_at`) before the platform is called, so overlapping runs skip instead of doubling the calls; a platform rate limit is skipped quietly and the cursor stays put; "Check now" in settings is limited to once a minute.
- **De-duplication**: every item has a prefixed provider id (`x:tweet:…`, `x:dm:…`, `threads:…`, `linkedin:…`, `tiktok:…`); the database ignores an id it has already stored, so webhook retries, overlapping polls and a webhook plus a poll for the same item all collapse to one message.
- **Tokens** are encrypted with AES-256-GCM (`CHANNEL_ENCRYPTION_KEY`) in `channel_secrets`, one row per workspace connection, readable only by the service role. X's 2-hour access tokens are renewed just before use (the refresh token rotates and is stored); Threads and LinkedIn tokens are renewed by the daily channel cron.

---

## X

**Possible** (X API v2, OAuth 2.0 with PKCE; scopes `tweet.read tweet.write users.read dm.read dm.write offline.access`)
- Direct messages: read (`GET /2/dm_events`) and send (`POST /2/dm_conversations/with/:participant_id/messages`).
- Mentions of your account (`GET /2/users/:id/mentions`) and replies to your posts; reply with `POST /2/tweets` and `reply.in_reply_to_tweet_id`.
- Push: the Account Activity API (webhook with CRC + signature) delivers DMs, mentions and replies. Zentry parses its classic payload (`direct_message_events`, `tweet_create_events`). X's newer "X Activity API" uses a different envelope and is **not** parsed yet.

**Paid / needs approval**
- X sells API access by usage: you buy credits in the developer console and each request deducts from them (the free tier is gone for new developers; legacy fixed plans remain only for existing subscribers). Prices on X's pricing page at the time of checking: post read about $0.005 per post, post create $0.015 (more with a link), DM event read $0.010 per event, DM send $0.015 per request. Reads are billed per resource *returned*.
- Webhooks on the pay-per-use plan are limited (about 1 webhook and 3 subscriptions) and bill inbound DMs per event (about $0.010).
- Rate limits: creating posts 100 per 15 minutes per user; sending DMs 15 per 15 minutes and 1,440 per day.
- Zentry's cost choices: mentions are polled with `since_id`, so only new posts are returned and billed. **DM polling is off by default**, because each check returns (and bills) at least one event even when nobody wrote (it probes at most every 15 minutes, so about 96 events a day, roughly $1); use the webhook if your plan has it, or switch polling on knowing that cost.

**Not possible**
- No free tier. No replies with images or files from Zentry (the API supports media; Zentry sends text only). Posts longer than 280 characters are refused before sending.

**Unverified**
- The exact current prices and limits (they changed several times in 2026; third-party sources disagree). Whether X restricts programmatic replies to posts that engaged with your account: Zentry only ever replies to mentions and replies to your own account.
- The X Activity API (newer webhook) payloads, and whether webhook delivery works on every pay-per-use account (developer reports say it sometimes does not: test before relying on it).

**Official pages**: [pricing](https://docs.x.com/x-api/getting-started/pricing), [Account Activity API](https://docs.x.com/x-api/account-activity/introduction), [webhooks](https://docs.x.com/x-api/webhooks/introduction), [rate limits](https://docs.x.com/x-api/fundamentals/rate-limits).

## Threads

**Possible** (Threads API, `graph.threads.net`; scopes `threads_basic threads_read_replies threads_manage_replies threads_content_publish threads_manage_mentions`)
- Read replies to your own posts (`GET /{media-id}/replies`), and answer them by publishing a reply (`POST /{user}/threads` with `reply_to_id`, then `/threads_publish`). Reply management (hide, approve pending replies) exists; Zentry does not use it.
- Webhooks for `replies` and `mentions`, signed like every Meta webhook. Replies need `threads_read_replies`; mentions need `threads_manage_mentions`.
- Limit: 1,000 replies per account per rolling 24 hours.

**Paid / needs approval**
- The API is free. Your Meta app must pass **App Review** (Advanced Access) before anyone outside the app's testers can connect, and **webhooks for replies and mentions require Advanced Access**. Webhooks are never delivered for items on private accounts.

**Not possible**
- **Direct messages**: the Threads API has none. Mentions cannot be polled (webhook only). Polling sees only top-level replies to posts from the last 7 days; replies to replies come through the webhook.

**Unverified**
- The exact webhook payload (Zentry reads Meta's `values` list and the standard `entry[].changes[]` envelope; fixtures are reconstructions). Compare with a real delivery. Whether `subscribed_apps` is needed per account (Zentry does not call it; the subscription is set on the app).

**Official pages**: [Threads API overview](https://developers.facebook.com/docs/threads), [webhooks](https://developers.facebook.com/docs/threads/webhooks), [changelog](https://developers.facebook.com/documentation/threads/changelog).

## LinkedIn

**Possible** (Community Management API, versioned REST at `api.linkedin.com/rest`; the connecting member must be an **administrator of the Company Page**)
- Read the Page's posts (`GET /rest/posts?author=…&q=author`) and the comments on them (`GET /rest/socialActions/{postUrn}/comments`); answer with a comment as the Page (`POST /rest/socialActions/{postUrn}/comments`, `actor` = the organization, `parentComment` = the comment answered). Zentry polls the 10 most recently modified posts every 15 minutes; replies nested under a comment are not read.

**Paid / needs approval**
- **LinkedIn approval is required**: the app must be accepted into the Community Management API product (Development tier is the entry point; the Standard tier is partner-gated). Approval can take days to weeks. Until then nothing works, so the settings card shows **Requires approval** with the steps instead of a Connect button (it switches to Connect once the operator sets `LINKEDIN_APPROVED=true`).
- LinkedIn's push notifications for social actions (`ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS`; webhook signature `X-LI-Signature`, HMAC-SHA256 of `hmacsha256=<body>` with the client secret) are disabled during the Development tier. **Zentry therefore polls and does not accept LinkedIn webhooks**; they can be added once your app has the product.

**Not possible**
- **Direct messages**: LinkedIn's messaging API is limited to approved partners and is not available to this integration. Mentions of your Page in other people's posts are not available through the API. Member names are not shared with Page-management apps, so commenters appear as "LinkedIn member".

**Unverified**
- Scope names (LinkedIn's own pages disagree: `r_organization_social`, `r_organization_social_feed`, `rw_organization_admin`, `w_organization_social`). Zentry requests `r_organization_social w_organization_social` and the list can be overridden with `LINKEDIN_SCOPES`. Asking for a scope your app lacks fails the whole sign-in.
- The comments response shape (`commentUrn`, `actor`, `created.time`) and the `x-restli-id` header on create. The API version header (`LINKEDIN_API_VERSION`, default `202601`) must be a version LinkedIn still supports.

**Official pages**: [Community Management overview](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview), [Comments API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api), [Social action notifications](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-social-action-notifications), [webhook validation](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/webhook-validation).

> The older "LinkedIn Messaging" tab on Integrations (a pasted token and the `/api/webhooks/linkedin` route) is no longer shown on the Channels page: LinkedIn's messaging API is not open to this kind of integration.

## TikTok

**Possible**
- Comments on your own organic videos through the TikTok API for Business (Accounts / organic APIs), and a public reply to a comment. Webhooks are signed (`Tiktok-Signature`, scheme above).

**Paid / needs approval**
- **TikTok approval is required**: a TikTok Business Account linked to TikTok for Business, and a developer app approved for managing comments on your own videos. There is no self-service access, so the settings card shows **Requires approval** with the steps (and a Connect form once the operator sets `TIKTOK_APPROVED=true`).

**Not possible / not implemented**
- **Direct messages.** The Business Messaging API exists but is restricted to approved partners, conversations must be started by the user, a messaging window applies, and it is unavailable for accounts in the EEA, UK and Switzerland. Its send and webhook schemas are only visible to approved developers, so Zentry does not implement it rather than guess.
- Comments cannot be polled in Zentry (it would mean enumerating videos with schemas we cannot see); they arrive by webhook only.

**Unverified: this adapter has never run against TikTok's live API.**
- The comment webhook event: the fixture is a reconstruction, and the parser accepts the field names the envelope is believed to use, skipping everything else. Compare with the first real delivery.
- The reply endpoint (`business/comment/reply/create/`, per TikTok's reference for the sibling reply-list endpoint and integrator guides) and the account lookup (`business/get/`) used to validate the token.

**Official pages**: [TikTok API for Business](https://business-api.tiktok.com/portal/docs), [webhook signature verification](https://developers.tiktok.com/doc/webhooks-verification), [Business Messaging overview](https://business-api.tiktok.com/portal/docs?id=business-messaging-api-overview).

---

## What you need to set up, per platform

Redirect and webhook URLs use `NEXT_PUBLIC_APP_URL`. The Settings → Channels cards show them with copy buttons.

### X
- **Account**: an X developer account with a Project and App at developer.x.com.
- **App settings**: User authentication → OAuth 2.0, type "Web App, Automated App or Bot"; callback `…/api/channels/oauth/x`; permissions Read and write and Direct Messages.
- **Scopes**: `tweet.read tweet.write users.read dm.read dm.write offline.access`.
- **Cost**: pay-per-use credits (see above). Budget for the reads, replies and any DM events you expect.
- **Env**: `X_CLIENT_ID`, `X_CLIENT_SECRET`; for DM webhooks also `X_API_SECRET` (the app's API secret) and a registered webhook at `…/api/channels/x/webhook`.

### Threads
- **Account**: a Meta developer account; a Meta app with the Threads use case; your Threads account added as a Threads tester while in development.
- **App settings**: redirect URL `…/api/channels/oauth/threads`; webhook callback `…/api/channels/threads/webhook` with your verify token, subscribed to `replies` and `mentions`.
- **Permissions**: `threads_basic`, `threads_read_replies`, `threads_manage_replies`, `threads_content_publish`, `threads_manage_mentions`; submit for **App Review** (Advanced Access).
- **Cost**: free.
- **Env**: `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_WEBHOOK_VERIFY_TOKEN`.

### LinkedIn
- **Account**: a LinkedIn developer app at linkedin.com/developers associated with your Company Page; the person connecting must be a Page administrator.
- **Approval**: request **Community Management API** under Products and complete LinkedIn's access form.
- **App settings**: redirect URL `…/api/channels/oauth/linkedin`.
- **Permissions**: `r_organization_social`, `w_organization_social` (override with `LINKEDIN_SCOPES` if LinkedIn granted different names).
- **Cost**: free once approved (LinkedIn does not charge for the API).
- **Env**: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_APPROVED=true` after approval; optional `LINKEDIN_SCOPES`, `LINKEDIN_API_VERSION`.

### TikTok
- **Account**: a TikTok Business Account linked to TikTok for Business; an app at developers.tiktok.com and the TikTok API for Business portal.
- **Approval**: apply for access to managing comments on your own videos (and, separately, the Business Messaging API if you want DMs later).
- **App settings**: webhook URL `…/api/channels/tiktok/webhook`.
- **Permissions**: the organic comment scopes TikTok grants on approval (integrators report `comment.list` and `comment.list.manage`).
- **Cost**: free once approved (as far as TikTok documents).
- **Env**: `TIKTOK_CLIENT_SECRET`, `TIKTOK_APPROVED=true` after approval. Connecting is by pasted access token and Business Account id (open_id).

### All channels
- `CHANNEL_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`; schedule `/api/cron/channel-poll` (every 5 minutes, in `vercel.json`; Vercel Hobby allows only daily crons).
- Run `supabase/migrations/20261017090000_social_channels.sql`.
