import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

async function updateSampleArticle() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { data: authData } = await supabase.auth.signInWithPassword({
    email: 'agent@chatify.io',
    password: 'ChatifyDemo2026!',
  });

  if (!authData?.user) {
    console.error('Failed to authenticate');
    return;
  }

  const sampleContent = `# 🚀 Getting Started with Chatify Live Chat

Welcome to **Chatify**! This comprehensive guide walks you through setting up live support, configuring your team radar, and customizing widget branding.

---

## ⚡ Quick Checklist for New Setups

Before launching the widget to your visitors, make sure you complete these essentials:

- [x] Configure business operating hours & timezone
- [x] Set primary brand color & welcome greetings
- [ ] Paste embed snippet in your website \`<body>\` tag
- [ ] Add team members and assign agent seats

---

## 💡 Best Practices & Pro Tips

> [!NOTE]
> Chatify widgets use an asynchronous lightweight script (~290KB). It will **never** slow down your page load speeds or affect SEO rankings.

> [!TIP]
> Enable AI Copilot auto-responses so repetitive visitor questions get answered instantly 24/7 without agent intervention.

> [!WARNING]
> Do not paste your private Supabase service key into client-facing HTML. Always use the provided anonymous publishable key!

---

### 📊 Comparing Chatify Service Plans

| Feature | Starter Plan | Enterprise Cluster |
|:---|:---|:---|
| 👥 Agent Seats | Up to 5 seats | Unlimited team seats |
| ⚡ Live Radar | 1,000 visitors/mo | 100,000+ concurrent |
| 🤖 AI Auto-Replies | Standard | Custom Claude + RAG |
| 💳 Monthly Pricing | $29 / month | Custom SLA |

---

### 💻 Installation Snippet

Embed this snippet right before the \`</body>\` tag of your website:

\`\`\`html
<!-- Chatify Live Widget -->
<script
  async
  src="https://chatify.io/widget.js"
  data-workspace-id="a0000000-0000-0000-0000-000000000001"
  data-color="#8b5cf6"
></script>
\`\`\`

Need more assistance? Chat with our live support engineers anytime!`;

  const { data: existing } = await supabase
    .from('articles')
    .select('id')
    .eq('workspace_id', 'a0000000-0000-0000-0000-000000000001')
    .limit(1)
    .single();

  if (existing?.id) {
    const { error } = await supabase
      .from('articles')
      .update({
        title: '🚀 Getting Started with Chatify Live Chat',
        content: sampleContent,
        summary: 'Learn how to configure live chat, operating hours, and embed your widget in 5 minutes.',
        status: 'published',
      })
      .eq('id', existing.id);

    if (error) console.error('Update error:', error);
    else console.log('✓ Successfully updated sample article with rich Markdown, Emojis, Headings, and Tables!');
  }
}

updateSampleArticle();
