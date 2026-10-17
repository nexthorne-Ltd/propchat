import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Parse .env.local manually
try {
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
} catch (e) {}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runVerification() {
  console.log('=== STARTING PUBLIC PAGES VERIFICATION ===\n');

  // 1. Verify dedicated "Chatify" workspace
  console.log('1. Checking dedicated "Chatify" workspace:');
  const { data: chatifyWs, error: wsErr } = await supabase
    .from('workspaces')
    .select('id, name, slug, brand_color, greeting_title, is_suspended, deleted_at')
    .eq('slug', 'chatify')
    .single();

  if (wsErr || !chatifyWs) {
    console.error('FAIL: Chatify workspace not found:', wsErr);
  } else {
    console.log(`PASS: Found Chatify workspace ${chatifyWs.id} (slug: ${chatifyWs.slug})`);
  }

  // 2. Check sections and articles for Chatify workspace
  console.log('\n2. Checking Chatify help center sections & articles:');
  const { data: sections, error: secErr } = await supabase
    .from('help_sections')
    .select('id, name, slug, order_index')
    .eq('workspace_id', chatifyWs?.id)
    .order('order_index');

  if (secErr || !sections) {
    console.error('FAIL: Could not fetch sections:', secErr);
  } else {
    console.log(`Found ${sections.length} total sections.`);
    for (const sec of sections) {
      const { data: arts } = await supabase
        .from('articles')
        .select('id, title, status')
        .eq('section_id', sec.id)
        .eq('status', 'published');

      const count = arts?.length || 0;
      console.log(`  - Section "${sec.name}" (slug: ${sec.slug}): ${count} published article(s)`);
      if (sec.slug === 'upcoming-features') {
        if (count === 0) {
          console.log('    PASS: upcoming-features has 0 published articles (will be hidden from visitor view)');
        } else {
          console.warn('    WARN: upcoming-features was expected to have 0 published articles');
        }
      }
    }
  }

  // 3. Verify clean URLs in seed workspace
  console.log('\n3. Checking seed workspace URLs cleanup:');
  const { data: seedWs } = await supabase
    .from('workspaces')
    .select('id, name, logo_url, website_url')
    .eq('id', 'a0000000-0000-0000-0000-000000000001')
    .single();

  if (seedWs) {
    console.log(`  Seed workspace ${seedWs.name}:`);
    console.log(`  logo_url: ${seedWs.logo_url}`);
    console.log(`  website_url: ${seedWs.website_url}`);
    const isCleanLogo = !seedWs.logo_url || !seedWs.logo_url.includes('chatify.dev');
    const isCleanWeb = !seedWs.website_url || !seedWs.website_url.includes('localhost');
    if (isCleanLogo && isCleanWeb) {
      console.log('  PASS: Seed workspace has clean URLs (no localhost or chatify.dev/logo.png)');
    } else {
      console.error('  FAIL: Seed workspace still has dirty URLs');
    }
  }

  // 4. Verify no other workspaces contain chatify.dev/logo.png or localhost
  console.log('\n4. Checking all workspaces for hardcoded URLs:');
  const { data: dirtyWorkspaces } = await supabase
    .from('workspaces')
    .select('id, name, logo_url, website_url')
    .or('logo_url.ilike.%chatify.dev/logo.png%,website_url.ilike.%localhost%');

  if (dirtyWorkspaces && dirtyWorkspaces.length > 0) {
    console.error(`FAIL: Found ${dirtyWorkspaces.length} dirty workspaces:`, dirtyWorkspaces);
  } else {
    console.log('PASS: 0 workspaces with hardcoded localhost or chatify.dev/logo.png');
  }

  // 5. Verify /terms and /privacy files exist
  console.log('\n5. Checking /terms and /privacy pages:');
  const termsExists = fs.existsSync(path.resolve('src/app/terms/page.tsx'));
  const privacyExists = fs.existsSync(path.resolve('src/app/privacy/page.tsx'));
  console.log(`  /terms exists: ${termsExists ? 'PASS' : 'FAIL'}`);
  console.log(`  /privacy exists: ${privacyExists ? 'PASS' : 'FAIL'}`);

  // 6. Verify 404 page exists
  console.log('\n6. Checking custom 404 page:');
  const notFoundExists = fs.existsSync(path.resolve('src/app/not-found.tsx'));
  console.log(`  /not-found.tsx exists: ${notFoundExists ? 'PASS' : 'FAIL'}`);
  if (notFoundExists) {
    const notFoundContent = fs.readFileSync(path.resolve('src/app/not-found.tsx'), 'utf8');
    const hasHome = notFoundContent.includes('href="/"');
    const hasLogin = notFoundContent.includes('href="/login"');
    const hasHelp = notFoundContent.includes('href="/help"');
    console.log(`  Links check - Home: ${hasHome}, Login: ${hasLogin}, Help: ${hasHelp}`);
    if (hasHome && hasLogin && hasHelp) {
      console.log('  PASS: 404 page contains required links');
    } else {
      console.error('  FAIL: 404 page is missing some required links');
    }
  }

  // 7. Verify LandingNav breakpoint and nowrap
  console.log('\n7. Checking LandingNav below-1024px collapse & nowrap:');
  const navContent = fs.readFileSync(path.resolve('src/components/marketing/LandingNav.tsx'), 'utf8');
  const hasLgFlex = navContent.includes('hidden lg:flex');
  const hasLgHidden = navContent.includes('lg:hidden');
  const hasNowrap = navContent.includes('whitespace-nowrap');
  console.log(`  hidden lg:flex: ${hasLgFlex}`);
  console.log(`  lg:hidden trigger: ${hasLgHidden}`);
  console.log(`  whitespace-nowrap: ${hasNowrap}`);
  if (hasLgFlex && hasLgHidden && hasNowrap) {
    console.log('  PASS: LandingNav collapses below 1024px and prevents text wrapping');
  } else {
    console.error('  FAIL: LandingNav breakpoint or wrapping check failed');
  }

  // 8. Verify HelpChrome logo fallback & footer padding
  console.log('\n8. Checking HelpChrome logo error handling & footer padding:');
  const chromeContent = fs.readFileSync(path.resolve('src/components/help/HelpChrome.tsx'), 'utf8');
  const hasOnError = chromeContent.includes('onError=') || chromeContent.includes('logoFailed');
  const hasFooterPadding = chromeContent.includes('pb-28') || chromeContent.includes('pb-24');
  console.log(`  Logo onError handler: ${hasOnError}`);
  console.log(`  Footer bottom padding (pb-28/24): ${hasFooterPadding}`);
  if (hasOnError && hasFooterPadding) {
    console.log('  PASS: HelpChrome properly handles broken logos and protects footer from chat widget');
  } else {
    console.error('  FAIL: HelpChrome missing onError or footer padding');
  }

  // 9. Verify Signup Page requirements
  console.log('\n9. Checking Signup page requirements:');
  const signupContent = fs.readFileSync(path.resolve('src/app/signup/page.tsx'), 'utf8');
  const hasCheckInbox = signupContent.includes('Check your inbox');
  const hasResend = signupContent.includes('handleResendEmail') || signupContent.includes('Resend email');
  const hasTermsCheckbox = signupContent.includes('agreedToTerms') && signupContent.includes('/terms') && signupContent.includes('/privacy');
  const hasPasswordRules = signupContent.includes('ruleLength') && signupContent.includes('ruleNumberOrSpecial') && signupContent.includes('ruleCase');
  console.log(`  "Check your inbox" screen: ${hasCheckInbox}`);
  console.log(`  Resend button: ${hasResend}`);
  console.log(`  Terms & Privacy checkbox: ${hasTermsCheckbox}`);
  console.log(`  Password rules under field: ${hasPasswordRules}`);
  if (hasCheckInbox && hasResend && hasTermsCheckbox && hasPasswordRules) {
    console.log('  PASS: Signup page meets all requirements');
  } else {
    console.error('  FAIL: Signup page missing requirements');
  }

  console.log('\n=== ALL VERIFICATION CHECKS COMPLETED ===');
}

runVerification().catch(console.error);
