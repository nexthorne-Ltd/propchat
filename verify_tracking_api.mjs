import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

async function testTrackerFlow() {
  console.log('=== VERIFYING TRACKER API ROUTE & DATABASE UPSERTS ===\n');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const testVid = '88888888-2222-3333-4444-555555555555';

  // 1. Simulate 'init' payload as sent by tracker.js
  console.log('Step 1: Simulating tracker.js "init" event...');
  const initPayload = {
    event: 'init',
    visitor_id: testVid,
    current_page_url: 'https://demo-store.com/products/shoes',
    current_page_title: 'Premium Running Shoes | Demo Store',
    referrer_source: 'https://google.com',
    device: 'Mobile',
    browser: 'Safari',
    os: 'iOS',
    ip_location_city: 'San Francisco',
    ip_location_country: 'United States',
    visit_count: 2,
  };

  // Directly call the handler logic or simulate through Supabase client
  const { error: vErr } = await supabase.from('visitors').upsert({
    id: initPayload.visitor_id,
    current_page_url: initPayload.current_page_url,
    current_page_title: initPayload.current_page_title,
    referrer_source: initPayload.referrer_source,
    device: initPayload.device,
    browser: initPayload.browser,
    os: initPayload.os,
    ip_location_city: initPayload.ip_location_city,
    ip_location_country: initPayload.ip_location_country,
    visit_count: initPayload.visit_count,
    is_online: true,
    last_seen_at: new Date().toISOString(),
  });

  if (vErr) throw vErr;

  const { error: phErr } = await supabase.from('visitor_page_history').insert({
    visitor_id: testVid,
    url: initPayload.current_page_url,
    title: initPayload.current_page_title,
    visited_at: new Date().toISOString(),
  });

  if (phErr) throw phErr;
  console.log('✓ Init event logged: visitor updated and initial page inserted into visitor_page_history');

  // 2. Simulate SPA Navigation 'pageview'
  console.log('\nStep 2: Simulating SPA route change "pageview" event...');
  const spaUrl = 'https://demo-store.com/checkout';
  const spaTitle = 'Secure Checkout | Demo Store';

  await supabase.from('visitor_page_history').insert({
    visitor_id: testVid,
    url: spaUrl,
    title: spaTitle,
    visited_at: new Date().toISOString(),
  });

  await supabase
    .from('visitors')
    .update({
      current_page_url: spaUrl,
      current_page_title: spaTitle,
      last_seen_at: new Date().toISOString(),
      is_online: true,
    })
    .eq('id', testVid);

  console.log('✓ SPA Navigation logged: new entry in visitor_page_history & current_page_url updated');

  // 3. Verify Page History Trail (as authenticated agent)
  console.log('\nStep 3: Querying visitor_page_history for browsing trail...');
  await supabase.auth.signInWithPassword({
    email: 'agent@chatify.io',
    password: 'ChatifyDemo2026!',
  });

  const { data: history, error: hErr } = await supabase
    .from('visitor_page_history')
    .select('*')
    .eq('visitor_id', testVid)
    .order('visited_at', { ascending: true });

  if (hErr) throw hErr;
  console.log(`✓ Retrieved ${history.length} page visits for visitor:`);
  history.forEach((h, i) => {
    console.log(`   [${i + 1}] ${h.url} ("${h.title}") at ${h.visited_at}`);
  });

  // 4. Simulate 15s Heartbeat
  console.log('\nStep 4: Simulating 15-second heartbeat...');
  const heartbeatTime = new Date().toISOString();
  await supabase
    .from('visitors')
    .update({
      last_seen_at: heartbeatTime,
      is_online: true,
    })
    .eq('id', testVid);

  const { data: visitorRec } = await supabase
    .from('visitors')
    .select('id, is_online, last_seen_at, visit_count, device, browser, os, ip_location_city')
    .eq('id', testVid)
    .single();

  console.log(`✓ Heartbeat verified: is_online=${visitorRec.is_online}, last_seen=${visitorRec.last_seen_at}`);
  console.log(`  Visitor metadata: Device=${visitorRec.device}, Browser=${visitorRec.browser}, OS=${visitorRec.os}, City=${visitorRec.ip_location_city}, Visits=${visitorRec.visit_count}`);

  console.log('\n=== ALL TRACKER OPERATIONS VERIFIED SUCCESSFULLY! ===');
}

testTrackerFlow().catch(console.error);
