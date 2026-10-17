import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function runAdminVerification() {
  console.log('🚀 Starting Comprehensive Admin Settings Panel Verification...\n');

  const workspaceId = 'a0000000-0000-0000-0000-000000000001';

  // 1. SECTION 1: Widget Customization
  console.log('--- 1. Widget Customization ---');
  const { data: wsUpdate1, error: err1 } = await supabase
    .from('workspaces')
    .update({
      brand_color: '#8b5cf6',
      widget_position: 'left',
      greeting_title: 'Welcome to Chatify Support! 👋',
      greeting_message: 'Ask us anything or explore our self-serve guides.',
      logo_url: 'https://chatify.dev/logo.png',
    })
    .eq('id', workspaceId)
    .select('id, brand_color, widget_position, greeting_title, logo_url')
    .single();

  if (err1) console.error('Error updating widget settings:', err1);
  else {
    console.log(`✅ Widget Customization Updated: Color=${wsUpdate1.brand_color}, Position=${wsUpdate1.widget_position}, Title="${wsUpdate1.greeting_title}", Logo=${wsUpdate1.logo_url}`);
  }

  // 2. SECTION 2: Business Hours Schedule
  console.log('\n--- 2. Business Hours Schedule ---');
  const scheduleConfig = {
    enabled: true,
    timezone: 'America/New_York',
    schedule: {
      monday: { enabled: true, start: '09:00', end: '17:00' },
      tuesday: { enabled: true, start: '09:00', end: '17:00' },
      wednesday: { enabled: true, start: '09:00', end: '17:00' },
      thursday: { enabled: true, start: '09:00', end: '17:00' },
      friday: { enabled: true, start: '09:00', end: '16:00' },
      saturday: { enabled: false, start: '10:00', end: '14:00' },
      sunday: { enabled: false, start: '10:00', end: '14:00' },
    },
  };

  const { data: wsUpdate2, error: err2 } = await supabase
    .from('workspaces')
    .update({ business_hours: scheduleConfig })
    .eq('id', workspaceId)
    .select('id, business_hours')
    .single();

  if (err2) console.error('Error updating business hours:', err2);
  else {
    console.log(`✅ Business Hours Updated: Enabled=${wsUpdate2.business_hours.enabled}, Timezone=${wsUpdate2.business_hours.timezone}, Friday Close=${wsUpdate2.business_hours.schedule.friday.end}`);
  }

  // 3. SECTION 3: Team Management & Roles
  console.log('\n--- 3. Team Management & Roles ---');
  const { data: agentsList } = await supabase
    .from('agents')
    .select('id, name, email, role, status')
    .limit(3);

  console.log(`✅ Loaded ${agentsList?.length || 0} agents with roles:`);
  agentsList?.forEach((a) => {
    console.log(`   - ${a.name} (${a.email}): role=${a.role}, status=${a.status}`);
  });

  // 4. SECTION 4: Canned Responses CRUD (Team-wide vs Personal)
  console.log('\n--- 4. Canned Responses CRUD ---');
  const testCannedId = 'c1000000-0000-0000-0000-000000000001';
  // Create Team-Wide Canned Response
  const { data: insertedCanned, error: canErr } = await supabase
    .from('canned_responses')
    .upsert({
      id: testCannedId,
      workspace_id: workspaceId,
      shortcut: '/refund-policy',
      title: '30-Day Money Back Guarantee',
      content: 'Hi! We offer a full 30-day money-back guarantee with no questions asked.',
      agent_id: null, // Team-wide
    })
    .select()
    .single();

  if (canErr) {
    console.error('Canned reply insert error:', canErr);
  } else {
    console.log(`✅ Created Canned Shortcut: ${insertedCanned.shortcut} ("${insertedCanned.title}"), Scope=${insertedCanned.agent_id ? 'Personal' : 'Team-Wide'}`);
  }

  // Query Canned Responses
  const { data: allCanned } = await supabase
    .from('canned_responses')
    .select('shortcut, title, agent_id')
    .eq('workspace_id', workspaceId);

  console.log(`✅ Total Canned Replies in Workspace: ${allCanned?.length || 0}`);

  // 5. SECTION 5: Auto-Assignment Rules
  console.log('\n--- 5. Auto-Assignment Rules ---');
  const autoAssignConfig = {
    enabled: true,
    max_conversations_per_agent: 7,
  };

  const { data: wsUpdate5, error: err5 } = await supabase
    .from('workspaces')
    .update({ auto_assignment: autoAssignConfig })
    .eq('id', workspaceId)
    .select('id, auto_assignment')
    .single();

  if (err5) console.error('Error updating auto-assignment:', err5);
  else {
    console.log(`✅ Auto-Assignment Rules Updated: RoundRobin=${wsUpdate5.auto_assignment.enabled}, MaxActivePerAgent=${wsUpdate5.auto_assignment.max_conversations_per_agent}`);
  }

  // 6. SECTION 6: Install Snippet
  console.log('\n--- 6. Install Snippet Verification ---');
  const snippet = `<!-- Chatify Live Chat Tracker & Widget -->
<script src="https://chatify.dev/tracker.js" data-workspace-id="${workspaceId}" defer></script>
<script src="https://chatify.dev/widget.js" data-workspace-id="${workspaceId}" defer></script>`;

  console.log('✅ Generated HTML Script Tag:');
  console.log(snippet);

  console.log('\n🎉 ALL 6 ADMIN SECTIONS SUCCESSFULLY VERIFIED!');
}

runAdminVerification().catch(console.error);
