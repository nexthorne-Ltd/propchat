import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vfjsaynnubxywdbevxtx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

async function testVercelAdmin() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log('1. Signing in as agent@chatify.io...');
  const { data: auth, error } = await supabase.auth.signInWithPassword({
    email: 'agent@chatify.io',
    password: 'ChatifyDemo2026!',
  });

  if (error || !auth.session) {
    console.error('Sign in failed:', error);
    return;
  }

  console.log('Signed in successfully. Token:', auth.session.access_token.slice(0, 20) + '...');

  // Supabase SSR auth cookies format:
  // sb-<project-ref>-auth-token
  const cookieName = `sb-vfjsaynnubxywdbevxtx-auth-token`;
  const sessionData = [
    auth.session.access_token,
    auth.session.refresh_token,
    null,
    null,
    null
  ];
  // In modern supabase/ssr:
  const cookieValue = encodeURIComponent(JSON.stringify(sessionData));
  // Or base64:
  const b64 = Buffer.from(JSON.stringify(sessionData)).toString('base64');

  console.log('2. Requesting https://chat-system-wabd.vercel.app/admin with cookies...');
  
  // Try with cookie
  const res = await fetch('https://chat-system-wabd.vercel.app/admin', {
    headers: {
      'Cookie': `${cookieName}=base64-${b64}; ${cookieName}.0=base64-${b64}`
    }
  });

  console.log('HTTP Status:', res.status);
  const text = await res.text();
  console.log('Response body preview:', text.slice(0, 300));
}

testVercelAdmin();
