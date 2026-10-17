// Captures the main screens against the mock Supabase server.
//   node scripts/design/screenshots.mjs <outDir>
// Expects `next dev` (or start) on :3000 built with
// NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321.
import { chromium } from 'playwright';
import fs from 'node:fs';

const out = process.argv[2] || 'screens';
fs.mkdirSync(out, { recursive: true });
const BASE = 'http://localhost:3000';
const WS = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 86400 * 30;
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ME, role: 'authenticated', exp, aud: 'authenticated' })}.sig`;
const session = {
  access_token: jwt, refresh_token: 'r', token_type: 'bearer', expires_in: 86400 * 30, expires_at: exp,
  user: { id: ME, aud: 'authenticated', role: 'authenticated', email: 'maya@acme.test', user_metadata: { name: 'Maya Chen' }, app_metadata: {} },
};
const cookie = { name: 'sb-127-auth-token', value: `base64-${b64(session)}`, domain: 'localhost', path: '/' };

const shots = [
  { name: 'login', path: '/login' },
  { name: 'signup', path: '/signup' },
  { name: 'inbox', path: '/dashboard', auth: true, wait: 4000, act: async (p) => { await p.getByText('Lena Fischer').first().click().catch(() => {}); await p.waitForTimeout(1500); } },
  { name: 'tickets', path: '/dashboard', auth: true, wait: 4000, act: async (p) => { await p.getByRole('button', { name: /^Tickets$/ }).first().click().catch(() => {}); await p.waitForTimeout(2500); } },
  { name: 'helpdesk', path: '/dashboard', auth: true, wait: 4000, act: async (p) => { await p.getByRole('button', { name: /Help ?Desk/i }).first().click().catch(() => {}); await p.waitForTimeout(2500); } },
  { name: 'settings', path: '/dashboard', auth: true, wait: 4000, act: async (p) => { await p.getByRole('button', { name: /^Settings$/ }).first().click().catch(() => {}); await p.waitForTimeout(2500); } },
  { name: 'palette', path: '/dashboard', auth: true, wait: 4000, act: async (p) => { await p.keyboard.press('Control+k'); await p.waitForTimeout(800); await p.keyboard.type('set'); } },
  { name: 'help-center', url: 'http://acme.localhost:3000/', wait: 3000 },
  { name: 'widget', path: `/widget?workspaceId=${WS}`, wait: 2500, act: async (p) => { await p.locator('button').last().click().catch(() => {}); await p.waitForTimeout(1200); } },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-proxy-server'] });
for (const theme of ['light', 'dark']) {
  for (const vp of [{ tag: 'desktop', width: 1440, height: 900 }, { tag: 'mobile', width: 390, height: 844 }]) {
    if (vp.tag === 'mobile' && theme === 'dark') continue;
    const ctx = await browser.newContext({ viewport: vp, colorScheme: theme, deviceScaleFactor: 1 });
    await ctx.addCookies([cookie]);
    await ctx.addInitScript((t) => { try { localStorage.setItem('theme', t); localStorage.setItem('zentry-theme', t); } catch {} }, theme);
    for (const s of shots) {
      if (vp.tag === 'mobile' && !['login', 'inbox', 'tickets', 'help-center'].includes(s.name)) continue;
      if (theme === 'dark' && !['login', 'inbox', 'tickets', 'palette', 'settings'].includes(s.name)) continue;
      const page = await ctx.newPage();
      try {
        await page.goto(s.url || BASE + s.path, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForTimeout(s.wait || 2000);
        if (s.act) await s.act(page);
        // Headless Chromium can leave compositor animations on their first frame.
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; } *, *::before, *::after { animation: none !important; }' }).catch(() => {});
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${out}/${s.name}-${vp.tag}-${theme}.png` });
        console.log('ok', s.name, vp.tag, theme);
      } catch (e) {
        console.log('fail', s.name, e.message.split('\n')[0]);
      }
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
