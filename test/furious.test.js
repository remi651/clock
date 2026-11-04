import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request as httpRequest } from 'gaxios';
import { createFurious, exportDay } from '../lib/furious.js';
import { Store } from '../lib/store.js';
import { createApp } from '../server.js';
import { dayAt } from '../lib/time.js';

const user = { id: 'google-123', email: 'camille@studio-katra.com', name: 'Camille' };
const day = '2026-11-04';
const project = { id: '42', name: 'Identité du studio' };
const remoteProject = { id: 42, title: project.name, company_name: 'Katra', actif: '1', restricted_time_users: '' };
const remoteUser = { id: 17, pseudo: 'camille.katra', email: user.email };
const entry = { id: 'f704cd91-7b9e-4da4-bc6c-19d97555bf24', user_id: user.id, project_id: '42', project_name: project.name, day, seconds: 5400, note: 'Pistes créatives' };

function apiFixture(overrides = {}) {
  const calls = [];
  let writes = 0;
  const handler = async options => {
    calls.push(options);
    assert.equal(new URL(options.url).origin, 'https://studio-katra.furious-squad.com');
    assert.equal(options.retry, false);
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.timeout, 15000);
    const path = new URL(options.url).pathname.split('/').filter(Boolean).at(-1);
    const query = new URL(options.url).searchParams.get('query');
    const overridden = overrides[path];
    if (overridden) return { data: await overridden(options, query) };
    if (path === 'auth') {
      assert.deepEqual(options.data, { action: 'auth', data: { username: 'api-clock-test', password: 'fake-test-password' } });
      return { data: { success: true, token: 'fake-test-token', expires_in: 3600 } };
    }
    assert.equal(options.headers['F-Auth-Token'], 'fake-test-token');
    if (path === 'user') return { data: { success: true, data: { User: [remoteUser] } } };
    if (path === 'project') return { data: { success: true, data: { Project: [remoteProject] } } };
    if (path === 'user-daily-hours-history') return { data: { success: true, data: { UserDailyHoursHistory: [{ id: 2, user_id: 17, date: '2026-01-01', daily_hours: 7 }] } } };
    if (path === 'sprint' && options.method === 'GET') return { data: { success: true, data: { Sprint: [] } } };
    if (path === 'sprint' && options.method === 'POST') { writes++; return { data: { success: true, id: 9001 } }; }
    throw new Error(`Unexpected test request ${path}`);
  };
  const provider = createFurious({ username: 'api-clock-test', password: 'fake-test-password', transport: handler });
  return { provider, calls, handler, writes: () => writes };
}
function addEntry(store, seconds = 5400, date = day) {
  const start = Date.parse(`${date}T10:00:00Z`);
  store.start(user.id, project, 'Pistes créatives', start);
  store.stop(user.id, start + seconds * 1000);
  return store.entries(user.id, date)[0];
}
function remoteEntry(local = entry, changes = {}) {
  return { id: 9001, project_id: 42, assigned_people: remoteUser.pseudo,
    start_date: local.day, end_date: local.day, time_in_hours: String(local.seconds / 3600),
    description: `${local.note}\n[Clock:${local.id}]`, ...changes };
}

test('Contrat PDF : authentification, champs de recherche et conversion selon les heures du collaborateur', async () => {
  const { provider, calls, writes } = apiFixture();
  assert.equal(provider.ready, true);
  assert.deepEqual(await provider.projects(user), [{ id: '42', name: project.name, client: 'Katra', code: '#42' }]);
  const context = await provider.prepareExport(user, day);
  const result = await provider.exportEntry(user, entry, context);
  assert.deepEqual(result, { id: '9001' });
  assert.equal(writes(), 1);
  assert.equal(calls.filter(c => c.url.endsWith('/auth/')).length, 1);
  const queries = calls.map(c => new URL(c.url).searchParams.get('query')).filter(Boolean);
  assert.ok(queries.some(q => q.includes('email:{eq:"camille@studio-katra.com"}') && q.endsWith('{id,pseudo,email}}')));
  assert.ok(queries.some(q => q.includes('filter:{actif:{eq:"1"}}')));
  assert.ok(queries.some(q => q.includes('UserDailyHoursHistory') && q.includes('user_id:{eq:17},date:{leq:"2026-11-04"}') && q.includes('order:[{date:desc},{id:desc}]')));
  const write = calls.find(c => c.method === 'POST' && c.url.endsWith('/sprint/'));
  assert.deepEqual(write.data, { action: 'create', data: {
    sprint_name: `Temps Clock — ${project.name}`, project_id: 42, start_date: day, end_date: day,
    num_days: 5400 / (7 * 3600), assigned_people: 'camille.katra',
    description: `Pistes créatives\n[Clock:${entry.id}]`, is_validated: 0, priority: 2,
  } });
  assert.equal(write.headers['Idempotency-Key'], undefined, 'Aucun mécanisme d’idempotence non documenté');
});

test('Pagination complète ; projets inactifs et restrictions pour une autre personne exclus', async () => {
  const offsets = [];
  const { provider } = apiFixture({ project: async (_options, query) => {
    const offset = Number(query.match(/offset:(\d+)/)[1]); offsets.push(offset);
    const rows = Array.from({ length: offset ? 3 : 250 }, (_, i) => ({ ...remoteProject, id: offset + i + 1 }));
    if (offset) {
      rows[0].actif = '0';
      rows[1].restricted_time_users = 'quelquun, autre';
      rows[2].restricted_time_users = 'quelquun, camille.katra';
    }
    return { success: true, data: { Project: rows }, meta: { totalElementsWithFilters: 253 } };
  } });
  const projects = await provider.projects(user);
  assert.equal(projects.length, 251);
  assert.deepEqual(offsets, [0, 250]);
  assert.equal(projects.at(-1).id, '253');
});

test('Une pagination répétée ou tronquée ne présente pas une liste partielle', async () => {
  const repeated = apiFixture({ project: async () => ({ success: true, data: { Project: [remoteProject] }, meta: { totalElementsWithFilters: 2 } }) });
  await assert.rejects(() => repeated.provider.projects(user), /répété/);
  let count = 0;
  const truncated = apiFixture({ project: async () => ({ success: true, data: { Project: count++ ? [] : [remoteProject] }, meta: { totalElementsWithFilters: 2 } }) });
  await assert.rejects(() => truncated.provider.projects(user), /avant la fin/);
});

test('Aucun rattachement au compte API si l’email Google est absent ou ambigu dans Furious', async () => {
  for (const users of [[], [remoteUser, { ...remoteUser, id: 18 }], [{ ...remoteUser, email: 'other@studio-katra.com' }]]) {
    const { provider, writes, calls } = apiFixture({ user: async () => ({ success: true, data: { User: users } }) });
    await assert.rejects(() => provider.projects(user), /unique utilisateur/);
    assert.equal(writes(), 0);
    assert.ok(!calls.some(c => c.url.includes('/project/')));
  }
});

test('Historique journalier absent : aucun défaut de 7 ou 8 heures supposé ; secours explicite uniquement', async () => {
  const { provider, handler } = apiFixture({ 'user-daily-hours-history': async () => ({ success: true, data: { UserDailyHoursHistory: [] } }) });
  const store = new Store(':memory:');
  try {
    addEntry(store);
    await assert.rejects(() => exportDay(store, provider, user, day), /horaire journalier/);
    assert.equal(store.entries(user.id, day)[0].status, 'pending');
    const configured = createFurious({ username: 'api-clock-test', password: 'fake-test-password', hoursPerDay: '8', transport: handler });
    const context = await configured.prepareExport(user, day);
    assert.equal(context.hours, 8);
  } finally { store.close(); }
});

test('Auth partagée et renouvellement du jeton expiré, sans exposer les erreurs contenant des secrets', async () => {
  let now = 0;
  const { handler, calls } = apiFixture();
  const provider = createFurious({ username: 'api-clock-test', password: 'fake-test-password', transport: handler, now: () => now });
  await Promise.all([provider.projects(user), provider.projects(user), provider.projects(user)]);
  assert.equal(calls.filter(c => c.url.endsWith('/auth/')).length, 1);
  now = 3_600_000;
  await provider.projects(user);
  assert.equal(calls.filter(c => c.url.endsWith('/auth/')).length, 2);
  const broken = createFurious({ username: 'api-clock-test', password: 'fake-test-password', transport: async () => { throw new Error('fake-test-password fake-test-token'); } });
  await assert.rejects(() => broken.projects(user), error => !/fake-test/.test(error.message) && error.notWritten === true);
});

test('Un refus explicite reste modifiable ; un timeout ou un accusé incomplet reste à vérifier sans relance', async () => {
  for (const mode of ['refused', 'timeout', 'missing-id', 'bad-id']) {
    let posts = 0;
    const { provider } = apiFixture({ sprint: async options => {
      if (options.method === 'GET') return { success: true, data: { Sprint: [] } };
      posts++;
      if (mode === 'refused') return { success: false, message: 'Secret error body must not be propagated' };
      if (mode === 'timeout') throw new Error('Timeout');
      return { success: true, ...(mode === 'bad-id' ? { id: true } : {}) };
    } });
    const store = new Store(':memory:');
    try {
      addEntry(store);
      const result = await exportDay(store, provider, user, day);
      assert.equal(posts, 1);
      assert.equal(store.entries(user.id, day)[0].status, mode === 'refused' ? 'pending' : 'uncertain');
      assert.equal(result.uncertain, mode === 'refused' ? 0 : 1);
      assert.ok(!result.message.includes('Secret error body'));
      if (mode !== 'refused') {
        await exportDay(store, provider, user, day);
        assert.equal(posts, 1, 'Aucune relance automatique après une réponse ambiguë');
      }
    } finally { store.close(); }
  }
});

test('Référence existante : relecture et contrôle de la durée, de la personne et du projet avant tout renvoi', async () => {
  let returned = remoteEntry();
  const { provider, writes } = apiFixture({ sprint: async () => ({ success: true, data: { Sprint: [returned] } }) });
  const context = await provider.prepareExport(user, day);
  assert.deepEqual(await provider.exportEntry(user, entry, context), { id: '9001' });
  for (const changes of [{ project_id: 43 }, { assigned_people: 'autre' }, { time_in_hours: '2' }, { start_date: '2026-11-03' }, { description: 'wrong reference' }]) {
    returned = remoteEntry(entry, changes);
    await assert.rejects(() => provider.exportEntry(user, entry, context), /diffère/);
  }
  assert.equal(writes(), 0);
  await assert.rejects(() => provider.exportEntry({ ...user, id: 'other' }, entry, context), /ne correspond pas/);
});

test('Réconciliation HTTP : seule une saisie appartenant à la personne et confirmée dans Furious est marquée exportée', async t => {
  const store = new Store(':memory:');
  const local = addEntry(store, 5400, dayAt());
  store.exportResult(local.id, 'uncertain');
  let found = false, posts = 0;
  const { provider } = apiFixture({ sprint: async options => {
    if (options.method === 'POST') posts++;
    return { success: true, data: { Sprint: found ? [remoteEntry(local)] : [] } };
  } });
  const server = createApp({ store, provider }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = store.createSession(user), other = store.createSession({ ...user, id: 'other-user' });
  const headers = { Cookie: `katra_session=${session.id}`, Origin: 'http://localhost:3000', 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
  const path = `${base}/api/entries/${local.id}/reconcile`;
  assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, Cookie: `katra_session=${other.id}`, 'X-CSRF-Token': other.csrf }, body: '{}' })).status, 404);
  assert.equal((await fetch(path, { method: 'POST', headers, body: '{}' })).status, 409);
  assert.equal(store.entry(user.id, local.id).status, 'uncertain');
  found = true;
  assert.equal((await fetch(path, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(store.entry(user.id, local.id).status, 'exported');
  assert.equal(store.entry(user.id, local.id).export_id, '9001');
  assert.equal(posts, 0);
});

test('Transport HTTP : en-têtes, corps JSON et paramètres passent réellement par le client réseau', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v2/auth/') return res.end(JSON.stringify({ success: true, token: 'fake-test-token', expires_in: 3600 }));
    const model = req.url.startsWith('/api/v2/user/') ? 'User' : 'Project';
    res.end(JSON.stringify({ success: true, data: { [model]: model === 'User' ? [remoteUser] : [remoteProject] } }));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const provider = createFurious({ username: 'api-clock-test', password: 'fake-test-password', transport: options => {
    const url = new URL(options.url);
    return httpRequest({ ...options, url: `${base}${url.pathname}${url.search}` });
  } });
  assert.equal((await provider.projects(user))[0].id, '42');
  assert.equal(JSON.parse(requests[0].body).data.username, 'api-clock-test');
  assert.equal(requests[1].headers['f-auth-token'], 'fake-test-token');
  assert.ok(new URL(requests[1].path, base).searchParams.get('query').includes('User('));
});
