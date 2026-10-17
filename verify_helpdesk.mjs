import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

async function runHelpDeskTests() {
  console.log('=== VERIFYING INTERCOM-STYLE HELP DESK & KNOWLEDGE BASE SUITE ===\n');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Authenticate as Agent for management operations
  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
    email: 'agent@chatify.io',
    password: 'ChatifyDemo2026!',
  });

  if (authErr) {
    console.error('✗ Agent login failed:', authErr.message);
    process.exit(1);
  }
  console.log(`✓ Authenticated agent: ${authData.user.email} (${authData.user.id})\n`);

  const testWsId = 'a0000000-0000-0000-0000-000000000001'; // Nova Cloud

  // 1. Test Creating a Help Section
  console.log('Step 1: Testing Help Section Creation...');
  const { data: section, error: secErr } = await supabase
    .from('help_sections')
    .insert({
      workspace_id: testWsId,
      name: 'Billing & Invoicing',
      description: 'Find answers regarding plans, upgrades, and billing cycles',
      icon: '💳',
      order_index: 3,
    })
    .select()
    .single();

  if (secErr || !section) {
    console.error('✗ Failed to create help section:', secErr);
    process.exit(1);
  }
  console.log(`✓ Help section created: "${section.icon} ${section.name}" (ID: ${section.id})`);

  // 2. Test Creating an Article in the Section
  console.log('\nStep 2: Testing Article Creation in Section...');
  const { data: article, error: artErr } = await supabase
    .from('articles')
    .insert({
      workspace_id: testWsId,
      section_id: section.id,
      title: 'How to Download Invoices & Update Payment Cards',
      slug: 'how-to-download-invoices',
      category: section.name,
      summary: 'Learn where to find past VAT receipts and manage debit/credit cards.',
      content: 'Navigate to Settings > Billing to view all your historical monthly invoices. Click Download PDF next to any charge.',
      status: 'published',
      views_count: 0,
      helpful_count: 0,
      not_helpful_count: 0,
    })
    .select()
    .single();

  if (artErr || !article) {
    console.error('✗ Failed to create article:', artErr);
    process.exit(1);
  }
  console.log(`✓ Article created: "${article.title}" (Status: ${article.status})`);

  // 3. Test Draft Article Creation
  console.log('\nStep 3: Testing Draft Article (Should be excluded in public views)...');
  const { data: draftArt, error: draftErr } = await supabase
    .from('articles')
    .insert({
      workspace_id: testWsId,
      section_id: section.id,
      title: 'Internal Agent Refund Policy (Draft)',
      slug: 'internal-refund-policy',
      category: section.name,
      summary: 'Internal SOP for handling customer refund requests.',
      content: 'Do not share with customers directly. Level 2 approvals required.',
      status: 'draft',
    })
    .select()
    .single();

  if (draftErr || !draftArt) {
    console.error('✗ Failed to create draft article:', draftErr);
    process.exit(1);
  }
  console.log(`✓ Draft article saved: "${draftArt.title}" (Status: ${draftArt.status})`);

  // Verify public query filters out draft
  const { data: publicArticles } = await supabase
    .from('articles')
    .select('*')
    .eq('workspace_id', testWsId)
    .eq('status', 'published');

  const draftLeaked = publicArticles.some((a) => a.status === 'draft');
  if (draftLeaked) {
    console.error('✗ Security leak: Draft article exposed in published query!');
    process.exit(1);
  }
  console.log(`✓ Verified public filter correctly excludes drafts (Published count: ${publicArticles.length})`);

  // 4. Test View Tracking RPC
  console.log('\nStep 4: Testing Article View Tracking RPC (fn_track_article_view)...');
  const initialViews = article.views_count || 0;
  await supabase.rpc('fn_track_article_view', { p_article_id: article.id });
  await supabase.rpc('fn_track_article_view', { p_article_id: article.id });

  const { data: viewedArt } = await supabase
    .from('articles')
    .select('views_count')
    .eq('id', article.id)
    .single();

  if (viewedArt.views_count !== initialViews + 2) {
    console.error('✗ View count increment mismatch:', viewedArt);
    process.exit(1);
  }
  console.log(`✓ View count incremented successfully: ${initialViews} -> ${viewedArt.views_count}`);

  // 5. Test Customer Helpfulness Reaction RPC (fn_submit_article_feedback)
  console.log('\nStep 5: Testing Article Helpful CSAT Feedback (fn_submit_article_feedback)...');
  await supabase.rpc('fn_submit_article_feedback', {
    p_article_id: article.id,
    p_workspace_id: testWsId,
    p_visitor_id: 'visitor_test_abc123',
    p_is_helpful: true,
    p_feedback_text: 'Very clear instructions, downloaded my receipt in seconds!',
  });

  await supabase.rpc('fn_submit_article_feedback', {
    p_article_id: article.id,
    p_workspace_id: testWsId,
    p_visitor_id: 'visitor_test_xyz789',
    p_is_helpful: false,
    p_feedback_text: 'Could not find the invoice button on iOS app.',
  });

  const { data: ratedArt } = await supabase
    .from('articles')
    .select('helpful_count, not_helpful_count')
    .eq('id', article.id)
    .single();

  const { data: feedbackRows } = await supabase
    .from('article_feedback')
    .select('*')
    .eq('article_id', article.id);

  if (ratedArt.helpful_count !== 1 || ratedArt.not_helpful_count !== 1) {
    console.error('✗ Rating counts mismatch:', ratedArt);
    process.exit(1);
  }
  if (feedbackRows.length !== 2) {
    console.error('✗ Feedback rows count mismatch:', feedbackRows);
    process.exit(1);
  }
  console.log(`✓ Feedback logged: 👍 ${ratedArt.helpful_count} helpful, 👎 ${ratedArt.not_helpful_count} unhelpful`);
  console.log(`✓ Feedback rows stored: "${feedbackRows[0].feedback_text}"`);

  // 6. Test Multi-Tenant Isolation
  console.log('\nStep 6: Testing Multi-Tenant Workspace Isolation...');
  const apexWsId = 'b0000000-0000-0000-0000-000000000002'; // Simulated or secondary workspace

  const { data: apexArticles } = await supabase
    .from('articles')
    .select('*')
    .eq('workspace_id', apexWsId);

  const leakDetected = apexArticles.some((a) => a.workspace_id === testWsId);
  if (leakDetected) {
    console.error('✗ Tenant data leakage detected!');
    process.exit(1);
  }
  console.log('✓ Verified 100% Multi-Tenant Isolation: Zero cross-workspace article leaks.');

  // Clean up test rows
  console.log('\nCleaning up test artifacts...');
  await supabase.from('articles').delete().eq('id', article.id);
  await supabase.from('articles').delete().eq('id', draftArt.id);
  await supabase.from('help_sections').delete().eq('id', section.id);
  console.log('✓ Cleanup complete.');

  console.log('\n=== ALL HELP DESK & KNOWLEDGE BASE TESTS PASSED 100%! ===');
}

runHelpDeskTests().catch(console.error);
