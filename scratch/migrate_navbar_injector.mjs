import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODI1MDkwMSwiZXhwIjoyMTAzODI2OTAxfQ.yIp9RiDyM9p9wNgwCDKw9r0dxFRBFgiKNjVHsHyJl5U';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function runMigration() {
  console.log('Running one-time migration for Navbar Trigger Auto-Injector...');

  const { data: workspaces, error: fetchErr } = await supabase
    .from('workspaces')
    .select('id, name, navbar_trigger_config');

  if (fetchErr) {
    console.error('Failed to fetch workspaces:', fetchErr);
    process.exit(1);
  }

  console.log(`Found ${workspaces.length} workspaces to migrate.`);

  for (const ws of workspaces) {
    const prev = ws.navbar_trigger_config || {};
    const updatedConfig = {
      enabled: false, // Turn injector OFF for every workspace
      label: (prev.label && prev.label !== 'FAQ') ? prev.label : 'Help',
      action: prev.action || 'help',
      style: prev.style || 'navbar_link',
      position: prev.position || 'end',
      auto_inject: true,
      target_selector: prev.target_selector || '',
      dismissed_prompt: false, // Ensure owners see the new card
    };

    const { error: updateErr } = await supabase
      .from('workspaces')
      .update({ navbar_trigger_config: updatedConfig })
      .eq('id', ws.id);

    if (updateErr) {
      console.error(`Error updating workspace ${ws.name} (${ws.id}):`, updateErr);
    } else {
      console.log(`✓ Workspace "${ws.name}" (${ws.id}) migrated: enabled=false, label="${updatedConfig.label}"`);
    }
  }

  console.log('One-time migration completed successfully.');
}

runMigration();
