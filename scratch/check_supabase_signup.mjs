import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync(path.resolve('.env.local'), 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const [k, ...v] = line.split('=');
  if (k && v.length) env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
});

const anonClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const serviceClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  const email = `test_resend_${Date.now()}@gmail.com`;
  const { data: signUpData, error: signUpErr } = await anonClient.auth.signUp({
    email,
    password: 'Password123!@#',
    options: {
      data: { name: 'Resend Test' }
    }
  });

  console.log("SignUp:", { id: signUpData?.user?.id, error: signUpErr });

  const { data: resendData, error: resendErr } = await anonClient.auth.resend({
    type: 'signup',
    email
  });

  console.log("Resend response:", { resendData, resendErr });

  if (signUpData?.user?.id) {
    await serviceClient.auth.admin.deleteUser(signUpData.user.id);
  }
}

check();
