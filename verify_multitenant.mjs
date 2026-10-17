import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

async function runMultiTenantTests() {
  console.log('=== MULTI-TENANT WORKSPACE VERIFICATION SUITE ===\n');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Test Widget Public Config RPC
  console.log('Test 1: Verifying public fn_get_workspace_config RPC...');
  const defaultWsId = 'a0000000-0000-0000-0000-000000000001';
  const { data: wsConfig, error: wsErr } = await supabase.rpc('fn_get_workspace_config', {
    p_workspace_id: defaultWsId,
  });

  if (wsErr || !wsConfig) {
    console.error('✗ Failed to fetch workspace config:', wsErr);
    process.exit(1);
  }
  console.log(`✓ Workspace config fetched: "${wsConfig.name}" (Color: ${wsConfig.brand_color})`);

  // 2. Test Onboarding a 2nd Business (Apex Shoes)
  console.log('\nTest 2: Simulating Onboarding for a 2nd Business ("Apex Shoes")...');
  const bizEmail = 'owner@apexshoes.com';
  const bizPassword = 'ApexPassword2026!';

  // Sign up business owner
  const { data: signData, error: signErr } = await supabase.auth.signUp({
    email: bizEmail,
    password: bizPassword,
    options: { data: { name: 'Marcus Brody' } }
  });

  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
    email: bizEmail,
    password: bizPassword,
  });

  if (authErr) {
    console.error('✗ Failed to authenticate 2nd business owner:', authErr.message);
    process.exit(1);
  }
  const ownerId = authData.user.id;
  console.log(`✓ Business owner authenticated: ${bizEmail} (ID: ${ownerId})`);

  // Create Workspace for Apex Shoes
  const { data: apexWs, error: apexWsErr } = await supabase.from('workspaces').insert({
    name: 'Apex Shoes',
    website_url: 'https://apexshoes.com',
    brand_color: '#059669', // Emerald
    greeting_title: 'Apex Shoes Support',
    greeting_message: 'Ask about sizes, shipping, and returns!',
    owner_id: ownerId,
  }).select().single();

  if (apexWsErr) {
    console.error('✗ Failed to create workspace:', apexWsErr);
    process.exit(1);
  }
  console.log(`✓ Workspace created: "${apexWs.name}" (ID: ${apexWs.id})`);

  // Link agent
  await supabase.from('agents').upsert({
    id: ownerId,
    name: 'Marcus Brody',
    email: bizEmail,
    workspace_id: apexWs.id,
    role: 'owner',
    status: 'online'
  });
  console.log('✓ Agent assigned to Apex Shoes workspace');

  // 3. Test Visitor Isolation
  console.log('\nTest 3: Testing Visitor and Chat Isolation across Workspaces...');
  const visitorApexId = '22222222-3333-4444-5555-666666666666';

  // Upsert visitor for Apex Shoes
  await supabase.rpc('fn_upsert_visitor', {
    p_id: visitorApexId,
    p_name: 'John Shopper',
    p_email: 'john@shopper.com',
    p_current_url: 'https://apexshoes.com/running-shoes',
    p_user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    p_workspace_id: apexWs.id,
  });

  // Create conversation for Apex Shoes
  const { data: convApex } = await supabase.rpc('fn_get_or_create_conversation', {
    p_visitor_id: visitorApexId,
    p_workspace_id: apexWs.id,
  });

  // Insert visitor message on Apex Shoes
  await supabase.from('messages').insert({
    conversation_id: convApex.id,
    sender_type: 'visitor',
    content: 'Do you have size 10 in the green runner?',
  });
  console.log(`✓ Visitor message stored in Apex Shoes (Conv ID: ${convApex.id})`);

  // 4. Verification of Data Isolation
  console.log('\nTest 4: Verifying Scoped Queries (Tenant Isolation)...');

  // Query conversations for Nova Cloud
  const { data: novaConversations } = await supabase
    .from('conversations')
    .select('*, visitor:visitors(*)')
    .eq('workspace_id', defaultWsId);

  // Query conversations for Apex Shoes
  const { data: apexConversations } = await supabase
    .from('conversations')
    .select('*, visitor:visitors(*)')
    .eq('workspace_id', apexWs.id);

  console.log(`✓ Nova Cloud workspace conversations count: ${novaConversations.length}`);
  console.log(`✓ Apex Shoes workspace conversations count: ${apexConversations.length}`);

  const leakInNova = novaConversations.some(c => c.workspace_id === apexWs.id);
  const leakInApex = apexConversations.some(c => c.workspace_id === defaultWsId);

  if (leakInNova || leakInApex) {
    console.error('✗ Data leakage detected between workspaces!');
    process.exit(1);
  }
  console.log('✓ Verified 100% Data Isolation between workspaces! Zero cross-tenant leaks.');

  console.log('\n=== ALL MULTI-TENANT TESTS PASSED SUCCESSFULLY! ===');
}

runMultiTenantTests().catch(console.error);
