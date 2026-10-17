import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

// Parse .env.local
const envContent = fs.readFileSync('.env.local', 'utf8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    process.env[key] = val;
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('Missing credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false }
});

async function main() {
  console.log('1. Cleaning up demo and null workspace canned responses...');
  
  // Delete null workspace canned responses
  const { error: delNullErr } = await supabase
    .from('canned_responses')
    .delete()
    .is('workspace_id', null);
  if (delNullErr) console.error('Error deleting null workspace_id:', delNullErr);
  else console.log('Deleted null workspace_id canned responses.');

  // Delete demo canned responses
  const { error: delDemoErr } = await supabase
    .from('canned_responses')
    .delete()
    .in('shortcut', ['pricing', 'solved', '/refund-policy', 'sla_guarantee', 'wait']);
  if (delDemoErr) console.error('Error deleting demo shortcuts:', delDemoErr);
  else console.log('Deleted demo shortcuts.');

  // Now seed two generic saved replies for active workspaces
  console.log('\n2. Seeding generic saved replies for all active workspaces...');
  const { data: workspaces, error: wsErr } = await supabase
    .from('workspaces')
    .select('id, name')
    .is('deleted_at', null);

  if (wsErr || !workspaces) {
    console.error('Error fetching workspaces:', wsErr);
    return;
  }

  for (const ws of workspaces) {
    // 1. Greeting
    const { data: existingHello } = await supabase
      .from('canned_responses')
      .select('id')
      .eq('workspace_id', ws.id)
      .eq('shortcut', 'hello')
      .maybeSingle();

    if (!existingHello) {
      await supabase.from('canned_responses').insert({
        workspace_id: ws.id,
        title: 'Greeting',
        shortcut: 'hello',
        content: 'Hi there! Thanks for reaching out. How can I help you today?',
      });
    } else {
      await supabase.from('canned_responses').update({
        title: 'Greeting',
        content: 'Hi there! Thanks for reaching out. How can I help you today?',
      }).eq('id', existingHello.id);
    }

    // 2. We're checking
    const { data: existingChecking } = await supabase
      .from('canned_responses')
      .select('id')
      .eq('workspace_id', ws.id)
      .eq('shortcut', 'checking')
      .maybeSingle();

    if (!existingChecking) {
      await supabase.from('canned_responses').insert({
        workspace_id: ws.id,
        title: "We're checking",
        shortcut: 'checking',
        content: "Thanks for your patience! I'm looking into this for you right now and will update you shortly.",
      });
    } else {
      await supabase.from('canned_responses').update({
        title: "We're checking",
        content: "Thanks for your patience! I'm looking into this for you right now and will update you shortly.",
      }).eq('id', existingChecking.id);
    }
  }

  console.log(`Seeded generic saved replies for ${workspaces.length} workspaces.`);

  // Verify
  const { data: afterRows } = await supabase
    .from('canned_responses')
    .select('id, workspace_id, title, shortcut');
  console.log(`Total canned_responses now: ${afterRows?.length}`);
  console.log('Sample rows:', afterRows?.slice(0, 6));
}

main().catch(console.error);
