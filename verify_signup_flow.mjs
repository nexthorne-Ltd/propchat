import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

async function testSignupAndVerificationFlow() {
  console.log('=== TESTING INTERCOM SIGNUP & EMAIL VERIFICATION FLOW ===\n');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const timestamp = Date.now();
  const testEmail = `founder_${timestamp}@mybusiness.com`;
  const testPassword = 'SecurePassword2026!';
  const testName = 'Sarah Founder';

  // 1. Initiate Registration via RPC
  console.log('Step 1: Registering user and generating 6-digit code...');
  const { data: regData, error: regErr } = await supabase.rpc('fn_register_user', {
    p_email: testEmail,
    p_password: testPassword,
    p_name: testName,
  });

  if (regErr || !regData || !regData.success) {
    console.error('✗ Registration failed:', regErr || regData?.error);
    process.exit(1);
  }
  console.log(`✓ User created! 6-digit security code: ${regData.code}`);

  // 2. Test Invalid Code Rejection
  console.log('\nStep 2: Testing invalid code rejection...');
  const { data: invalidRes } = await supabase.rpc('fn_verify_email_code', {
    p_email: testEmail,
    p_code: '000000',
  });
  if (invalidRes && invalidRes.success === false) {
    console.log('✓ Invalid code correctly rejected:', invalidRes.error);
  } else {
    console.error('✗ Invalid code was not rejected!');
    process.exit(1);
  }

  // 3. Test Valid Code Verification
  console.log('\nStep 3: Testing valid code verification...');
  const { data: validRes, error: validErr } = await supabase.rpc('fn_verify_email_code', {
    p_email: testEmail,
    p_code: regData.code,
  });

  if (validErr || !validRes || !validRes.success) {
    console.error('✗ Valid code verification failed:', validErr || validRes);
    process.exit(1);
  }
  console.log('✓ Verification code accepted! User email marked confirmed in auth.users.');

  // 4. Test Authentication with Verified User
  console.log('\nStep 4: Testing authentication with verified account...');
  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });

  if (authErr) {
    console.error('✗ Authentication failed:', authErr.message);
    process.exit(1);
  }
  console.log(`✓ Successfully authenticated verified user: ${authData.user.email} (ID: ${authData.user.id})`);

  console.log('\n=== ALL EMAIL VERIFICATION TESTS PASSED PERFECTLY! ===');
}

testSignupAndVerificationFlow().catch(console.error);
