import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';
const WORKSPACE_ID = 'a0000000-0000-0000-0000-000000000001';

async function verifyHelpTabCustomization() {
  console.log('=== VERIFYING HELP CENTER TAB CUSTOMIZATION & RENAMING ===\n');

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Authenticate as agent
  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
    email: 'agent@chatify.io',
    password: 'ChatifyDemo2026!',
  });
  if (authErr || !authData.user) {
    throw new Error('Agent authentication failed');
  }
  console.log('✓ Step 1: Agent authenticated successfully.');

  // 2. Fetch initial workspace config via RPC
  const { data: initialConfig, error: rpcErr1 } = await supabase.rpc('fn_get_workspace_config', {
    p_workspace_id: WORKSPACE_ID,
  });
  if (rpcErr1) throw rpcErr1;
  console.log('✓ Step 2: Initial config read:', {
    help_center_tab_label: initialConfig.help_center_tab_label,
    show_help_tab: initialConfig.show_help_tab,
    help_center_tab_icon: initialConfig.help_center_tab_icon,
  });

  // 3. Update tab settings to custom label "Knowledge Base" and icon "📚"
  console.log('\nTesting tab renaming to "Knowledge Base"...');
  const { data: updatedWs, error: updateErr } = await supabase
    .from('workspaces')
    .update({
      help_center_tab_label: 'Knowledge Base',
      show_help_tab: true,
      help_center_tab_icon: '📚',
    })
    .eq('id', WORKSPACE_ID)
    .select()
    .single();

  if (updateErr) throw updateErr;
  console.log('✓ Step 3: Workspace updated directly in DB.');

  // 4. Verify RPC returns renamed tab for website visitors
  const { data: publicConfig, error: rpcErr2 } = await supabase.rpc('fn_get_workspace_config', {
    p_workspace_id: WORKSPACE_ID,
  });
  if (rpcErr2) throw rpcErr2;

  if (publicConfig.help_center_tab_label !== 'Knowledge Base' || publicConfig.help_center_tab_icon !== '📚') {
    throw new Error(`RPC did not reflect renamed tab! Found: ${JSON.stringify(publicConfig)}`);
  }
  console.log('✓ Step 4: Public RPC successfully returned updated tab label & icon to widget:', {
    label: publicConfig.help_center_tab_label,
    icon: publicConfig.help_center_tab_icon,
    showHelp: publicConfig.show_help_tab,
  });

  // 5. Test tab renaming to Urdu/custom name "Madad Markaz" (Help Center)
  console.log('\nTesting custom tab renaming to "Madad Markaz"...');
  const { error: customErr } = await supabase
    .from('workspaces')
    .update({
      help_center_tab_label: 'Madad Markaz',
      help_center_tab_icon: '💡',
    })
    .eq('id', WORKSPACE_ID);
  if (customErr) throw customErr;

  const { data: customConfig } = await supabase.rpc('fn_get_workspace_config', {
    p_workspace_id: WORKSPACE_ID,
  });
  if (customConfig.help_center_tab_label !== 'Madad Markaz') {
    throw new Error('Custom naming failed');
  }
  console.log('✓ Step 5: Custom renaming to "Madad Markaz" verified successfully!');

  // Set to clean standard: "Help Center"
  await supabase
    .from('workspaces')
    .update({
      help_center_tab_label: 'Help Center',
      help_center_tab_icon: '📖',
      show_help_tab: true,
    })
    .eq('id', WORKSPACE_ID);

  console.log('\n=== ALL WIDGET TAB RENAMING & CUSTOMIZATION TESTS PASSED 100%! ===');
}

verifyHelpTabCustomization().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
