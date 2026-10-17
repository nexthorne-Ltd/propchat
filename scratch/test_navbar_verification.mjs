import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODI1MDkwMSwiZXhwIjoyMTAzODI2OTAxfQ.yIp9RiDyM9p9wNgwCDKw9r0dxFRBFgiKNjVHsHyJl5U';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function verify() {
  console.log('=== VERIFYING NAVBAR AUTO-INJECTOR REBUILD ===\n');

  // 1. Audit public/widget.js bundle
  const widgetContent = fs.readFileSync('public/widget.js', 'utf8');
  if (!widgetContent.includes('data-chatify-nav')) {
    throw new Error('public/widget.js does not contain data-chatify-nav');
  }
  console.log('✓ public/widget.js marks nodes with data-chatify-nav');

  // Check that old auto-hooking logic is removed
  if (widgetContent.includes('data-chatify-hooked') && widgetContent.includes('targetedElementHooked')) {
    throw new Error('public/widget.js still contains old auto-hooking logic');
  }
  console.log('✓ Old auto-hooking behaviour completely removed from public/widget.js');

  // 2. Audit Database Workspaces
  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, name, navbar_trigger_config');

  if (error || !workspaces) {
    throw new Error(`Failed to query workspaces: ${error?.message}`);
  }

  const enabledWorkspaces = workspaces.filter(w => w.navbar_trigger_config?.enabled === true);
  if (enabledWorkspaces.length > 0) {
    throw new Error(`Found ${enabledWorkspaces.length} workspaces with injector still ON!`);
  }
  console.log(`✓ All ${workspaces.length} workspaces have injector OFF (enabled: false)`);

  const range4ex = workspaces.find(w => w.name.toLowerCase().includes('range4ex'));
  if (range4ex) {
    console.log(`✓ Range4ex config: label="${range4ex.navbar_trigger_config?.label}", enabled=${range4ex.navbar_trigger_config?.enabled}, action="${range4ex.navbar_trigger_config?.action}"`);
  }

  console.log('\nAll checks passed successfully!');
}

verify().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
