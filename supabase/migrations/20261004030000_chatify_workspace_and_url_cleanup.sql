-- Migration: 20261004030000_chatify_workspace_and_url_cleanup.sql
-- Description:
-- 1. Create dedicated "Chatify" workspace with slug 'chatify' and rich help center content
-- 2. Clean up hardcoded localhost:3000 and chatify.dev/logo.png from seed data

BEGIN;

-- 1. Clean up seed demo workspace urls
UPDATE public.workspaces
SET 
  logo_url = NULL,
  website_url = 'https://novacloud.example.com'
WHERE id = 'a0000000-0000-0000-0000-000000000001';

-- Also clean up any other rows referencing chatify.dev/logo.png or localhost
UPDATE public.workspaces
SET logo_url = NULL
WHERE logo_url ILIKE '%chatify.dev/logo.png%';

UPDATE public.workspaces
SET website_url = NULL
WHERE website_url ILIKE '%localhost%';

-- 2. Create or update dedicated Chatify workspace
DO $$
DECLARE
  v_owner_id uuid;
  v_ws_id uuid := 'c0000000-0000-0000-0000-000000000001';
  v_sec1_id uuid := 'c0000000-0000-0000-0000-000000000011';
  v_sec2_id uuid := 'c0000000-0000-0000-0000-000000000012';
  v_sec3_id uuid := 'c0000000-0000-0000-0000-000000000013';
  v_sec4_id uuid := 'c0000000-0000-0000-0000-000000000014';
  v_sec_empty_id uuid := 'c0000000-0000-0000-0000-000000000015';
BEGIN
  -- Look for an existing admin user, or pick the first authenticated user
  SELECT id INTO v_owner_id
  FROM auth.users
  WHERE email ILIKE '%admin%' OR email ILIKE '%chatify%'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_owner_id IS NULL THEN
    SELECT id INTO v_owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  END IF;

  -- Insert or update dedicated Chatify workspace
  INSERT INTO public.workspaces (
    id,
    name,
    slug,
    owner_id,
    brand_color,
    greeting_title,
    greeting_message,
    help_center_title,
    help_center_subtitle,
    help_center_layout,
    help_center_tab_label,
    show_help_tab,
    help_center_tab_icon,
    plan,
    status,
    is_active,
    created_at,
    updated_at
  ) VALUES (
    v_ws_id,
    'Chatify',
    'chatify',
    v_owner_id,
    '#2563eb',
    'Chatify Support',
    'Welcome to Chatify! How can we help you today? Ask questions or search our articles.',
    'Chatify Help Center',
    'Everything you need to know about setting up and using Chatify.',
    'grid-2',
    'Help',
    true,
    'book',
    'enterprise',
    'active',
    true,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    name = 'Chatify',
    slug = 'chatify',
    brand_color = '#2563eb',
    greeting_title = 'Chatify Support',
    greeting_message = 'Welcome to Chatify! How can we help you today? Ask questions or search our articles.',
    help_center_title = 'Chatify Help Center',
    help_center_subtitle = 'Everything you need to know about setting up and using Chatify.',
    help_center_layout = 'grid-2',
    status = 'active',
    is_active = true,
    updated_at = now();

  -- Insert Help Sections
  INSERT INTO public.help_sections (
    id, workspace_id, name, slug, icon, description, order_index, created_at, updated_at
  ) VALUES 
    (v_sec1_id, v_ws_id, 'Getting Started', 'getting-started', '🚀', 'Core concepts, onboarding steps, and product overview.', 1, now(), now()),
    (v_sec2_id, v_ws_id, 'Chat Widget & Installation', 'widget-installation', '💬', 'Embedding the live messenger on WordPress, Shopify, Next.js, and HTML.', 2, now(), now()),
    (v_sec3_id, v_ws_id, 'AI Copilot & Automation', 'ai-copilot', '🤖', 'Configuring AI drafts, canned responses, and knowledge base sources.', 3, now(), now()),
    (v_sec4_id, v_ws_id, 'Team & Inbox Management', 'team-inbox', '👥', 'Inviting colleagues, routing chats, and setting up business hours.', 4, now(), now()),
    (v_sec_empty_id, v_ws_id, 'Upcoming Beta Features', 'upcoming-features', '✨', 'Preview features under development (no published articles yet).', 5, now(), now())
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    icon = EXCLUDED.icon,
    description = EXCLUDED.description,
    order_index = EXCLUDED.order_index,
    updated_at = now();

  -- Insert Published Articles
  -- Article 1: Getting Started
  INSERT INTO public.articles (
    id,
    workspace_id,
    section_id,
    title,
    slug,
    category,
    summary,
    content,
    status,
    author_id,
    views_count,
    order_index,
    created_at,
    updated_at
  ) VALUES (
    'c0000000-0000-0000-0000-000000000021',
    v_ws_id,
    v_sec1_id,
    'Welcome to Chatify: Complete Platform Overview',
    'welcome-to-chatify',
    'Getting Started',
    'Learn how Chatify unifies live visitor tracking, instant chat, and AI copilot support into one seamless platform.',
    E'# Welcome to Chatify\n\nChatify is modern live chat and AI customer engagement software engineered to help teams convert more website visitors and resolve customer queries in record time.\n\n## Key Capabilities\n\n- **Real-Time Visitor Presence**: See who is on your site right now, which pages they are browsing, their referrer source, and geographic location.\n- **Zero-Latency Messaging**: Chat instantly with visitors with bidirectional presence indicators and typing awareness.\n- **Built-in AI Copilot**: Generate AI-suggested responses tailored to your workspace knowledge notes and previous conversations.\n- **Custom Branding**: Tailor the launcher icon, brand color accents, welcome titles, and help center to match your product identity.\n\n## Getting Up and Running\n\n1. Complete your workspace profile.\n2. Grab your embed snippet from the **Install** tab.\n3. Add it to your site header or template.\n4. You will immediately see incoming visitors and chats in your unified Inbox!',
    'published',
    v_owner_id,
    42,
    1,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    slug = EXCLUDED.slug,
    content = EXCLUDED.content,
    summary = EXCLUDED.summary,
    status = EXCLUDED.status,
    updated_at = now();

  -- Article 2: Installing the widget
  INSERT INTO public.articles (
    id,
    workspace_id,
    section_id,
    title,
    slug,
    category,
    summary,
    content,
    status,
    author_id,
    views_count,
    order_index,
    created_at,
    updated_at
  ) VALUES (
    'c0000000-0000-0000-0000-000000000022',
    v_ws_id,
    v_sec2_id,
    'Quickstart: Installing the Chat Widget on Any Website',
    'installing-chat-widget',
    'Chat Widget & Installation',
    'Step-by-step instructions for embedding the Chatify live chat snippet on HTML, Next.js, WordPress, and Shopify.',
    E'# Installing the Chat Widget\n\nIntegrating Chatify takes under two minutes. You only need to include a single lightweight `<script>` tag before the closing `</body>` tag on your website.\n\n## The Embed Snippet\n\n```html\n<script\n  src="/widget.js"\n  data-workspace-id="c0000000-0000-0000-0000-000000000001"\n  async\n  defer\n></script>\n```\n\nReplace the `data-workspace-id` with your actual workspace ID found in your dashboard Settings.\n\n## Platform-Specific Guides\n\n### Plain HTML\nPaste the snippet right above the `</body>` tag in your `index.html`.\n\n### Next.js (App Router)\nAdd the script tag using Next.js `next/script` in your root `app/layout.tsx`:\n```tsx\nimport Script from \'next/script\';\n\nexport default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>\n        {children}\n        <Script\n          src="/widget.js"\n          data-workspace-id="YOUR_WORKSPACE_ID"\n          strategy="lazyOnload"\n        />\n      </body>\n    </html>\n  );\n}\n```\n\n### WordPress\nUse the "Insert Headers and Footers" plugin or add the script tag to your theme\'s `footer.php`.',
    'published',
    v_owner_id,
    88,
    1,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    slug = EXCLUDED.slug,
    content = EXCLUDED.content,
    summary = EXCLUDED.summary,
    status = EXCLUDED.status,
    updated_at = now();

  -- Article 3: AI Copilot
  INSERT INTO public.articles (
    id,
    workspace_id,
    section_id,
    title,
    slug,
    category,
    summary,
    content,
    status,
    author_id,
    views_count,
    order_index,
    created_at,
    updated_at
  ) VALUES (
    'c0000000-0000-0000-0000-000000000023',
    v_ws_id,
    v_sec3_id,
    'Configuring AI Copilot and Smart Replies',
    'configuring-ai-copilot',
    'AI Copilot & Automation',
    'Train the AI copilot on your business FAQs, tone of voice, and canned responses to automate repetitive support tickets.',
    E'# Configuring AI Copilot and Smart Replies\n\nChatify features an integrated AI Copilot powered by modern language models that learns from your knowledge base to assist human agents or provide instant automated answers.\n\n## How AI Uses Your Knowledge Base\n\nWhen a visitor asks a question:\n1. The system performs semantic vector search over your published **Help Center articles** and **Assistant Knowledge Notes**.\n2. The most relevant snippets are synthesized into a coherent, accurate response matching your brand guidelines.\n3. Human agents can review, modify, and approve drafts with one click before sending.\n\n## Best Practices for High Accuracy\n\n- Keep knowledge notes concise and specific to one topic.\n- Write clear Q&A pairs for common pricing, shipping, or technical questions.\n- Monitor **Knowledge Gaps** in your admin panel to see what questions visitors asked that lacked reference articles.',
    'published',
    v_owner_id,
    57,
    1,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    slug = EXCLUDED.slug,
    content = EXCLUDED.content,
    summary = EXCLUDED.summary,
    status = EXCLUDED.status,
    updated_at = now();

  -- Article 4: Team and Inbox
  INSERT INTO public.articles (
    id,
    workspace_id,
    section_id,
    title,
    slug,
    category,
    summary,
    content,
    status,
    author_id,
    views_count,
    order_index,
    created_at,
    updated_at
  ) VALUES (
    'c0000000-0000-0000-0000-000000000024',
    v_ws_id,
    v_sec4_id,
    'Managing Team Seats, Roles, and Business Hours',
    'managing-team-seats',
    'Team & Inbox Management',
    'Learn how to invite team members, assign permissions, and configure automatic presence routing.',
    E'# Managing Team Seats, Roles, and Business Hours\n\nCollaborate effectively with your support and sales teams directly within Chatify.\n\n## Roles and Permissions\n\n- **Owner**: Full access including workspace billing, custom domains, and platform settings.\n- **Admin**: Can manage canned responses, team members, knowledge notes, and view analytics.\n- **Agent**: Answers visitor chats, manages inbox status, and browses assigned conversations.\n\n## Business Hours & Offline Mode\n\nUnder **Settings > Business Hours**, configure your operating schedule for each day of the week. When all agents are offline or outside business hours, the widget displays an offline prompt collecting the visitor\'s email address for follow-up.',
    'published',
    v_owner_id,
    31,
    1,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    slug = EXCLUDED.slug,
    content = EXCLUDED.content,
    summary = EXCLUDED.summary,
    status = EXCLUDED.status,
    updated_at = now();

END $$;

COMMIT;
