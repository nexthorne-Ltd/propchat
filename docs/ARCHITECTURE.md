# Zen-try Architecture & System Map

Zen-try is a multi-tenant live chat platform built with **Next.js (App Router)** and **Supabase (PostgreSQL, Auth, Realtime, Storage)**, deployed on **Vercel**.

This document maps all application components, API routes, database tables, AI retrieval and auto-reply pipelines, and hardcoded values across the codebase.

---

## 1. System Map by Component

### 1.1 Marketing Site (`/`)
- **Main Files & Components**:
  - `src/app/page.tsx` (Hero, feature showcases, steps, interactive demo CTA, footer)
  - `src/components/marketing/LandingNav.tsx` (Navigation bar with links to features, demo, login, and signup)
  - `src/components/marketing/ProductShowcase.tsx` (Interactive mock of the chat inbox interface)
  - `src/components/marketing/FaqSection.tsx` (Product FAQ accordion)
  - `src/components/ui/Logo.tsx`, `src/components/ui/ThemeToggle.tsx`
- **Embeds**: Embeds the live widget via `<Script src="/widget.js" data-workspace-id="a0000000-0000-0000-0000-000000000001" strategy="lazyOnload" />`.
- **API Routes**: None called directly from marketing pages (static and client component tree).
- **Supabase Tables**: None directly queried by the landing page (widget loads its own workspace config independently).

---

### 1.2 Authentication: Login (`/login`)
- **Main Files & Components**:
  - `src/app/login/page.tsx` (Email/password form, OAuth buttons, demo fill shortcut)
  - `src/components/marketing/AuthShell.tsx` (`AuthShell` layout and `AuthAside` feature showcase panel)
  - `src/components/marketing/GoogleButton.tsx` (Google OAuth trigger button with dynamic enabled state)
  - `src/lib/auth/providers.ts` (`isProviderEnabled`, `useProviderEnabled` helper queries)
  - `src/lib/supabase/client.ts` (Browser Supabase client)
- **API Routes**:
  - Supabase Auth API (`supabase.auth.signInWithPassword`, `supabase.auth.signInWithOAuth`)
  - `src/app/auth/callback/route.ts` (OAuth code-to-session exchange handler, redirects to `next` param, e.g. `/dashboard` or `/onboarding`)
- **Supabase Tables & Schema**:
  - `auth.users` (Supabase Auth internal user management)
  - `public.agents` (Queried upon login in middleware and dashboard)

---

### 1.3 Authentication: Signup (`/signup`)
- **Main Files & Components**:
  - `src/app/signup/page.tsx` (3-phase registration: form details -> 6-digit email OTP verification -> redirect to `/onboarding`)
  - `src/components/marketing/AuthShell.tsx`
  - `src/components/marketing/GoogleButton.tsx`
  - `src/lib/auth/providers.ts`
  - `src/lib/supabase/client.ts`
- **API Routes & Database RPCs**:
  - Supabase RPC: `fn_register_user(p_email, p_password, p_name)` (Creates user record and generates 6-digit verification code)
  - Supabase RPC: `fn_verify_email_code(p_email, p_code)` (Validates code, activates account)
  - Supabase Auth: `signInWithPassword`, `signInWithOAuth`
  - `src/app/auth/callback/route.ts`
- **Supabase Tables & Schema**:
  - `auth.users`
  - `public.agents`

---

### 1.4 Workspace Setup: Onboarding (`/onboarding`)
- **Main Files & Components**:
  - `src/app/onboarding/page.tsx` (3-step wizard: Business info -> Branding/Widget preview -> Installation snippet)
  - `src/app/actions/admin.ts` (`createWorkspaceAction`)
  - `src/lib/domain.ts` (`cleanDomain`, `getDefaultSubdomain`)
  - `src/components/ui/Logo.tsx`, `src/components/ui/ThemeToggle.tsx`
- **API Routes & Server Actions**:
  - Server Action: `createWorkspaceAction` in `src/app/actions/admin.ts`
- **Supabase Tables**:
  - `public.workspaces` (Inserts workspace record with slug, brand_color, greeting_title, greeting_message, custom_domain)
  - `public.agents` (Updates agent row to associate `workspace_id = workspace.id` and assigns role `owner`)

---

### 1.5 Dashboard (`/dashboard`)
The dashboard is the central hub for support agents and workspace owners.

- **Main Files & Shell**:
  - `src/app/dashboard/page.tsx` (Master client layout managing active view, real-time message stream, and state)
  - `src/app/dashboard/error.tsx` (Error boundary)
  - `src/components/dashboard/Sidebar.tsx` (Navigation rail switching between `inbox`, `radar`, `reports`, `helpdesk`, `settings`)
  - `src/lib/favicon.ts` (Dynamic favicon unread count badges)
  - `src/lib/sound.ts` (Notification audio alerts)

#### A. Inbox View (`activeView === 'inbox'`)
- **Main Files**:
  - `src/components/dashboard/ConversationList.tsx` (Filter by open/closed/snoozed/assigned, search threads)
  - `src/components/dashboard/ChatThread.tsx` (Message bubbles, rich text editor, replies, internal notes, canned responses, attachments)
  - `src/components/dashboard/VisitorDetailsSidebar.tsx` (Visitor device, location, browsing path, tags, custom metadata)
  - `src/components/dashboard/EmojiPickerPopover.tsx`
- **API Routes**:
  - `POST /api/ai/auto-respond` (Automatic AI auto-reply execution)
  - `POST /api/ai/suggest` (AI suggested replies for agents)
  - `POST /api/ai/analyze` (Sentiment analysis and conversation summarization)
  - `POST /api/translation/translate` (Agent outgoing message translation)
  - `POST /api/translation/process-message` (Inbound message language detection and translation)
  - `POST /api/conversations/search` (Search message text across conversations)
  - `POST /api/conversations/merge` (Merge duplicate visitor conversations)
  - `POST /api/conversations/snooze` (Snooze conversation until later)
  - `POST /api/conversations/auto-assign` (Round-robin / workload-based agent auto-assignment)
  - `POST /api/channels/dispatch` (Outbound dispatch: nudges the channel queue for WhatsApp; legacy direct send for Meta / LinkedIn)
  - `GET|POST /api/channels/[channel]/webhook` and `/api/channels/[channel]/webhook/[connectionId]` (Signed channel webhooks: WhatsApp Cloud API, Instagram)
  - `GET /api/channels/oauth/instagram` (Instagram Business Login callback)
  - `GET|POST /api/cron/channel-outbound` (Retries queued channel sends and renews expiring channel tokens; `CRON_SECRET`)
  - `POST /api/upload` (Upload image attachments via Cloudinary)
  - `POST /api/notifications/dispatch` (Browser push / email alerts)
- **Supabase Tables**:
  - `public.conversations`
  - `public.messages`
  - `public.visitors`
  - `public.agents`
  - `public.canned_responses`
  - `public.conversation_tags`
  - `public.internal_notes`

#### B. Live Visitors View (`activeView === 'radar'`)
- **Main Files**:
  - `src/components/dashboard/LiveVisitorsRadar.tsx` (Live online visitor monitoring, current page, time on site, geo-location)
- **Realtime**:
  - Supabase Realtime channel listening to table `public.visitors`
- **Supabase Tables**:
  - `public.visitors`
  - `public.visitor_page_history`

#### C. Analytics View (`activeView === 'reports'`)
- **Main Files**:
  - `src/components/admin/AnalyticsDashboard.tsx` (Volume trends, First Response Time, Resolution Time, CSAT scores, Per-agent metrics)
- **API Routes**:
  - `GET /api/analytics` (`src/app/api/analytics/route.ts`)
- **Supabase Tables**:
  - `public.conversations`
  - `public.messages`
  - `public.agents`
  - `public.visitors`

#### D. Help Desk Management (`activeView === 'helpdesk'`)
- **Main Files**:
  - `src/components/dashboard/HelpDeskDashboard.tsx` (Collections/sections manager, article editor, ordering, status toggles)
  - `src/components/dashboard/MarkdownArticleContent.tsx` (Markdown renderer for articles)
  - `src/components/dashboard/KnowledgePanel.tsx` (Private knowledge notes and unanswered questions backlog)
- **Server Actions**:
  - `src/app/actions/helpdesk.ts` (`getHelpDeskDataAction`, `createHelpSectionAction`, `updateHelpSectionAction`, `deleteHelpSectionAction`, `createArticleAction`, `updateArticleAction`, `reorderArticlesAction`, `deleteArticleAction`, `toggleArticleStatusAction`, `updateHelpTabSettingsAction`, `searchArticleBodiesAction`)
  - `src/app/actions/knowledge.ts` (`listKnowledgeNotesAction`, `saveKnowledgeNoteAction`, `deleteKnowledgeNoteAction`, `listUnansweredQuestionsAction`, `updateUnansweredStatusAction`, `saveAiProviderAction`, `testAiProviderAction`)
- **Supabase Tables**:
  - `public.help_sections`
  - `public.articles`
  - `public.article_feedback`
  - `public.knowledge_notes`
  - `public.unanswered_questions`

#### E. Settings View (`activeView === 'settings'`)
- **Main Files**:
  - `src/components/dashboard/SettingsHub.tsx` (Tabbed settings: General, Branding, Domain, Business hours, Auto-assignment, AI, SMTP, Team)
  - `src/components/dashboard/InstallationGuide.tsx` (Embed script generator with custom attributes)
  - `src/components/dashboard/IntegrationsSettings.tsx` (Omnichannel configs: WhatsApp, Meta/Facebook, LinkedIn, LangGraph, Slack)
  - `src/components/dashboard/MobileAppSettingsCard.tsx` (PWA install config and mobile app links)
  - `src/components/admin/SMTPSettingsSection.tsx` (Custom SMTP credentials & unread email alerts)
- **Server Actions & APIs**:
  - Server Actions: `src/app/actions/admin.ts`, `src/app/actions/domain.ts`
  - `POST /api/domain-check` (DNS lookup testing CNAME and A-records)
  - `POST /api/workspace/smtp/save`
  - `POST /api/workspace/smtp/test`
- **Supabase Tables**:
  - `public.workspaces`
  - `public.workspace_integrations`
  - `public.agents`
  - `public.canned_responses`

---

### 1.6 Super Admin Panel (`/admin`)
- **Main Files & Components**:
  - `src/middleware.ts` (Protects all `/admin/*` paths; enforces authentication and role `admin` or `owner` in `public.agents`)
  - `src/app/admin/page.tsx` (Server component checking session, agent role, and fetching initial data)
  - `src/app/admin/AdminClientLayout.tsx` (Admin layout with platform mini-rail)
  - `src/components/admin/CompaniesAdminDashboard.tsx` (Platform-wide tenant overview, cross-tenant search, company creation, company drilldown)
  - `src/components/admin/AdminSettingsPanel.tsx` (Workspace configuration management)
  - `src/components/admin/AnalyticsDashboard.tsx`
  - `src/components/admin/SMTPSettingsSection.tsx`
- **Server Actions & Database RPCs**:
  - `src/app/actions/platform.ts`:
    - `getPlatformCompaniesAction` (Calls RPC `fn_get_platform_companies_summary`)
    - `getCompanyDrilldownAction` (Retrieves deep metrics for any tenant workspace)
    - `createCompanyAction` (Provisions new company workspace and default owner)
  - Server Actions in `src/app/actions/admin.ts` & `src/app/actions/domain.ts`
- **Supabase Tables & RPCs**:
  - `public.workspaces`
  - `public.agents`
  - `public.conversations`
  - `public.messages`
  - `public.visitors`
  - `public.articles`
  - RPC: `fn_get_platform_companies_summary`

---

### 1.7 Public Help Center (`/help/<slug>` & Custom Domains)
- **Main Files & Components**:
  - `src/middleware.ts`:
    - Host-based routing for non-platform hosts (matching `custom_domain` on `public_workspaces`)
    - Rewrites custom domain `/` -> `/help/[workspaceId]`
    - Rewrites custom domain `/<article-slug>` -> `/help/[workspaceId]/<article-slug>`
    - Rewrites `/sitemap.xml` -> `/help/[workspaceId]/sitemap.xml`
  - `src/app/help/page.tsx` (Default platform fallback redirecting to primary workspace)
  - `src/app/help/[workspaceId]/page.tsx` (Public help center root: search bar, collection grid/list, recent articles)
  - `src/app/help/[workspaceId]/layout.tsx` (Metadata and viewport generation)
  - `src/app/help/[workspaceId]/error.tsx` (Not found / private workspace error boundary)
  - `src/app/help/[workspaceId]/[articleId]/page.tsx` (Individual article viewer, breadcrumbs, related articles, helpfulness feedback)
  - `src/app/help/[workspaceId]/[articleId]/layout.tsx` (SEO metadata, OpenGraph tags, canonical URLs)
  - `src/app/help/[workspaceId]/sitemap.xml/route.ts` (Dynamic XML sitemap generator for search engine crawlers)
  - `src/components/help/HelpChrome.tsx` (`HelpHeader`, `HelpFooter`, `HelpWidget` trigger button)
  - `src/components/dashboard/MarkdownArticleContent.tsx` (Safe Markdown renderer)
  - `src/lib/domain.ts` (`isPlatformHost`, `getWorkspaceHelpCenterUrl`, `cleanDomain`, `getDefaultSubdomain`)
- **API Routes**:
  - `POST /api/help/view` (Increments article `views_count`)
  - `POST /api/help/feedback` (Submits helpful/unhelpful rating to `public.article_feedback`)
  - `GET /api/help` (Public JSON search endpoint)
  - `GET /help/[workspaceId]/sitemap.xml`
- **Supabase Tables & Views**:
  - `public_workspaces` (View exposing sanitized non-sensitive branding columns)
  - `public.help_sections`
  - `public.articles` (Only `status = 'published'`)
  - `public.article_feedback`

---

### 1.8 Embeddable Shadow DOM Widget (`/widget.js`)
- **Main Files**:
  - `widget/src/index.ts` (Complete standalone vanilla TypeScript widget engine with isolated Shadow DOM)
  - `widget/src/icon.ts` (Base64 embedded SVGs and UI icons)
  - `widget/package.json` (Builds via `esbuild src/index.ts --bundle --minify --format=iife --outfile=../public/widget.js --target=es2020`)
  - `public/widget.js` (Compiled script output served statically from root)
  - `src/lib/emojis.ts` (Emoji category picker data)
- **Features**:
  - Complete CSS isolation using Web Components Shadow DOM (`attachShadow({ mode: 'open' })`)
  - Real-time messaging with Supabase Realtime channel subscription
  - Live visitor presence and page tracking (`fn_upsert_visitor`, `fn_visitor_heartbeat`)
  - Single-Page Application (SPA) navigation tracking (`history.pushState` wrapper)
  - Dynamic Help tab with instant local client search
  - Customizable brand colors, custom logos, greetings, position, launcher icon
  - Navbar integration link auto-injector
  - Image upload support via Cloudinary
  - Delivery and read receipts (`fn_mark_messages_delivered`, `fn_mark_messages_read`)
- **API Routes**:
  - `POST /api/ai/auto-respond` (Triggered after visitor sends message)
  - `POST /api/upload` (Image attachments)
- **Supabase Tables & RPCs called by Widget**:
  - RPC: `fn_get_workspace_config`
  - RPC: `fn_upsert_visitor`
  - RPC: `fn_update_visitor_meta`
  - RPC: `fn_visitor_heartbeat`
  - RPC: `fn_get_or_create_conversation`
  - RPC: `fn_mark_messages_delivered`
  - RPC: `fn_mark_messages_read`
  - RPC: `fn_mark_conversation_messages_as_read`
  - RPC: `fn_submit_article_feedback`
  - Table: `public.messages` (Realtime & SELECT / INSERT)
  - Table: `public.conversations` (Realtime)
  - Table: `public.help_sections`
  - Table: `public.articles`
  - View: `public_workspaces`

---

## 2. AI Auto-Reply & Article Matching Architecture

### 2.1 Triggering Code Path & Idempotency Architecture
The AI auto-reply system is initiated from **exactly one path**: the visitor chat interface upon message creation, protected by multi-layer idempotency guards.

1. **Primary Trigger: Visitor Message Creation**:
   - **Standalone Shadow DOM Widget (`widget/src/index.ts:1335`)**:
     Immediately after the visitor's message is inserted into Supabase `messages` table, the widget executes an asynchronous background POST with `message_id`:
     ```ts
     fetch(`${this.config.apiUrl || ''}/api/ai/auto-respond`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         conversation_id: this.conversationId,
         workspace_id: this.config.workspaceId,
         message_id: data.id,
       }),
     });
     ```
   - *(Note: Redundant realtime listeners in the Agent Dashboard have been removed to guarantee exactly one trigger path).*

2. **Multi-Layer Idempotency Guards**:
   - **In-Flight Memory Locks**: Prevents concurrent runs for the same `conversation_id` or `message_id`.
   - **Pre-Execution Check**: Refuses to run if an AI reply or handover note already exists referencing `targetVisitorMsgId` (in memory or database via `reply_to_message_id` or `metadata.answered_message_id`).
   - **Pre-Insert Atomic Double-Check**: Verifies again right before insertion that no concurrent worker or human agent replied during RAG generation.
   - **Database Unique Constraints**: `idx_messages_unique_ai_reply_per_visitor_msg` and `idx_messages_unique_ai_handover_per_visitor_msg` enforce at the database level that exactly one AI message and one handover note can exist per visitor message ID.

---

### 2.2 Execution Flow in `/api/ai/auto-respond`
(`src/app/api/ai/auto-respond/route.ts`)

1. **Concurrency Lock**: Uses an in-memory lock `inFlightConversations = new Set<string>()` to prevent concurrent LLM generation runs on the same conversation. Subsequent incoming messages wait up to 45s for the lock.
2. **Parallel Index Warming & Pre-fetch**: Calls `warmHelpIndex(workspace_id)` simultaneously while fetching `workspaces`, `conversations`, and recent 40 `messages` using Supabase `serviceClient()`.
3. **Inbound Translation**:
   - Calls `detectLanguage()` on the latest visitor message.
   - If non-English, calls `translateToEnglish()` via `src/lib/ai/translator.ts`.
   - Saves detected language and English translation into `messages.metadata` and `conversations.channel_metadata`.
4. **Guard Checks**:
   - Verifies `ai_settings.enabled && ai_settings.auto_response_enabled`.
   - Verifies conversation status is not `closed` and `ai_mode !== 'disabled'`.
   - Inspects `answeredUntil` timestamp on the thread to ensure no agent or previous AI reply has already answered the visitor's latest inquiry.
5. **Context Assembly**:
   - Aggregates recent unanswered lines as the main question.
   - Extracts conversational turns (`history` and `turns`) to provide multi-turn context.
6. **Intent, then RAG & Decision Generation**:
   - Invokes `generateHelpDeskResponseWithHandover()` in `src/lib/ai/anthropic.ts`, which first classifies the message (`classifyVisitorIntent` in `src/lib/ai/intent.ts`) and routes it:
     - `small_talk`: short reply, no retrieval.
     - `help_center_question`: retrieval over **published articles only** (no team notes). If retrieval confidence is low, or the model answers `[NOT_COVERED]` or names no source, the bot says it couldn't find the answer and offers a team member; nothing is guessed and the gap is logged. Otherwise the reply ends with a code-built `Source: [Article](url)` citation.
     - `account_specific`, `out_of_scope`, `wants_human`: hand over to the inbox with a deterministic summary note (`buildHandoverSummary`). `out_of_scope` keeps the bot on; the other two turn it off for the conversation.
   - A "yes" to the bot's offer of a team member is classified as `wants_human`.
   - The bot message's `metadata` records `bot_intent`, `bot_intent_source`, `retrieval_confidence` and `cited_article_id`.
7. **Atomic Race-Condition Check**:
   - Re-queries the `messages` table for any human agent message that arrived while the model was thinking. If a human agent responded in the interim, the AI drops its reply.
8. **Outbound Dispatch & Storage**:
   - Inserts generated answer into `messages` table (`sender_type: 'ai'`, `metadata: { answered_until: visitorMsg.created_at, generated_by: 'ai_auto_respond' }`).
   - Updates `conversations` with timestamp and AI summary/sentiment.
   - Dispatches message to external channels (WhatsApp/Meta/LinkedIn) if applicable.
   - If human handover was triggered, marks `ai_mode = 'disabled'` and updates assignment.

---

### 2.3 How Articles are Matched to Questions (RAG Pipeline)
The retrieval logic is implemented in `src/lib/ai/retrieval.ts` and `src/lib/ai/help-answer.ts`:

1. **Multilingual Query Translation**:
   - If incoming query is non-English, `translateForSearch()` performs an ultra-fast translation into English keyword search terms before querying the index.
2. **Tokenization & Normalization**:
   - **Stop Words**: Strips standard English stop words plus chat filler ("hi", "please", "could you", "wondering", "bro", "pls", etc.) and multi-lingual filler.
   - **Abbreviations**: Expands common shorthands (`max` -> `maximum`, `min` -> `minimum`, `acct` -> `account`, `docs` -> `documentation`, `kyc` -> `verification`).
   - **Morphological Stemming**: Normalizes verb/noun suffixes (`-ations`, `-ement`, `-ments`, `-ity`, `-ing`, `-ed`, `-s`, etc.).
3. **Field-Weighted BM25 Ranking**:
   - Evaluates all published `articles` and internal `knowledge_notes` (where `visibility = 'assistant'`).
   - Field multipliers:
     - **Title**: 4.5x weight
     - **Tags**: 3.0x weight
     - **Category / Section Name**: 2.5x weight
     - **Summary**: 2.0x weight
     - **Content (Body)**: 1.0x weight
   - Applies Inverse Document Frequency (IDF) and document length normalization.
4. **Confidence Gating & Safety Thresholds**:
   - Computes an absolute BM25 score and relative margin over the 2nd best article.
   - If below confidence threshold, refuses to hallucinate and triggers fallback / handover.
5. **Passage Extraction**:
   - For high-confidence matches, `extractPassage()` locates the exact paragraph or sentence that answers the specific question, rather than dumping the full document.
6. **Gap Logging**:
   - When a question cannot be answered with high confidence, `recordUnanswered()` calls the database RPC `fn_record_unanswered_question(p_workspace_id, p_question, p_reason, p_conversation_id)`.
   - Collapses whitespace and punctuation to deduplicate gaps in `unanswered_questions`.
7. **LLM Synthesis (Multi-Provider Support)**:
   - When an API key is configured (Anthropic, OpenAI, Google Gemini, DeepSeek, or OpenAI-compatible endpoint via `src/lib/ai/provider.ts`):
     - Injects retrieved knowledge base articles into the system prompt.
     - Directs model to respond empathetically, match the visitor's native language, and output `[NOT_COVERED: <reason>]` or `[HANDOVER: <reason>]` if documentation is insufficient.
   - When no model API key is configured:
     - Directly returns the extracted article passage with a clean link to the help center article.

---

## 3. Hardcoded URLs and Seed / Demo Values

### 3.1 Hardcoded URLs & Hostnames
| URL / Hostname | Locations | Notes |
|---|---|---|
| `http://localhost:3000` | `src/lib/domain.ts:153`<br/>`src/app/login/page.tsx:79`<br/>`src/app/signup/page.tsx:77`<br/>`src/app/onboarding/page.tsx:121`<br/>`src/components/dashboard/InstallationGuide.tsx:42`<br/>`src/lib/ai/anthropic.ts:364`<br/>`src/app/api/notifications/dispatch/route.ts:22`<br/>`src/app/api/cron/unread-notifications/route.ts:24` | Default fallback when `NEXT_PUBLIC_APP_URL` or `window.location.origin` is missing. |
| `https://your-app.vercel.app/widget.js` | `src/app/page.tsx:464` | Example embed code snippet in landing page HTML instructions. |
| `notifications@chatify.dev` | `src/app/api/notifications/dispatch/route.ts:228` | Default `from` email address in Resend / notification dispatch. |
| `cname.chatify.dev` | `src/lib/domain.ts:6`<br/>`src/app/actions/domain.ts:202` | Referenced in comments as deprecated CNAME host. |
| `cname.vercel-dns.com` | `src/lib/domain.ts:16` | Default CNAME target for customer subdomains. |
| `76.76.21.21` | `src/lib/domain.ts:26`<br/>`src/app/actions/domain.ts:265` | Default Vercel Anycast A-Record for apex domain configuration. |
| `agent@chatify.io` | `src/app/login/page.tsx:113` | Demo email used by "Use demo credentials" button. |
| `app.chatify.io/inbox` | `src/components/marketing/ProductShowcase.tsx:117` | Mock URL bar display in marketing product showcase. |
| `https://vfjsaynnubxywdbevxtx.supabase.co` | 25 files across `src/` and `widget/src/` | Hardcoded default Supabase URL when `NEXT_PUBLIC_SUPABASE_URL` is omitted. |
| `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | 24 files across `src/` and `widget/src/` | Hardcoded default Supabase Anon Public Key. |

---

### 3.2 Seed & Demo Values
| Value / Identifier | Locations | Description |
|---|---|---|
| `a0000000-0000-0000-0000-000000000001` | `src/app/page.tsx:594`<br/>`src/app/help/page.tsx:17`<br/>`src/app/admin/page.tsx:29`<br/>`src/app/api/analytics/route.ts:14`<br/>`supabase/migrations/20260906140000_phase1_security_and_multitenancy.sql:83` | Default seed/fallback workspace UUID. Used on the landing page widget embed and as API fallback. |
| `ChatifyDemo2026!` | `src/app/login/page.tsx:114` | Password filled by "Use demo credentials" on `/login`. |
| `public/demo.html` & `demo-site/index.html` | Root `/public` & `/demo-site` | Standalone customer website simulator testing widget injection, SPA navigation, and session resets. |
| `Northwind` / `alex@northwind.com` / `northwind.com` | `src/app/page.tsx:45-49`<br/>`src/app/onboarding/page.tsx:209, 228`<br/>`src/components/marketing/ProductShowcase.tsx:132-135` | Sample business name and email in landing page & onboarding placeholders. |
| `Acme Corp` / `TechWave Labs` / `https://acmecorp.com` | `src/components/admin/CompaniesAdminDashboard.tsx:741, 752` | Form placeholder text in Platform Admin company creation modal. |
| `sarah@example.com` / `test@example.com` | `src/components/widget/ChatWidget.tsx:1214`<br/>`src/components/admin/SMTPSettingsSection.tsx:493` | Placeholder email inputs. |
| `chatify-verify-token` | `src/lib/domain.ts:259` | Fallback verification token when workspace lacks a generated token. |

---

## 4. Environment Variables Reference
- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon public key
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase privileged service role key
- `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_APP_ORIGIN`: Base platform URL
- `NEXT_PUBLIC_CNAME_TARGET`: Custom domain CNAME target (defaults to `cname.vercel-dns.com`)
- `NEXT_PUBLIC_APEX_A_RECORD`: Apex domain A-record target (defaults to `76.76.21.21`)
- `NEXT_PUBLIC_PLATFORM_HOSTS`: Comma-separated list of platform domains
- `AI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `DEEPSEEK_API_KEY`: LLM provider API keys
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_URL`: Media upload service
- `RESEND_API_KEY`: Outbound email notifications
- `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`: Vercel custom domain registration API
