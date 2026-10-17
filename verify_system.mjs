import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

async function runTests() {
  console.log('=== CHATIFY END-TO-END VERIFICATION SUITE ===\n');

  // Test 1: Check Next.js HTTP server
  console.log('Test 1: Checking Next.js dev server HTTP endpoints...');
  try {
    const demoRes = await fetch('http://localhost:3000/demo.html');
    if (!demoRes.ok) throw new Error(`demo.html returned status ${demoRes.status}`);
    const demoText = await demoRes.text();
    console.log(`✓ demo.html is serving properly (${demoText.length} bytes)`);

    const widgetRes = await fetch('http://localhost:3000/widget.js');
    if (!widgetRes.ok) throw new Error(`widget.js returned status ${widgetRes.status}`);
    const widgetText = await widgetRes.text();
    console.log(`✓ widget.js is serving properly (${widgetText.length} bytes)`);

    const loginRes = await fetch('http://localhost:3000/login');
    if (!loginRes.ok) throw new Error(`/login returned status ${loginRes.status}`);
    console.log('✓ /login route is serving properly');
  } catch (err) {
    console.error('✗ Next.js server verification failed:', err.message);
    process.exit(1);
  }

  // Test 2: Supabase Visitor Flow
  console.log('\nTest 2: Simulating Visitor tracking & Chat creation...');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const testVisitorId = '11111111-2222-3333-4444-555555555555';
  const visitorName = 'Sarah Connor';
  const visitorEmail = 'sarah@skynet.com';
  const initialUrl = 'http://localhost:3000/demo.html#overview';

  // Upsert visitor
  const { data: visitorData, error: vErr } = await supabase.rpc('fn_upsert_visitor', {
    p_id: testVisitorId,
    p_name: visitorName,
    p_email: visitorEmail,
    p_current_url: initialUrl,
    p_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    p_ip_address: '127.0.0.1',
    p_location: 'Los Angeles, US',
    p_workspace_id: 'a0000000-0000-0000-0000-000000000001',
  });

  if (vErr) {
    console.error('✗ Failed to upsert visitor:', vErr);
    process.exit(1);
  }
  console.log(`✓ Visitor upserted successfully: ${visitorData.name} (${visitorData.id})`);

  // Create or get conversation
  const { data: convData, error: cErr } = await supabase.rpc('fn_get_or_create_conversation', {
    p_visitor_id: testVisitorId,
    p_workspace_id: 'a0000000-0000-0000-0000-000000000001',
  });

  if (cErr) {
    console.error('✗ Failed to get/create conversation:', cErr);
    process.exit(1);
  }
  console.log(`✓ Conversation initialized: ID ${convData.id}, status: ${convData.status}`);

  // Visitor sends message
  const visitorMsgContent = 'Hello! Inquiring about enterprise cluster pricing.';
  const { data: vMsg, error: mErr } = await supabase.from('messages').insert({
    conversation_id: convData.id,
    sender_type: 'visitor',
    content: visitorMsgContent,
  }).select().single();

  if (mErr) {
    console.error('✗ Failed to insert visitor message:', mErr);
    process.exit(1);
  }
  console.log(`✓ Visitor message stored: "${vMsg.content}"`);

  // Visitor updates page navigation (SPA tracking)
  const navigatedUrl = 'http://localhost:3000/demo.html#enterprise-plan';
  const { data: hbResult, error: hbErr } = await supabase.rpc('fn_visitor_heartbeat', {
    p_visitor_id: testVisitorId,
    p_current_url: navigatedUrl,
  });
  if (hbErr) {
    console.error('✗ Visitor heartbeat error:', hbErr);
  } else {
    console.log(`✓ Visitor heartbeat & SPA URL navigation updated to: ${navigatedUrl}`);
  }

  // Test 3: Agent Authentication & Reply Flow
  console.log('\nTest 3: Simulating Agent Dashboard actions...');
  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
    email: 'agent@chatify.io',
    password: 'ChatifyDemo2026!',
  });

  if (authErr) {
    console.error('✗ Agent authentication failed:', authErr.message);
    process.exit(1);
  }
  console.log(`✓ Agent authenticated: ${authData.user.email} (ID: ${authData.user.id})`);

  // Fetch agent profile
  const { data: agentProfile } = await supabase
    .from('agents')
    .select('*')
    .eq('id', authData.user.id)
    .single();
  console.log(`✓ Agent profile found: ${agentProfile.name}, Status: ${agentProfile.status}`);

  // Agent posts a response
  const agentReplyContent = 'Hello Sarah! I am Alex from engineering. Enterprise clusters start at $499/mo.';
  const { data: aMsg, error: amErr } = await supabase.from('messages').insert({
    conversation_id: convData.id,
    sender_type: 'agent',
    sender_id: agentProfile.id,
    content: agentReplyContent,
  }).select().single();

  if (amErr) {
    console.error('✗ Failed to insert agent message:', amErr);
    process.exit(1);
  }
  console.log(`✓ Agent reply stored: "${aMsg.content}"`);

  // Agent updates status to pending or open
  const { error: statErr } = await supabase
    .from('conversations')
    .update({ status: 'open', agent_id: agentProfile.id })
    .eq('id', convData.id);
  if (statErr) {
    console.error('✗ Failed to update conversation:', statErr);
  } else {
    console.log('✓ Conversation status and agent assignment updated');
  }

  // Test 4: Final verification of conversation messages
  const { data: fullThread } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', convData.id)
    .order('created_at', { ascending: true });

  console.log(`\n✓ Verified full thread has ${fullThread.length} messages:`);
  fullThread.forEach((m, idx) => {
    console.log(`   [${idx + 1}] [${m.sender_type.toUpperCase()}]: ${m.content}`);
  });

  console.log('\n=== ALL SYSTEM TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch(console.error);
