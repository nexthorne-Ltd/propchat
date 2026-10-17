// A tiny stand-in for Supabase (Auth + PostgREST) that serves fixture data,
// so the real app can be rendered for design screenshots without touching
// any real project. Only what the screens read is implemented: eq/in filters,
// single-object responses, exact counts. Writes are accepted and ignored.
//
//   node scripts/design/mock-supabase.mjs   (listens on 127.0.0.1:54321)
import http from 'node:http';

const WS = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const now = Date.now();
const ago = (min) => new Date(now - min * 60000).toISOString();

const user = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'maya@acme.test', user_metadata: { name: 'Maya Chen' }, app_metadata: {}, created_at: ago(90000) };

const agents = [
  { id: ME, workspace_id: WS, name: 'Maya Chen', email: 'maya@acme.test', role: 'owner', status: 'online', is_active: true, is_super_admin: false, avatar_url: null, created_at: ago(90000) },
  { id: 'a2', workspace_id: WS, name: 'Jonas Weber', email: 'jonas@acme.test', role: 'admin', status: 'away', is_active: true, avatar_url: null, created_at: ago(80000) },
  { id: 'a3', workspace_id: WS, name: 'Priya Nair', email: 'priya@acme.test', role: 'agent', status: 'online', is_active: true, avatar_url: null, max_open_tickets: 12, created_at: ago(70000) },
];

const workspace = {
  id: WS, name: 'Acme Inc', owner_id: ME, slug: 'acme', brand_color: '#2e5bff', logo_url: null,
  greeting_message: 'Hi there! How can we help?', widget_position: 'right', industry: 'saas',
  ai_settings: { enabled: true, provider: 'anthropic' }, business_hours: null, auto_assignment: {},
  help_center_title: 'Acme Help Center', help_center_description: 'Answers about billing, accounts and the Acme API.',
  is_suspended: false, deleted_at: null, created_at: ago(90000), plan: 'pro',
};

const names = [
  ['Lena Fischer', 'lena@northwind.test', 'Berlin, DE', 'I was charged twice for the October invoice'],
  ['Omar Haddad', 'omar@contoso.test', 'Dubai, AE', 'How do I export all conversations to CSV?'],
  ['Sofia Rossi', 'sofia@fabrikam.test', 'Milan, IT', 'The widget does not load on our checkout page'],
  ['Kenji Sato', 'kenji@tailspin.test', 'Tokyo, JP', 'Can we add a second workspace on the same plan?'],
  ['Ava Johnson', 'ava@litware.test', 'Austin, US', 'Thanks, that fixed it!'],
  ['Mateo García', 'mateo@adatum.test', 'Madrid, ES', 'SSO login loops back to the sign-in page'],
];
const visitors = names.map(([name, email, loc], i) => ({
  id: `v${i}`, workspace_id: WS, name, email, location: loc, ip_location_city: loc.split(',')[0], ip_location_country: loc.split(', ')[1],
  browser: 'Chrome', os: i % 2 ? 'macOS' : 'Windows', device: 'desktop', current_url: 'https://acme.test/pricing', current_page_url: 'https://acme.test/pricing',
  last_seen: ago(i * 3), last_seen_at: ago(i * 3), first_seen_at: ago(5000), is_online: i < 3, channel: 'web', timezone: 'Europe/Berlin', language: 'en',
}));
const statuses = ['open', 'open', 'open', 'pending', 'closed', 'open'];
const conversations = names.map(([, , , line], i) => ({
  id: `c${i}`, workspace_id: WS, visitor_id: `v${i}`, assigned_agent_id: i % 3 === 0 ? ME : i % 3 === 1 ? 'a3' : null,
  status: statuses[i], priority: i === 0 ? 'high' : 'normal', channel: 'web', ai_mode: 'copilot', tags: i === 0 ? ['Billing'] : i === 2 ? ['Bug'] : [],
  unread_count: i < 2 ? 2 - i : 0, last_message: line, last_message_at: ago(i * 7 + 1), updated_at: ago(i * 7 + 1), created_at: ago(i * 30 + 60),
  sentiment: i === 0 ? 'negative' : 'neutral', current_ticket_id: `t${i}`,
  visitor: visitors[i], agent: agents.find((a) => a.id === (i % 3 === 0 ? ME : i % 3 === 1 ? 'a3' : null)) || null,
}));
const messages = [
  { id: 'm1', conversation_id: 'c0', sender_type: 'visitor', sender_id: 'v0', content: 'Hi, I was charged twice for the October invoice. Can you check?', created_at: ago(30), is_internal: false, metadata: {} },
  { id: 'm2', conversation_id: 'c0', sender_type: 'ai', sender_id: null, content: 'Sorry about that, Lena. I can see two payments on 3 October. I have asked a teammate to refund the duplicate.', created_at: ago(29), is_internal: false, metadata: {} },
  { id: 'm3', conversation_id: 'c0', sender_type: 'agent', sender_id: 'a2', content: 'Refund issued in Stripe, 5–10 days to show.', created_at: ago(20), is_internal: true, metadata: {} },
  { id: 'm4', conversation_id: 'c0', sender_type: 'agent', sender_id: ME, content: 'Hi Lena, the duplicate charge is refunded. You will see it on your statement within 5–10 business days.', created_at: ago(18), is_internal: false, metadata: {}, read_at: ago(17) },
  { id: 'm5', conversation_id: 'c0', sender_type: 'visitor', sender_id: 'v0', content: 'Great, thank you for the quick help!', created_at: ago(2), is_internal: false, metadata: {} },
].map((m) => ({ ...m, agent: agents.find((a) => a.id === m.sender_id) || null }));
const tStatus = ['new', 'open', 'open', 'pending', 'solved', 'open'];
const tickets = names.map(([n, e, , line], i) => ({
  id: `t${i}`, workspace_id: WS, number: 1001 + i, subject: line, status: tStatus[i], priority: ['urgent', 'normal', 'high', 'low', 'normal', 'high'][i],
  type: ['incident', 'question', 'problem', 'question', 'task', 'incident'][i], channel: i === 3 ? 'email' : 'chat', tags: conversations[i].tags,
  assignee_id: conversations[i].assigned_agent_id, group_id: null, requester_id: `v${i}`, requester: { id: `v${i}`, name: n, email: e },
  conversation_id: `c${i}`, created_at: ago(i * 30 + 60), updated_at: ago(i * 7 + 1), solved_at: null, closed_at: null, follow_up_of_id: null, merged_into_id: null,
}));
const help_sections = [
  { id: 's1', workspace_id: WS, title: 'Getting started', slug: 'getting-started', description: 'Install the widget and invite your team.', icon: '🚀', order_index: 0 },
  { id: 's2', workspace_id: WS, title: 'Billing & plans', slug: 'billing', description: 'Invoices, refunds and changing plans.', icon: '💳', order_index: 1 },
  { id: 's3', workspace_id: WS, title: 'Integrations', slug: 'integrations', description: 'Slack, WhatsApp, Meta and the API.', icon: '🔌', order_index: 2 },
];
const articles = [
  ['Install the chat widget', 's1'], ['Invite teammates', 's1'], ['Request a refund', 's2'], ['Change your plan', 's2'], ['Connect Slack', 's3'], ['Use the REST API', 's3'],
].map(([title, section_id], i) => ({
  id: `ar${i}`, workspace_id: WS, section_id, title, slug: title.toLowerCase().replace(/\s+/g, '-'), status: i === 5 ? 'draft' : 'published',
  content: `## ${title}\n\nStep-by-step instructions for ${title.toLowerCase()}.`, excerpt: `How to ${title.toLowerCase()}.`, order_index: i,
  view_count: 120 - i * 13, helpful_count: 30 - i, not_helpful_count: i, created_at: ago(9000 - i * 100), updated_at: ago(600 - i * 40),
}));
const canned_responses = [
  { id: 'cr1', workspace_id: WS, shortcut: 'refund', title: 'Refund issued', content: 'Your refund is on its way.', agent_id: null },
];

const tables = { agents, workspaces: [workspace], public_workspaces: [workspace], visitors, conversations, messages, tickets, help_sections, articles, canned_responses };

function filterRows(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'or', 'and'].includes(k)) continue;
    const m = /^(eq|in|neq|is|not)\.(.*)$/.exec(v);
    if (!m) continue;
    if (m[1] === 'eq') out = out.filter((r) => !(k in r) || String(r[k]) === m[2]);
    if (m[1] === 'in') {
      const set = m[2].replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/"/g, ''));
      out = out.filter((r) => !(k in r) || set.includes(String(r[k])));
    }
  }
  return out;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,HEAD,OPTIONS,PUT',
  'Access-Control-Expose-Headers': 'Content-Range',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (process.env.MOCK_LOG) console.log(req.method, req.url);
  const send = (status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors, ...extra });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') return send(204);
  if (url.pathname.startsWith('/auth/v1/user')) return send(200, user);
  if (url.pathname.startsWith('/auth/v1/')) return send(200, {});
  if (url.pathname.startsWith('/rest/v1/rpc/')) return send(200, []);
  const table = url.pathname.replace('/rest/v1/', '');
  const rows = filterRows(tables[table] || [], url.searchParams);
  const range = (req.headers['range'] || '').split('-');
  const total = rows.length;
  if (req.method === 'HEAD') return send(200, undefined, { 'Content-Range': `*/${total}` });
  if (req.method !== 'GET') return send(201, []);
  let page = rows;
  const limit = Number(url.searchParams.get('limit'));
  const offset = Number(url.searchParams.get('offset') || 0);
  if (limit) page = rows.slice(offset, offset + limit);
  else if (range.length === 2 && range[1]) page = rows.slice(Number(range[0]), Number(range[1]) + 1);
  const headers = { 'Content-Range': `0-${Math.max(page.length - 1, 0)}/${total}` };
  if ((req.headers['accept'] || '').includes('vnd.pgrst.object')) {
    if (!page.length) return send(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows' });
    return send(200, page[0], headers);
  }
  send(200, page, headers);
}).listen(54321, '127.0.0.1', () => console.log('mock supabase on :54321'));

export { WS, ME, user };
