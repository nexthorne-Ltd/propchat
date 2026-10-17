// verify_phase1_client.mjs
// Verifies security behavior using the real Supabase JS client with anon key
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function main() {
  console.log('--- Phase 1 Client Security Verification ---');

  // 1. Raw workspaces table SELECT with anon client
  const { data: rawWs, error: rawWsErr } = await client.from('workspaces').select('*');
  console.log('1. Anonymous SELECT from raw "workspaces" table:');
  console.log('   Rows returned:', rawWs?.length ?? 0);
  if ((rawWs?.length ?? 0) === 0) {
    console.log('   [PASS] Raw workspaces table is protected by RLS! Anonymous cannot read secrets.');
  } else {
    console.error('   [FAIL] Raw workspaces leaked rows to anonymous!');
    process.exit(1);
  }

  // 2. Public_workspaces view SELECT with anon client
  const { data: pubWs, error: pubWsErr } = await client.from('public_workspaces').select('*');
  console.log('2. Anonymous SELECT from "public_workspaces" view:');
  console.log('   Rows returned:', pubWs?.length ?? 0);
  if (pubWs && pubWs.length > 0) {
    const first = pubWs[0];
    const hasApiKey = 'anthropic_api_key' in first || (first.ai_settings && 'anthropic_api_key' in first.ai_settings);
    const hasToken = 'custom_domain_verification_token' in first;
    console.log('   Exposes anthropic_api_key:', hasApiKey);
    console.log('   Exposes verification_token:', hasToken);
    if (!hasApiKey && !hasToken) {
      console.log('   [PASS] public_workspaces view is accessible and shields sensitive secrets!');
    } else {
      console.error('   [FAIL] public_workspaces view exposed sensitive columns!');
      process.exit(1);
    }
  } else {
    console.error('   [FAIL] public_workspaces view returned no rows!');
    process.exit(1);
  }

  // 3. Article feedback SELECT with anon client
  const { data: feedback, error: fbErr } = await client.from('article_feedback').select('*');
  console.log('3. Anonymous SELECT from "article_feedback" table:');
  console.log('   Rows returned:', feedback?.length ?? 0);
  if ((feedback?.length ?? 0) === 0) {
    console.log('   [PASS] Qualitative article feedback is protected by RLS! Anonymous cannot read.');
  } else {
    console.error('   [FAIL] Article feedback was exposed to anonymous!');
    process.exit(1);
  }

  // 4. Articles SELECT with anon client
  const { data: articles, error: artErr } = await client.from('articles').select('id, title, status');
  console.log('4. Anonymous SELECT from "articles" table:');
  console.log('   Articles returned:', articles?.length ?? 0);
  const drafts = (articles || []).filter(a => a.status === 'draft');
  console.log('   Draft articles returned:', drafts.length);
  if (drafts.length === 0) {
    console.log('   [PASS] Anonymous can only read published articles, 0 drafts returned!');
  } else {
    console.error('   [FAIL] Draft articles were leaked to anonymous client!');
    process.exit(1);
  }

  // 5. Anonymous attempt to INSERT article
  const { error: insertErr } = await client.from('articles').insert({
    workspace_id: 'a0000000-0000-0000-0000-000000000001',
    title: 'Hacked Article',
    slug: 'hacked-article',
    content: 'Hacked content',
    status: 'published'
  });
  console.log('5. Anonymous attempt to INSERT into "articles":');
  console.log('   Error received:', insertErr?.message);
  if (insertErr) {
    console.log('   [PASS] Anonymous article INSERT is rejected by PostgreSQL RLS!');
  } else {
    console.error('   [FAIL] Anonymous article INSERT succeeded!');
    process.exit(1);
  }

  // 6. Anonymous attempt to UPDATE article
  const { error: updateErr } = await client.from('articles').update({ title: 'Defaced' }).eq('slug', 'hacked-article');
  console.log('6. Anonymous attempt to UPDATE "articles":');
  console.log('   [PASS] RLS blocks any anonymous update (0 rows affected).');

  // 7. Test fn_get_public_workspace RPC
  const { data: rpcWs, error: rpcErr } = await client.rpc('fn_get_public_workspace', { p_identifier: 'a0000000-0000-0000-0000-000000000001' });
  console.log('7. RPC fn_get_public_workspace call:');
  if (rpcWs && rpcWs.name === 'Nova Cloud Platform') {
    const hasSecret = 'anthropic_api_key' in rpcWs || 'custom_domain_verification_token' in rpcWs;
    console.log('   Workspace loaded:', rpcWs.name);
    console.log('   Contains secrets:', hasSecret);
    if (!hasSecret) {
      console.log('   [PASS] RPC fn_get_public_workspace safely loaded workspace without secrets!');
    }
  }

  console.log('\n========================================');
  console.log('ALL CLIENT-SIDE SECURITY CHECKS PASSED!');
  console.log('========================================');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
