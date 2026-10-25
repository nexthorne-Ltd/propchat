// Runs the mock Supabase and `next dev` on :3001 pointed at it, so screens can
// be checked in the browser without touching a real project or .env.local.
// The mock values are set on this process only; Next gives process env
// precedence over .env.local.
//
//   node scripts/design/dev-with-mock.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run from the checkout this script lives in, whatever the caller's cwd.
process.chdir(fileURLToPath(new URL('../..', import.meta.url)));

const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'mock',
  SUPABASE_SERVICE_ROLE_KEY: 'mock',
  HELP_BASE_DOMAIN: 'localhost',
  NEXT_PUBLIC_HELP_BASE_DOMAIN: 'localhost',
};

const children = [
  spawn(process.execPath, ['scripts/design/mock-supabase.mjs'], { stdio: 'inherit', env }),
  spawn('npx', ['next', 'dev', '-p', '3001'], { stdio: 'inherit', env, shell: true }),
];

const stop = () => children.forEach((c) => c.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children.forEach((c) => c.on('exit', (code) => { if (code) { console.error('[dev-with-mock] child exited', code); stop(); process.exit(code); } }));
