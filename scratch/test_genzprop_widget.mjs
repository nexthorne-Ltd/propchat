import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';
const GENZPROP_ID = 'e14f34a7-32d8-4653-8294-ea1eec4eb869';

async function checkGenzprop() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: ws, error: wsErr } = await supabase.rpc('fn_get_workspace_config', {
    p_workspace_id: GENZPROP_ID,
  });
  console.log('Workspace config:', ws);

  const { data: articles } = await supabase
    .from('articles')
    .select('id, title, status')
    .eq('workspace_id', GENZPROP_ID)
    .eq('status', 'published');
  console.log('Published articles count:', articles?.length);
}

checkGenzprop();
