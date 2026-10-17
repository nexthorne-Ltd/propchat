# Trader data

The bot's lookup specialists (Account status, KYC status, Order lookup,
Affiliate stats, Coupon check; `src/lib/ai/sub-agents.ts`) can read the prop
firm's own records. Each firm connects its own in **Settings → AI bot →
Trader data**. Without a connection, these specialists explain the usual
cause, collect the details and hand over, as before.

There are two kinds of connection:

- **Prop-firm backend (Supabase)**, the usual one. Every firm on the platform
  runs the same prop-firm backend on its own Supabase project, so the firm
  pastes that project's URL and its `service_role` key, and the bot reads
  the tables directly (`prop-firm-supabase.ts`). See "Supabase" below.
- **Own endpoint (HTTP)**: a firm on another backend builds an HTTPS
  endpoint to the contract under "Request" and "Response".

The key is encrypted with `CHANNEL_ENCRYPTION_KEY` (AES-256-GCM,
`src/lib/channels/crypto.ts`) before it is stored, is never sent back to the
browser, and is used only with the URL it was saved for: changing the URL
means pasting the key again.

Code: `src/lib/ai/trader-data/` (`client.ts` holds the connection and the HTTP
call, `prop-firm-supabase.ts` the Supabase reads, `source.ts` picks one,
`lookup.ts` runs verification and the lookup, `parse.ts` reads emails, codes
and ids from chat messages). Migration: `20261120090000_trader_data_lookup.sql`.
Settings: `src/components/settings/TraderDataSettings.tsx`, actions
`src/app/actions/trader-data.ts`.

## Supabase

The `service_role` key bypasses the firm's RLS, so the reads are fixed and
narrow. They are SELECTs only, always filtered by the `users.id` of the
verified email (matched exactly, case-insensitively, with LIKE wildcards
escaped), return a few rows at most, and never select `passwordHash`,
`passwordMaster`, `passwordInvestor`, KYC document URLs or payout details.

| Lookup | Tables and columns |
|---|---|
| Account status, Account info | `trading_accounts`: a summary of every account (total, count per status, how many without credentials), then the latest 10 in detail (login, platform, phase, status, balance, equity, P/L, target, delivered or not; for a failed one, the stored breach reason from `statisticsPayload._<brand>Compliance.breachReason` with its rule id, title, message and time, any brand prefix), a dashboard for the first 4 (from `statisticsPayload.statistics`: balance, equity, profit, drawdown %, trading days, best day, win rate, trades, profit factor, avg win/loss, best/worst trade, today / this week / this month, the last 7 days of `equity_curve.daily_performance`, top symbols, open trades, and `statisticsUpdatedAt`), plus the latest 3 orders and whether each got its account. Without the code, an order id or login the trader types finds the trader before the email |
| KYC status | `kyc`: method, status, rejection reason, updated |
| Order lookup | `orders` plus the plan name and size (`challenge_plans`) and whether its accounts were delivered |
| Affiliate stats | `affiliates` (code, rate) and `referrals` (count, and commission pending / approved / paid) |
| Coupon check | `coupons` by code (upper-cased): discount, status, expiry. No email needed |

A login or order id the visitor typed only narrows that user's own rows. An
anon or publishable key is refused when saving, because it reads nothing.

## Which email

By default (since `20261121090000_trader_data_code_optional.sql`) the bot
reads the record straight from the email the trader types, or the one on the
pre-chat form, and remembers it for 12 hours in that conversation. That means
anyone who types another trader's email sees that trader's record. A
workspace that wants proof switches on **Verify the email with a code** in
Settings → AI bot → Trader data; then the steps below apply.

## With the code switched on

A record is personal data, and anyone can type someone else's email into a
chat. So the endpoint is never called with an email the visitor only typed:

1. The visitor asks a question only their record answers.
2. The bot asks for the account email and sends a 6-digit code to it, through
   the workspace's SMTP or, if it has none, the platform's.
3. The visitor types the code in the chat. A code lasts 10 minutes and allows
   5 tries. A conversation gets at most 3 codes, an address 5 an hour, and a
   workspace 200 an hour.
4. The bot calls the endpoint with the verified email and answers the
   original question from the record. Verification lasts 12 hours in that
   conversation.

The code is checked on the server and only its hash is stored
(`trader_identity_verifications`, no RLS policies, service role only). If no
email can be sent, nothing is looked up. Coupon checks need no verification:
only the code goes to the endpoint.

## Own endpoint: request

`POST <your URL>`, `Content-Type: application/json`, and
`Authorization: Bearer <API key>` when a key is saved. **Check the key on
every request**: the endpoint returns personal data.

```json
{
  "version": 1,
  "action": "account_status",
  "workspace_id": "…",
  "conversation_id": "…",
  "email": "trader@example.com",
  "email_verified": true,
  "account_login": "50012345",
  "order_id": null,
  "coupon_code": null,
  "question": "mera account breach kyun hua?"
}
```

| action | Used by | What to return |
|---|---|---|
| `account_status` | Account status | The trader's accounts: login, size, phase, status (active / breached / passed / funded), breach reason and time, balance, equity, drawdown used and left |
| `kyc_status` | KYC status | Verification status, submitted at, rejection reason, what to re-submit |
| `order_status` | Order lookup | Recent orders: id, product, amount, payment method, payment status, paid at, delivered (credentials sent) at |
| `affiliate_stats` | Affiliate stats | Referrals, clicks, commission pending / approved / paid, last payout |
| `coupon_check` | Coupon check | Whether `coupon_code` exists and is active: discount, plans it covers, expiry, uses left. `email` is null |
| `test` | Settings → Test connection | Anything with HTTP 200. `email` is null |

`account_login`, `order_id` and `coupon_code` are what the visitor typed, read
from the chat. They are hints, not proof: **return a record only if it belongs
to `email`**, and ignore an id that belongs to someone else.

## Own endpoint: response

Within 6 seconds, HTTP 200:

```json
{ "found": true, "record": { "accounts": [{ "login": "50012345", "status": "breached", "breach_reason": "Daily loss limit" }] } }
```

- `record` (or `records` / `data`) can have any JSON shape. The bot reads it
  as written, up to 4,000 characters, so leave out staff notes and internal
  fields.
- Nothing for this email: `{ "found": false }`, optionally with a `message`,
  or HTTP 404. The bot says so and asks the trader to check the email or id.
- Any other status, a redirect, a timeout or a body that is not JSON counts
  as a failure. The bot answers without the record and hands over if a
  person must check. The failure is logged as `trader_lookup` / `error` in
  `ai_reply_events`.

The bot never changes anything through this endpoint. Refunds, resets and
corrections stay with the team.
