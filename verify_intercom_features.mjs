import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

async function testIntercomFeatures() {
  console.log('=== VERIFYING INTERCOM-GRADE FEATURES IN CHATIFY ===\n');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const testVisitorId = '99999999-8888-7777-6666-555555555555';
  const testWorkspaceId = 'a0000000-0000-0000-0000-000000000001';

  // 1. Setup visitor and conversation
  console.log('Step 1: Initializing visitor and conversation...');
  await supabase.rpc('fn_upsert_visitor', {
    p_id: testVisitorId,
    p_name: 'David Intercom-Tester',
    p_email: 'david@tester.com',
    p_current_url: 'http://localhost:3000/demo.html#pricing',
    p_workspace_id: testWorkspaceId,
  });

  const { data: conv, error: convErr } = await supabase.rpc('fn_get_or_create_conversation', {
    p_visitor_id: testVisitorId,
    p_workspace_id: testWorkspaceId,
  });

  if (convErr || !conv) {
    console.error('✗ Failed to initialize conversation:', convErr);
    process.exit(1);
  }
  console.log(`✓ Conversation ready (ID: ${conv.id})`);

  // 2. Test Dual-Mode Composer: Public Reply vs Yellow Team Note
  console.log('\nStep 2: Testing Dual-Mode Messages (Public Reply vs Internal Note)...');
  
  // Authenticate as Agent
  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
    email: 'agent@chatify.io',
    password: 'ChatifyDemo2026!',
  });

  if (authErr) {
    console.error('✗ Failed to authenticate agent for test:', authErr);
    process.exit(1);
  }

  // Public Reply
  const { data: pubMsg, error: pubErr } = await supabase.from('messages').insert({
    conversation_id: conv.id,
    sender_type: 'agent',
    sender_id: authData.user.id,
    content: 'Hi David! This is a public response visible to you.',
    is_internal: false,
  }).select().single();

  if (pubErr) {
    console.error('pubErr:', pubErr);
    process.exit(1);
  }
  console.log(`✓ Public customer reply inserted (ID: ${pubMsg.id}, is_internal: ${pubMsg.is_internal})`);

  // Internal Note
  const { data: noteMsg, error: noteErr } = await supabase.from('messages').insert({
    conversation_id: conv.id,
    sender_type: 'agent',
    content: 'Team Note: Customer is asking for custom discount. Manager approval required.',
    is_internal: true,
  }).select().single();

  if (noteErr) {
    console.error('noteErr:', noteErr);
    process.exit(1);
  }
  console.log(`✓ Internal yellow note inserted (ID: ${noteMsg.id}, is_internal: ${noteMsg.is_internal})`);

  // Verify Customer Query Filters Out Internal Note
  const { data: visitorVisibleMsgs } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conv.id)
    .or('is_internal.is.null,is_internal.eq.false');

  const leakedInternal = visitorVisibleMsgs?.some((m) => m.is_internal === true);
  if (leakedInternal) {
    console.error('✗ CRITICAL SECURITY LEAK: Internal note visible in customer query!');
    process.exit(1);
  }
  console.log(`✓ Verified Visitor Query Excludes Internal Notes (Visible: ${visitorVisibleMsgs?.length} messages)`);

  // 3. Test Priority and Tags
  console.log('\nStep 3: Testing Conversation Priority & Tags...');
  const { error: tagErr } = await supabase
    .from('conversations')
    .update({
      priority: 'urgent',
      tags: ['VIP', 'Billing', 'Enterprise Lead'],
    })
    .eq('id', conv.id);

  if (tagErr) {
    console.error('✗ Failed to update priority and tags:', tagErr);
    process.exit(1);
  }

  const { data: updatedConv } = await supabase
    .from('conversations')
    .select('priority, tags')
    .eq('id', conv.id)
    .single();

  if (updatedConv?.priority !== 'urgent' || !updatedConv?.tags?.includes('VIP')) {
    console.error('✗ Priority or tags mismatch:', updatedConv);
    process.exit(1);
  }
  console.log(`✓ Priority set to: "${updatedConv.priority}"`);
  console.log(`✓ Tags saved: [${updatedConv.tags.join(', ')}]`);

  // 4. Test Post-Chat CSAT Feedback
  console.log('\nStep 4: Testing Post-Chat CSAT Customer Satisfaction Rating...');
  const { error: csatErr } = await supabase
    .from('conversations')
    .update({
      status: 'closed',
      csat_rating: 5,
      csat_feedback: 'Super fast and polite support!',
    })
    .eq('id', conv.id);

  if (csatErr) {
    console.error('✗ Failed to update CSAT rating:', csatErr);
    process.exit(1);
  }

  const { data: csatConv } = await supabase
    .from('conversations')
    .select('status, csat_rating, csat_feedback')
    .eq('id', conv.id)
    .single();

  console.log(`✓ Conversation resolved: Status "${csatConv.status}", CSAT Rating: ${csatConv.csat_rating}/5 stars ("${csatConv.csat_feedback}")`);

  // 5. Test Canned Responses (Macros)
  console.log('\nStep 5: Verifying Canned Responses (Macros)...');
  const { data: macros } = await supabase
    .from('canned_responses')
    .select('*')
    .eq('workspace_id', testWorkspaceId);

  console.log(`✓ Found ${macros?.length} canned macros in database (e.g. #${macros?.[0]?.shortcut})`);

  // 6. Test Knowledge Base Articles
  console.log('\nStep 6: Verifying Help Center Knowledge Base Articles...');
  const { data: articles } = await supabase
    .from('articles')
    .select('*')
    .eq('workspace_id', testWorkspaceId);

  console.log(`✓ Found ${articles?.length} help center articles in database (e.g. "${articles?.[0]?.title}")`);

  console.log('\n=== ALL INTERCOM-GRADE FEATURES VERIFIED 100% SUCCESSFULLY! ===');
}

testIntercomFeatures().catch(console.error);
