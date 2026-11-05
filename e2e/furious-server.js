// Local test fixture only. Never imported by the application startup command.
import { createServer } from 'node:http';
import { createApp } from '../server.js';
import { Store } from '../lib/store.js';
import { createFurious } from '../lib/furious.js';

const store = new Store(':memory:');
const remoteEntries = [], interrupted = new Set();
const projects = [
  { id: 42, title: 'Identité du studio', company_name: 'Studio Katra', actif: '1', restricted_time_users: '' },
  { id: 43, title: 'Site du studio', company_name: 'Studio Katra', actif: '1', restricted_time_users: '' },
];
const provider = createFurious({ username: 'e2e-test-account', password: 'fake-password', transport: async options => {
  const url = new URL(options.url), query = url.searchParams.get('query') || '';
  let body;
  if (url.pathname.endsWith('/auth/')) body = { success: true, token: 'fake-token', expires_in: 3600 };
  else if (url.pathname.endsWith('/user/')) {
    const email = JSON.parse(query.match(/email:\{eq:("[^"]*")\}/)[1]);
    body = { success: true, data: { User: [{ id: email.startsWith('desktop') ? 17 : 18, pseudo: email.split('@')[0], email }] } };
  } else if (url.pathname.endsWith('/project/')) body = { success: true, data: { Project: projects } };
  else if (url.pathname.endsWith('/proposal/')) body = { success: true, data: { Proposal: [{ id: 42, title: 'Étude du futur site', company_name: 'Studio Katra', statut: 'Pipe sûr', project_id: 0 }, { id: 44, title: 'Devis perdu', company_name: 'Studio Katra', statut: 'Perdu', project_id: 0 }] } };
  else if (url.pathname.endsWith('/project-rate-card/')) {
    const projectId = Number(query.match(/project_id:\{eq:"(\d+)"\}/)[1]);
    body = { success: true, data: { ProjectRateCard: [{ id: projectId * 100 + 1, project_id: projectId, rate_card_row_label: 'Direction artistique', exclude_from_sprint: 0 }] } };
  }
  else if (url.pathname.endsWith('/user-daily-hours-history/')) {
    const userId = Number(query.match(/user_id:\{eq:"(\d+)"\}/)[1]);
    body = { success: true, data: { UserDailyHoursHistory: [{ id: 1, user_id: userId, date: '2020-01-01', daily_hours: 7 }] } };
  } else if (options.method === 'GET' && url.pathname.endsWith('/sprint/')) {
    const marker = JSON.parse(query.match(/description:\{like:("[^"]*")\}/)[1]);
    body = { success: true, data: { Sprint: remoteEntries.filter(row => row.description.includes(marker)) } };
  } else if (options.method === 'POST' && url.pathname.endsWith('/sprint/')) {
    const data = options.data.data;
    if (data.proposal_id ? data.proposal_id !== 42 || data.project_id !== 0 : data.project_rate_card_id !== data.project_id * 100 + 1 && data.project_rate_card_id !== -1) return { data: { success: false, message: { project_rate_card_id: 'required' } } };
    const row = { ...data, id: 100 + remoteEntries.length, time_in_hours: String(data.num_days * 7) };
    remoteEntries.push(row);
    if (!interrupted.has(data.assigned_people)) {
      interrupted.add(data.assigned_people);
      throw new Error('Simulated timeout after remote commit');
    }
    body = { success: true, id: row.id };
  } else throw new Error('Unexpected API request in browser test');
  return { data: body };
} });
const app = createApp({ store, provider, appUrl: 'http://127.0.0.1:3108' });
createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:3108');
  if (req.method === 'POST' && url.pathname === '/__test/login') {
    const id = url.searchParams.get('id');
    if (!['desktop', 'mobile', 'switch-desktop', 'switch-mobile', 'quote-desktop', 'quote-mobile'].includes(id)) { res.writeHead(400); res.end(); return; }
    const session = store.createSession({ id, email: `${id}@studio-katra.com`, name: 'Camille Test' });
    res.setHeader('Set-Cookie', `katra_session=${session.id}; HttpOnly; SameSite=Lax; Path=/`);
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  } else if (url.pathname === '/__test/writes') {
    const session = store.session((req.headers.cookie || '').match(/katra_session=([^;]+)/)?.[1]);
    res.setHeader('Content-Type', 'application/json');
    const rows = remoteEntries.filter(e => e.assigned_people === session?.user.id);
    res.end(JSON.stringify({ count: rows.length, targets: rows.map(e => ({ project_id: e.project_id, proposal_id: e.proposal_id ?? null })) }));
  } else app(req, res);
}).listen(3108, '127.0.0.1');
